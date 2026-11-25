import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  Sparkles,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Save,
  Pencil,
} from 'lucide-react';
import { BookRecord } from '../types';
import { useToast } from '../context/ToastContext';
import { checkDuplicateBook, stringSimilarity } from '../utils/fuzzyMatcher';
import { enrichBook } from '../utils/geminiService';
import { BookCover } from './BookCover';
import { findBookCoverCandidatesFull } from '../services/bookCoverService';

interface AddEditBookModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (book: BookRecord) => Promise<void>;
  initialBook?: BookRecord | null;
  categories: string[];
  books?: BookRecord[];
}

export const AddEditBookModal: React.FC<AddEditBookModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialBook,
  categories,
  books = [],
}) => {
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [category, setCategory] = useState('Văn học');
  const [publisher, setPublisher] = useState('');
  const [summary, setSummary] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [isAiNormalized, setIsAiNormalized] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [isSearchingCovers, setIsSearchingCovers] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);

  const duplicateMatch = useMemo(() => {
    if (!isEditMode || !title.trim() || !books || books.length === 0) return null;
    const existingOther = initialBook
      ? books.filter((b) => b.id !== initialBook.id)
      : books;
    const result = checkDuplicateBook({ title }, existingOther);
    if (!result.isDuplicate || !result.matchedBook) return null;

    if (author.trim() && result.matchedBook.author) {
      const authorSim = stringSimilarity(author, result.matchedBook.author);
      if (authorSim < 0.6) {
        return null;
      }
    }

    return result;
  }, [isEditMode, title, author, books, initialBook]);

  useEffect(() => {
    if (initialBook) {
      setTitle(initialBook.title || '');
      setAuthor(initialBook.author || '');
      setCategory(initialBook.category || 'Văn học');
      setPublisher(initialBook.publisher || '');
      setSummary(initialBook.summary || '');
      setCoverUrl(initialBook.cover_url || '');
      setIsAiNormalized(Boolean(initialBook.is_ai_normalized));
      setIsEditMode(false);
    } else {
      setTitle('');
      setAuthor('');
      setCategory('Văn học');
      setPublisher('');
      setSummary('');
      setCoverUrl('');
      setIsAiNormalized(false);
      setIsEditMode(true);
    }
  }, [initialBook, isOpen]);

  const hasUnsavedChanges = useMemo(() => {
    if (!initialBook) return true;
    return (
      title.trim() !== (initialBook.title || '').trim() ||
      author.trim() !== (initialBook.author || '').trim() ||
      category.trim() !== (initialBook.category || 'Văn học').trim() ||
      publisher.trim() !== (initialBook.publisher || '').trim() ||
      summary.trim() !== (initialBook.summary || '').trim() ||
      coverUrl.trim() !== (initialBook.cover_url || '').trim() ||
      isAiNormalized !== Boolean(initialBook.is_ai_normalized)
    );
  }, [initialBook, title, author, category, publisher, summary, coverUrl, isAiNormalized]);

  const summaryWordCount = useMemo(() => {
    const clean = summary.trim();
    return clean ? clean.split(/\s+/).length : 0;
  }, [summary]);

  if (!isOpen) return null;

  const handleRefreshCover = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      showToast('Vui lòng nhập tên sách để tìm ảnh bìa!', 'warning');
      return;
    }

    setIsSearchingCovers(true);
    try {
      const candidates = await findBookCoverCandidatesFull(
        cleanTitle,
        author.trim(),
        publisher.trim()
      );
      if (candidates.length > 0) {
        let nextIdx = 0;
        if (coverUrl && coverUrl !== 'NONE') {
          const curIdx = candidates.findIndex((c) => c.coverUrl === coverUrl);
          if (curIdx >= 0 && curIdx + 1 < candidates.length) {
            nextIdx = curIdx + 1;
          }
        }
        setCoverUrl(candidates[nextIdx].coverUrl);
        showToast(`Đã cập nhật ảnh bìa (${nextIdx + 1}/${candidates.length})`, 'success');
      } else {
        setCoverUrl('NONE');
        showToast('Không tìm thấy ảnh bìa trực tuyến cho cuốn này.', 'info');
      }
    } catch {
      showToast('Chưa thể tìm ảnh bìa lúc này.', 'warning');
    } finally {
      setIsSearchingCovers(false);
    }
  };

  const handleEnrichFullBookAI = async () => {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      showToast('Vui lòng nhập tên sách để hiệu chỉnh AI!', 'warning');
      return;
    }

    setIsEnriching(true);
    try {
      const coverPromise = findBookCoverCandidatesFull(
        cleanTitle,
        author.trim(),
        publisher.trim()
      ).catch(() => []);

      const [data, covers] = await Promise.all([
        enrichBook(cleanTitle, author.trim(), publisher.trim(), categories),
        coverPromise,
      ]);

      const enriched = data?.enriched;
      if (enriched) {
        if (enriched.title) setTitle(enriched.title);
        if (enriched.author) setAuthor(enriched.author);
        if (enriched.category) setCategory(enriched.category);
        if (enriched.publisher) setPublisher(enriched.publisher);
        if (enriched.summary) setSummary(enriched.summary);
      }

      if (covers.length > 0) {
        setCoverUrl(covers[0].coverUrl);
      } else if (!coverUrl || coverUrl === 'NONE') {
        if (enriched?.cover_url) {
          setCoverUrl(enriched.cover_url);
        } else {
          setCoverUrl('NONE');
        }
      }

      setIsAiNormalized(true);
      showToast('AI đã hiệu chỉnh thông tin & tóm tắt sách!', 'success');
    } catch (err: any) {
      console.warn('Lỗi hiệu chỉnh AI 1 cuốn:', err);
      showToast('Chưa thể hiệu chỉnh tự động lúc này.', 'warning');
    } finally {
      setIsEnriching(false);
    }
  };

  const handlePersistBook = async () => {
    if (!title.trim()) {
      showToast('Vui lòng nhập Tên sách!', 'warning');
      return;
    }

    setIsSaving(true);
    try {
      const now = Date.now();
      const cleanCover = coverUrl.trim();
      const cleanSummary = summary.trim();
      const bookToSave: BookRecord = {
        id: initialBook?.id || `book_${now}_${Math.random().toString(36).substring(2, 8)}`,
        title: title.trim(),
        author: author.trim() || 'Chưa rõ',
        category: category.trim() || 'Chung',
        publisher: publisher.trim(),
        ...(cleanSummary ? { summary: cleanSummary } : {}),
        ...(cleanCover ? { cover_url: cleanCover } : {}),
        is_ai_normalized: isAiNormalized || Boolean(initialBook?.is_ai_normalized),
        created_at: initialBook?.created_at || now,
        updated_at: now,
      };

      await onSave(bookToSave);
      onClose();
    } catch (err: any) {
      showToast(`Lỗi khi lưu sách: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await handlePersistBook();
  };

  const handleCancelEdit = () => {
    if (initialBook) {
      setTitle(initialBook.title || '');
      setAuthor(initialBook.author || '');
      setCategory(initialBook.category || 'Văn học');
      setPublisher(initialBook.publisher || '');
      setSummary(initialBook.summary || '');
      setCoverUrl(initialBook.cover_url || '');
      setIsAiNormalized(Boolean(initialBook.is_ai_normalized));
      setIsEditMode(false);
    } else {
      onClose();
    }
  };

  const cleanAuthorDisplay =
    author.trim() && author.trim().toLowerCase() !== 'chưa rõ' ? author.trim() : '';
  const cleanCategoryDisplay = category.trim() || 'Chung';
  const cleanPublisherDisplay = publisher.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl max-w-lg w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 sm:px-5 py-3 bg-[#0284C7] text-white flex items-center justify-between gap-2 shrink-0">
          <h3 className="text-sm sm:text-base font-extrabold text-white leading-tight truncate min-w-0">
            {!initialBook
              ? 'Thêm sách mới'
              : isEditMode
              ? 'Chỉnh sửa thông tin'
              : 'Giới thiệu sách'}
          </h3>

          <div className="flex items-center gap-2 shrink-0">
            {initialBook && (
              <button
                type="button"
                onClick={() => setIsEditMode((prev) => !prev)}
                title={isEditMode ? 'Xem trang giới thiệu' : 'Chỉnh sửa thông tin'}
                aria-label={isEditMode ? 'Xem trang giới thiệu' : 'Chỉnh sửa thông tin'}
                className={`w-8 h-8 rounded-xl inline-flex items-center justify-center transition active:scale-95 cursor-pointer ${
                  isEditMode
                    ? 'bg-white text-[#0284C7] shadow-xs'
                    : 'bg-white/15 hover:bg-white/25 text-white'
                }`}
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}

            <button
              type="button"
              onClick={handleEnrichFullBookAI}
              disabled={isEnriching || !title.trim()}
              title="AI hiệu chỉnh toàn bộ thông tin & tóm tắt sách"
              aria-label="AI hiệu chỉnh sách"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 active:scale-95 text-[#059669] border border-emerald-300/90 text-[11px] font-extrabold shadow-2xs transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isEnriching ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#059669]" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>AI</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-full inline-flex items-center justify-center text-sky-100 hover:text-white hover:bg-sky-600/70 transition cursor-pointer"
              aria-label="Đóng"
            >
              <X className="w-4.5 h-4.5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        {isEditMode ? (
          <form onSubmit={handleSubmit} className="p-4 sm:p-5 overflow-y-auto space-y-3.5 flex-1">
            {/* Edit Mode: Form boxes revealed only when editing or creating */}
            <div className="flex items-start gap-3.5">
              <div className="relative group shrink-0">
                <div className="w-24 h-36 sm:w-28 sm:h-40 rounded-xl overflow-hidden shadow-md ring-1 ring-slate-900/10 bg-white">
                  <BookCover
                    coverUrl={coverUrl}
                    title={title || 'Sách'}
                    author={author}
                    category={category}
                    size="grid"
                    className="w-full h-full"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleRefreshCover}
                  disabled={isSearchingCovers || !title.trim()}
                  title="Tìm ảnh bìa mới hoặc đổi ảnh bìa trực tuyến"
                  className="absolute bottom-1.5 right-1.5 w-8 h-8 rounded-full bg-slate-900/85 hover:bg-slate-900 text-white flex items-center justify-center shadow-md active:scale-90 transition cursor-pointer disabled:opacity-40"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${isSearchingCovers ? 'animate-spin text-emerald-400' : 'text-white'}`}
                  />
                </button>
              </div>

              <div className="min-w-0 flex-1 space-y-2.5">
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Tên sách *"
                  className="w-full px-3 py-2 text-xs sm:text-sm font-bold bg-slate-50 focus:bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#0284C7]/20 focus:border-[#0284C7] focus:outline-none transition"
                />

                <input
                  type="text"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="Tác giả"
                  className="w-full px-3 py-2 text-xs font-semibold bg-slate-50 focus:bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#0284C7]/20 focus:border-[#0284C7] focus:outline-none transition"
                />

                <input
                  type="text"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="Thể loại"
                  list="category-suggestions"
                  className="w-full px-3 py-2 text-xs font-semibold bg-slate-50 focus:bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#0284C7]/20 focus:border-[#0284C7] focus:outline-none transition"
                />
                <datalist id="category-suggestions">
                  {categories.map((cat) => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>

                <input
                  type="text"
                  value={publisher}
                  onChange={(e) => setPublisher(e.target.value)}
                  placeholder="Nhà xuất bản"
                  className="w-full px-3 py-2 text-xs font-semibold bg-slate-50 focus:bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#0284C7]/20 focus:border-[#0284C7] focus:outline-none transition"
                />
              </div>
            </div>

            <input
              type="text"
              value={coverUrl}
              onChange={(e) => setCoverUrl(e.target.value)}
              placeholder="URL ảnh bìa sách (https://...)"
              className="w-full px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50 focus:bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#0284C7]/20 focus:border-[#0284C7] focus:outline-none transition"
            />

            {duplicateMatch && duplicateMatch.matchedBook && (
              <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2 text-xs text-amber-900 animate-in fade-in">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <span className="truncate">
                  Đã có trong kho: <strong>"{duplicateMatch.matchedBook.title}"</strong> ({duplicateMatch.score}%)
                </span>
              </div>
            )}

            <div className="space-y-1">
              <textarea
                rows={6}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Nhập nội dung giới thiệu cuốn sách cho bạn đọc (tối đa 100 từ hoặc bấm nút AI ở trên)..."
                className="w-full px-3.5 py-2.5 text-xs sm:text-sm font-normal bg-slate-50 border border-slate-200 rounded-2xl focus:bg-white focus:ring-2 focus:ring-[#0284C7]/20 focus:border-[#0284C7] focus:outline-none transition resize-y leading-relaxed"
              />
              {summaryWordCount > 0 && (
                <div
                  className={`text-[11px] text-right font-medium ${
                    summaryWordCount > 100 ? 'text-rose-600 font-bold' : 'text-slate-400'
                  }`}
                >
                  {summaryWordCount}/100 từ{summaryWordCount > 100 ? ' (vượt quá 100 từ)' : ''}
                </div>
              )}
            </div>

            <div className="pt-2.5 flex items-center justify-end gap-2.5 border-t border-slate-100 shrink-0">
              <button
                type="button"
                onClick={handleCancelEdit}
                disabled={isSaving}
                className="px-4 py-2 text-xs sm:text-sm font-bold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition cursor-pointer"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-5 py-2 text-xs sm:text-sm font-bold text-white bg-[#EA580C] hover:bg-[#c2410c] active:scale-95 rounded-xl shadow-xs transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang lưu...</span>
                  </>
                ) : (
                  <>
                    <Save className="w-3.5 h-3.5" />
                    <span>{initialBook ? 'Lưu thay đổi' : 'Thêm sách'}</span>
                  </>
                )}
              </button>
            </div>
          </form>
        ) : (
          /* View Mode: Editorial Book Introduction Page (cover left, info right, summary below) */
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="px-4 sm:px-6 py-5 sm:py-6 overflow-y-auto flex-1 space-y-5">
              {/* Hero Book Showcase: Cover Left + Info Right */}
              <div className="flex flex-row items-start gap-4 sm:gap-6">
                <div className="w-[44%] max-w-[176px] sm:w-44 aspect-[3/4] shrink-0 rounded-xl overflow-hidden shadow-[0_16px_34px_-10px_rgba(15,23,42,0.34)] ring-1 ring-slate-900/10 bg-white">
                  <BookCover
                    coverUrl={coverUrl}
                    title={title || 'Sách'}
                    author={author}
                    category={category}
                    size="grid"
                    className="w-full h-full"
                  />
                </div>

                <div className="min-w-0 flex-1 text-left pt-0.5 space-y-2.5">
                  <h2 className="text-lg sm:text-2xl font-extrabold text-slate-900 leading-snug tracking-tight break-words">
                    {title}
                  </h2>

                  {cleanAuthorDisplay && (
                    <p className="text-sm sm:text-base font-semibold text-slate-700 leading-snug break-words">
                      {cleanAuthorDisplay}
                    </p>
                  )}

                  <div className="pt-0.5 space-y-1 text-xs sm:text-[13px] font-medium text-slate-500 leading-relaxed">
                    <div className="break-words">{cleanCategoryDisplay}</div>
                    {cleanPublisherDisplay && (
                      <div className="break-words text-slate-400">{cleanPublisherDisplay}</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-100" />

              {/* Unboxed Editorial Book Summary */}
              <div>
                {summary.trim() ? (
                  <p className="text-[14.5px] sm:text-[15px] leading-[1.75] text-slate-700 whitespace-pre-line text-left">
                    {summary.trim()}
                  </p>
                ) : (
                  <p className="py-2 text-sm text-slate-400 italic text-left">
                    Cuốn sách này chưa có lời giới thiệu nội dung.
                  </p>
                )}
              </div>
            </div>

            {/* Clean Footer */}
            {hasUnsavedChanges ? (
              <div className="px-5 py-3 bg-slate-50/70 border-t border-slate-100 flex items-center justify-end gap-2.5 shrink-0">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSaving}
                  className="px-4 py-2 text-xs sm:text-sm font-bold text-slate-600 hover:text-slate-800 hover:bg-slate-200/60 rounded-xl transition cursor-pointer"
                >
                  Đóng
                </button>
                <button
                  type="button"
                  onClick={handlePersistBook}
                  disabled={isSaving}
                  className="px-5 py-2 text-xs sm:text-sm font-bold text-white bg-[#EA580C] hover:bg-[#c2410c] active:scale-95 rounded-xl shadow-xs transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Đang lưu...</span>
                    </>
                  ) : (
                    <>
                      <Save className="w-3.5 h-3.5" />
                      <span>Lưu thay đổi</span>
                    </>
                  )}
                </button>
              </div>
            ) : (
              <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-end shrink-0">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-5 py-2 text-xs sm:text-sm font-bold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition cursor-pointer"
                >
                  Đóng
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
