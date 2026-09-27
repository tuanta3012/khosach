import React, { useState, useEffect, useMemo } from 'react';
import { X, Book, Tag, Sparkles, Loader2, AlertTriangle } from 'lucide-react';
import { BookRecord } from '../types';
import { useToast } from '../context/ToastContext';
import { checkDuplicateBook, stringSimilarity } from '../utils/fuzzyMatcher';

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

  // Kiểm tra trùng lặp TÊN SÁCH thời gian thực với kho sách hiện có
  const duplicateMatch = useMemo(() => {
    if (!title.trim() || !books || books.length === 0) return null;
    const existingOther = initialBook
      ? books.filter((b) => b.id !== initialBook.id)
      : books;
    // Kiểm tra tiêu đề sách (title)
    const result = checkDuplicateBook({ title }, existingOther);
    if (!result.isDuplicate || !result.matchedBook) return null;

    // Nếu người dùng ĐÃ nhập Tác giả, và tác giả này KHÁC tác giả cuốn sách trùng -> Bỏ cảnh báo!
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
      showToast('Vui lòng nhập tên sách trước khi làm giàu dữ liệu!', 'warning');
      return;
    }

    setIsEnriching(true);
    try {
      const res = await fetch('/api/books/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, author, publisher }),
      });

      if (!res.ok) throw new Error('Không thể tra cứu thông tin sách');
      const data = await res.json();
      const enriched = data.enriched;

      if (enriched) {
        if (enriched.title) setTitle(enriched.title);
        if (enriched.author) setAuthor(enriched.author);
        if (enriched.category) setCategory(enriched.category);
        if (enriched.publisher) setPublisher(enriched.publisher);
        showToast('Đã tự động điền thông tin chuẩn từ AI!', 'success');
      }
    } catch (err: any) {
      showToast(`Lỗi tra cứu: ${err.message}`, 'error');
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
      showToast(initialBook ? 'Đã cập nhật sách thành công!' : 'Đã thêm sách mới vào kho!', 'success');
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
        {/* Header */}
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center">
              <Book className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900 leading-tight">
                {initialBook ? 'Chỉnh sửa sách' : 'Nhập sách'}
              </h3>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-bold text-slate-700 uppercase tracking-wide">
                Tên Sách <span className="text-rose-500">*</span>
              </label>
              <button
                type="button"
                onClick={handleEnrichWithAI}
                disabled={isEnriching || !title.trim()}
                className="inline-flex items-center gap-1 text-xs font-bold text-purple-700 bg-purple-50 hover:bg-purple-100 px-2.5 py-1 rounded-lg transition disabled:opacity-40"
              >
                {isEnriching ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                <span>AI tra cứu thông tin</span>
              </button>
            </div>
            <input
              type="text"
              autoComplete="off"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Nhập tên sách (ví dụ: Chiến Tranh Và Hòa Bình)"
              className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none transition"
            />
            {/* Cảnh báo trùng lặp TÊN SÁCH ngắn gọn ngay dưới ô Tên sách */}
            {duplicateMatch && duplicateMatch.matchedBook && (
              <div className="mt-1.5 p-2 px-3 bg-amber-50 border border-amber-200/90 rounded-xl flex items-center gap-2 text-xs text-amber-900 animate-in fade-in">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="truncate">
                  <strong className="font-bold text-amber-950">Đã có trong kho:</strong> "{duplicateMatch.matchedBook.title}" ({duplicateMatch.score}%)
                </span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wide mb-1.5">
              Tác Giả
            </label>
            <input
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Tên tác giả (ví dụ: Nguyễn Nhật Ánh, Lev Tolstoy...)"
              className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-1 focus:ring-emerald-500 focus:outline-none transition"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wide mb-1.5">
                Thể Loại
              </label>
              <div className="relative">
                <input
                  type="text"
                  list="categories-list"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="Thể loại..."
                  className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none transition"
                />
                <datalist id="categories-list">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wide mb-1.5">
                Nhà Xuất Bản (NXB)
              </label>
              <input
                type="text"
                value={publisher}
                onChange={(e) => setPublisher(e.target.value)}
                placeholder="NXB Trẻ, NXB Kim Đồng..."
                className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none transition"
              />
            </div>
          </div>

          {/* Footer Buttons */}
          <div className="pt-4 border-t border-slate-100 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              <span>{initialBook ? 'Lưu Thay Đổi' : 'Thêm Vào Kho'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
