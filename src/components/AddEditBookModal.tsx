import React, { useState, useEffect, useMemo } from 'react';
import { X, Book, Tag, Sparkles, Loader2, AlertTriangle } from 'lucide-react';
import { BookRecord } from '../types';
import { useToast } from '../context/ToastContext';
import { checkDuplicateBook, stringSimilarity } from '../utils/fuzzyMatcher';
import { enrichBook } from '../utils/geminiService';

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
  const [isSaving, setIsSaving] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);

  const duplicateMatch = useMemo(() => {
    if (!title.trim() || !books || books.length === 0) return null;
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
  }, [title, author, books, initialBook]);

  useEffect(() => {
    if (initialBook) {
      setTitle(initialBook.title || '');
      setAuthor(initialBook.author || '');
      setCategory(initialBook.category || 'Văn học');
      setPublisher(initialBook.publisher || '');
    } else {
      setTitle('');
      setAuthor('');
      setCategory('Văn học');
      setPublisher('');
    }
  }, [initialBook, isOpen]);

  if (!isOpen) return null;

  const handleEnrichWithAI = async () => {
    if (!title.trim()) {
      showToast('Vui lòng nhập tên sách!', 'warning');
      return;
    }

    setIsEnriching(true);
    try {
      const data = await enrichBook(title.trim(), author.trim(), publisher.trim());
      const enriched = data?.enriched;

      if (enriched) {
        if (enriched.title) setTitle(enriched.title);
        if (enriched.author) setAuthor(enriched.author);
        if (enriched.category) setCategory(enriched.category);
        if (enriched.publisher) setPublisher(enriched.publisher);
        showToast('Đã điền thông tin AI!', 'success');
      } else {
        showToast('Không tìm thấy thông tin phù hợp lúc này.', 'info');
      }
    } catch (err: any) {
      console.warn('Lỗi tra cứu AI ngầm:', err);
      showToast('Chưa thể tra cứu tự động lúc này.', 'info');
    } finally {
      setIsEnriching(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      showToast('Vui lòng nhập Tên sách!', 'warning');
      return;
    }

    setIsSaving(true);
    try {
      const now = Date.now();
      const bookToSave: BookRecord = {
        id: initialBook?.id || `book_${now}_${Math.random().toString(36).substring(2, 8)}`,
        title: title.trim(),
        author: author.trim() || 'Khuyết danh',
        category: category.trim() || 'Chung',
        publisher: publisher.trim(),
        created_at: initialBook?.created_at || now,
        updated_at: now,
      };

      await onSave(bookToSave);
      showToast(initialBook ? 'Đã lưu thay đổi!' : 'Đã thêm sách!', 'success');
      onClose();
    } catch (err: any) {
      showToast(`Lỗi khi lưu sách: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-lg w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header - Brand Ocean Blue (#0284C7) */}
        <div className="px-5 py-3.5 bg-[#0284C7] text-white border-b border-sky-700 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-400/20 text-emerald-300 border border-emerald-400/30 flex items-center justify-center">
              <Book className="w-4.5 h-4.5" />
            </div>
            <h3 className="text-sm sm:text-base font-extrabold text-white leading-tight">
              {initialBook ? 'Chỉnh sửa sách' : 'Thêm sách mới'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-sky-100/80 hover:text-white hover:bg-sky-600/60 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-3.5">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-slate-700">
                Tên Sách <span className="text-rose-500">*</span>
              </label>
              <button
                type="button"
                onClick={handleEnrichWithAI}
                disabled={isEnriching || !title.trim()}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-[#10B981] bg-emerald-50 hover:bg-emerald-100 px-2 py-0.5 rounded-lg transition disabled:opacity-40"
              >
                {isEnriching ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Sparkles className="w-3 h-3" />
                )}
                <span>AI gợi ý</span>
              </button>
            </div>
            <input
              type="text"
              name="nomatch_title"
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Nhập tên sách..."
              className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-[#0284C7] focus:border-[#0284C7] focus:outline-none transition font-medium"
            />
            {duplicateMatch && duplicateMatch.matchedBook && (
              <div className="mt-1.5 p-2 px-2.5 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-1.5 text-[11px] text-amber-900 animate-in fade-in">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="truncate">
                  Đã có: <strong>"{duplicateMatch.matchedBook.title}"</strong> ({duplicateMatch.score}%)
                </span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Tác Giả</label>
            <input
              type="text"
              name="nomatch_author"
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Tên tác giả..."
              className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-[#0284C7] focus:border-[#0284C7] focus:outline-none transition font-medium"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Thể Loại</label>
            <div className="relative">
              <input
                type="text"
                name="nomatch_category"
                autoComplete="new-password"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                data-form-type="other"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Chọn hoặc nhập thể loại"
                list="category-suggestions"
                className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-[#0284C7] focus:border-[#0284C7] focus:outline-none transition font-medium"
              />
              <datalist id="category-suggestions">
                {categories.map((cat) => (
                  <option key={cat} value={cat} />
                ))}
              </datalist>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Nhà Xuất Bản</label>
            <input
              type="text"
              name="nomatch_publisher"
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              value={publisher}
              onChange={(e) => setPublisher(e.target.value)}
              placeholder="NXB..."
              className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-[#0284C7] focus:border-[#0284C7] focus:outline-none transition font-medium"
            />
          </div>

          {/* Actions */}
          <div className="pt-3 flex items-center justify-end gap-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
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
                <span>{initialBook ? 'Lưu Thay Đổi' : 'Thêm Sách'}</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
