import React, { useState, useMemo, useRef } from 'react';
import {
  Search,
  Edit2,
  X,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Database,
  LayoutList,
  PieChart,
  User,
  Building,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { BookRecord } from '../types';
import { removeVietnameseTones } from '../utils/fuzzyMatcher';
import { useToast } from '../context/ToastContext';
import { CategoryBubbleChart } from './CategoryBubbleChart';

interface BookTableViewProps {
  books: BookRecord[];
  categories: string[];
  onSaveBook: (book: BookRecord) => Promise<void>;
  onDeleteBook: (id: string) => Promise<void>;
  onOpenAddModal: () => void;
  onOpenImportModal: () => void;
  onResetMasterData?: () => Promise<void>;
}

export const BookTableView: React.FC<BookTableViewProps> = ({
  books,
  categories,
  onSaveBook,
  onDeleteBook,
  onResetMasterData,
}) => {
  const { showToast } = useToast();
  const [globalFilter, setGlobalFilter] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'chart'>('list');
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editingValues, setEditingValues] = useState<Partial<BookRecord>>({});
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Pagination state
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Bộ lọc thông minh + Fuzzy Match + Tự sắp xếp độ liên quan cao nhất lên đầu
  const filteredData = useMemo(() => {
    let result = books;

    if (selectedCategory !== 'ALL') {
      result = result.filter((b) => (b.category || 'Chung') === selectedCategory);
    }

    const query = globalFilter.trim();
    if (!query) return result;

    const normQuery = removeVietnameseTones(query);
    const queryWords = normQuery.split(/\s+/).filter(Boolean);

    const scored: { book: BookRecord; score: number }[] = [];
    const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (const book of result) {
      const normTitle = removeVietnameseTones(book.title || '');
      const normAuthor = removeVietnameseTones(book.author || '');
      const normPublisher = removeVietnameseTones(book.publisher || '');
      const normCat = removeVietnameseTones(book.category || '');

      const titleWords = normTitle.split(/\s+/).filter(Boolean);
      const authorWords = normAuthor.split(/\s+/).filter(Boolean);

      let score = 0;
      let matchedWordsCount = 0;

      // Đếm số lượng từ khóa tìm kiếm xuất hiện trong tựa sách, tác giả, nhà xuất bản hoặc thể loại
      for (const qw of queryWords) {
        const inTitle = titleWords.includes(qw) || normTitle.includes(qw);
        const inAuthor = authorWords.includes(qw) || normAuthor.includes(qw);
        const inPublisher = normPublisher.includes(qw);
        const inCat = normCat.includes(qw);
        if (inTitle || inAuthor || inPublisher || inCat) {
          matchedWordsCount++;
        }
      }

      // 1. Khớp chính xác hoàn toàn tác giả (Exact Author Match) -> Ưu tiên tuyệt đối
      if (normAuthor === normQuery) {
        score += 5000;
      }
      // 2. Khớp chính xác hoàn toàn tiêu đề (Exact Title Match) -> Ưu tiên cực cao
      else if (normTitle === normQuery) {
        score += 4000;
      }
      // 3. Tác giả bắt đầu bằng cụm từ tìm kiếm (Author starts with query)
      else if (normAuthor.startsWith(normQuery)) {
        score += 2000;
      }
      // 4. Tiêu đề bắt đầu bằng cụm từ tìm kiếm (Title starts with query)
      else if (normTitle.startsWith(normQuery)) {
        score += 1800;
      }
      // 5. Khớp cụm từ tìm kiếm đầy đủ theo ranh giới từ trong Tác giả
      else if (new RegExp(`\\b${escapeRegExp(normQuery)}\\b`).test(normAuthor)) {
        score += 1500;
      }
      // 6. Khớp cụm từ tìm kiếm đầy đủ theo ranh giới từ trong Tiêu đề
      else if (new RegExp(`\\b${escapeRegExp(normQuery)}\\b`).test(normTitle)) {
        score += 1300;
      }
      // 7. Khớp cụm từ tìm kiếm đầy đủ dạng substring trong Tác giả
      else if (normAuthor.includes(normQuery)) {
        score += 1000;
      }
      // 8. Khớp cụm từ tìm kiếm đầy đủ dạng substring trong Tiêu đề
      else if (normTitle.includes(normQuery)) {
        score += 900;
      }

      // 9. Điểm số khớp từng từ đơn lẻ (để tích lũy điểm khi gõ dài)
      for (const qw of queryWords) {
        const isWordMatchTitle = titleWords.includes(qw);
        const isPrefixMatchTitle = qw.length >= 3 && titleWords.some(tw => tw.startsWith(qw));

        if (isWordMatchTitle) {
          score += 100;
        } else if (isPrefixMatchTitle) {
          score += 50;
        }

        const isWordMatchAuthor = authorWords.includes(qw);
        const isPrefixMatchAuthor = qw.length >= 3 && authorWords.some(aw => aw.startsWith(qw));
        if (isWordMatchAuthor) {
          score += 120; // Ưu tiên khớp từ tác giả hơn
        } else if (isPrefixMatchAuthor) {
          score += 60;
        }

        if (normPublisher.includes(qw)) score += 20;
        if (normCat.includes(qw)) score += 10;
      }

      // PHẠT NẶNG/THƯỞNG LỚN CHO ĐỘ PHỦ TỪ KHÓA (Phrase Grouping & Cohesive Lock)
      if (queryWords.length > 1) {
        const containsExactPhrase = 
          normTitle.includes(normQuery) || 
          normAuthor.includes(normQuery) ||
          normPublisher.includes(normQuery) ||
          normCat.includes(normQuery);

        const matchesAllWords = matchedWordsCount === queryWords.length;

        if (containsExactPhrase) {
          score += 3000; // Thưởng cực lớn khi khóa nhóm từ đứng liền nhau
        } else if (matchesAllWords) {
          score += 600; // Khớp đủ toàn bộ từ nhưng không liền nhau
        } else {
          // BẮT BUỘC KHÓA NHÓM TỪ: Nếu gõ nhiều từ khóa mà không khớp cụm từ liền nhau
          // và không khớp đầy đủ 100% tất cả các từ, loại hoàn toàn khỏi kết quả tìm kiếm!
          score = 0;
        }
      }

      if (score > 0) {
        scored.push({ book, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.book);
  }, [books, globalFilter, selectedCategory]);

  // Phân trang dữ liệu
  const totalPages = Math.ceil(filteredData.length / pageSize) || 1;
  const paginatedBooks = useMemo(() => {
    const start = pageIndex * pageSize;
    return filteredData.slice(start, start + pageSize);
  }, [filteredData, pageIndex, pageSize]);

  // Reset pageIndex khi bộ lọc thay đổi
  const handleFilterChange = (val: string) => {
    setGlobalFilter(val);
    setPageIndex(0);
  };

  const handleCategorySelect = (cat: string) => {
    setSelectedCategory(cat);
    setPageIndex(0);
  };

  const handleSelectCategoryFromChart = (catName: string) => {
    setSelectedCategory(catName);
    setViewMode('list');
    setPageIndex(0);
    showToast(`Đã lọc danh sách theo thể loại: ${catName}`, 'info');
  };

  // Inline editing actions
  const handleStartEdit = (book: BookRecord) => {
    setEditingRowId(book.id);
    setEditingValues({ ...book });
  };

  const handleCancelEdit = () => {
    setEditingRowId(null);
    setEditingValues({});
  };

  const handleSaveInline = async (originalBook: BookRecord) => {
    if (!editingValues.title?.trim()) {
      showToast('Tên sách không được để trống!', 'warning');
      return;
    }
    const updatedBook: BookRecord = {
      ...originalBook,
      title: editingValues.title.trim(),
      author: editingValues.author?.trim() || '',
      category: editingValues.category?.trim() || 'Chung',
      publisher: editingValues.publisher?.trim() || '',
      updated_at: Date.now(),
    };
    await onSaveBook(updatedBook);
    setEditingRowId(null);
    setEditingValues({});
    showToast('Cập nhật sách thành công!', 'success');
  };

  const isSearching = Boolean(globalFilter.trim());

  return (
    <div className="space-y-3">
      {/* Search & View Switcher Bar */}
      <div
        ref={searchContainerRef}
        className="sticky top-14 z-30 bg-white/95 backdrop-blur-md rounded-2xl border border-slate-200/90 shadow-xs p-2.5 space-y-2 transition-all"
      >
        <div className="flex items-center gap-2">
          {/* Main Search Input */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              name="book_search_query"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="search"
              value={globalFilter}
              onChange={(e) => handleFilterChange(e.target.value)}
              placeholder="Gõ tên sách, tác giả... (không dấu)"
              className="w-full pl-9 pr-8 py-2 text-xs sm:text-sm bg-slate-50 focus:bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none transition font-medium"
            />
            {globalFilter && (
              <button
                onClick={() => handleFilterChange('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1 rounded-full bg-slate-200/70"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* View Switcher: Thẻ Sách vs Thống Kê Thể Loại */}
          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 shrink-0">
            <button
              onClick={() => setViewMode('list')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition ${
                viewMode === 'list'
                  ? 'bg-white text-emerald-700 shadow-xs font-bold'
                  : 'text-slate-500 hover:text-slate-800 font-medium'
              }`}
              title="Thẻ Danh Sách"
            >
              <LayoutList className="w-4 h-4" />
              <span className="hidden sm:inline">Thẻ Sách</span>
            </button>
            <button
              onClick={() => setViewMode('chart')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition ${
                viewMode === 'chart'
                  ? 'bg-white text-emerald-700 shadow-xs font-bold'
                  : 'text-slate-500 hover:text-slate-800 font-medium'
              }`}
              title="Thống Kê Thể Loại"
            >
              <PieChart className="w-4 h-4" />
              <span className="hidden sm:inline">Thống Kê</span>
            </button>
          </div>
        </div>

        {/* Live Search Results Header or Category Horizontal Scroll */}
        {isSearching ? (
          <div className="flex items-center justify-between text-xs bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-200">
            <span className="font-bold text-emerald-900 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
              <span>
                Tìm thấy <strong className="text-emerald-700 font-extrabold">{filteredData.length}</strong> cuốn gần giống
              </span>
            </span>
            <button
              onClick={() => handleFilterChange('')}
              className="text-[11px] font-bold text-slate-500 hover:text-slate-800 underline"
            >
              Thoát tìm kiếm
            </button>
          </div>
        ) : (
          viewMode === 'list' && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none text-xs">
              <button
                onClick={() => handleCategorySelect('ALL')}
                className={`px-2.5 py-1 rounded-full text-xs font-bold shrink-0 transition ${
                  selectedCategory === 'ALL'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                Tất cả ({books.length})
              </button>
              {categories.map((cat) => {
                const count = books.filter(
                  (b) => (b.category || 'Chung') === cat
                ).length;
                if (count === 0) return null;
                const isSel = selectedCategory === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => handleCategorySelect(cat)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium shrink-0 transition ${
                      isSel
                        ? 'bg-emerald-600 text-white font-bold shadow-xs'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {cat} ({count})
                  </button>
                );
              })}
            </div>
          )
        )}
      </div>

      {/* Main Content: Card List View OR Dashboard Bubble Chart View */}
      {viewMode === 'list' ? (
        <div className="space-y-3">
          {/* Mobile Cards List */}
          <div className="space-y-1.5">
            {paginatedBooks.length > 0 ? (
              paginatedBooks.map((book, idx) => {
                const isEditing = editingRowId === book.id;
                const displayIndex = pageIndex * pageSize + idx + 1;

                if (isEditing) {
                  return (
                    <div
                      key={book.id}
                      className="bg-emerald-50/70 border border-emerald-400 rounded-xl p-2.5 space-y-1.5 shadow-xs"
                    >
                      <div className="text-[10px] font-bold text-emerald-800 uppercase tracking-wider">
                        Sửa nhanh cuốn #{displayIndex}
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-500">
                          Tên Sách
                        </label>
                        <input
                          type="text"
                          value={editingValues.title ?? book.title}
                          onChange={(e) =>
                            setEditingValues((prev) => ({
                              ...prev,
                              title: e.target.value,
                            }))
                          }
                          className="w-full px-2 py-1 text-xs font-bold text-slate-900 bg-white border border-emerald-500 rounded-lg focus:outline-none"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] font-bold text-slate-500">
                            Tác Giả
                          </label>
                          <input
                            type="text"
                            value={editingValues.author ?? book.author}
                            onChange={(e) =>
                              setEditingValues((prev) => ({
                                ...prev,
                                author: e.target.value,
                              }))
                            }
                            className="w-full px-2 py-0.5 text-xs bg-white border border-emerald-500 rounded-lg focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-500">
                            Thể Loại
                          </label>
                          <input
                            type="text"
                            value={editingValues.category ?? book.category}
                            onChange={(e) =>
                              setEditingValues((prev) => ({
                                ...prev,
                                category: e.target.value,
                              }))
                            }
                            className="w-full px-2 py-0.5 text-xs bg-white border border-emerald-500 rounded-lg focus:outline-none"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-500">
                          Nhà Xuất Bản
                        </label>
                        <input
                          type="text"
                          value={editingValues.publisher ?? book.publisher}
                          onChange={(e) =>
                            setEditingValues((prev) => ({
                              ...prev,
                              publisher: e.target.value,
                            }))
                          }
                          className="w-full px-2 py-0.5 text-xs bg-white border border-emerald-500 rounded-lg focus:outline-none"
                        />
                      </div>
                      <div className="flex items-center justify-end gap-2 pt-0.5">
                        <button
                          onClick={handleCancelEdit}
                          className="px-2.5 py-0.5 bg-slate-200 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-300 transition"
                        >
                          Hủy
                        </button>
                        <button
                          onClick={() => handleSaveInline(book)}
                          className="px-2.5 py-0.5 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 transition shadow-xs"
                        >
                          Lưu Cập Nhật
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={book.id}
                    className="bg-white border border-slate-200/90 rounded-xl p-2.5 shadow-2xs hover:border-emerald-300 transition"
                  >
                    {/* Top Row: Full Width Title + Action Buttons */}
                    <div className="flex items-start justify-between gap-1.5">
                      <h2 className="text-xs sm:text-sm font-extrabold text-slate-900 leading-tight min-w-0 flex-1">
                        <span className="text-slate-400 font-mono font-bold mr-1">{displayIndex}.</span>
                        {book.title}
                      </h2>

                      <div className="flex items-center gap-0.5 shrink-0 pt-0.5">
                        {confirmDeleteId === book.id ? (
                          <div className="flex items-center gap-1 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded-lg animate-in fade-in duration-150">
                            <span className="text-[10px] font-bold text-rose-700 shrink-0">Xóa?</span>
                            <button
                              onClick={() => {
                                onDeleteBook(book.id);
                                setConfirmDeleteId(null);
                              }}
                              className="px-1.5 py-0.5 bg-rose-600 text-white rounded text-[10px] font-bold hover:bg-rose-700 transition"
                            >
                              Có
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded text-[10px] font-bold hover:bg-slate-300 transition"
                            >
                              Không
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => handleStartEdit(book)}
                              className="p-1 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition"
                              title="Sửa nhanh"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(book.id)}
                              className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                              title="Xóa"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Bottom Row: Left (Author/Publisher) | Right (Category Badge) */}
                    <div className="flex items-center justify-between gap-2 mt-1.5 pt-1 border-t border-slate-100/80 text-[10.5px] text-slate-600">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 min-w-0 flex-1">
                        {book.author && (
                          <span className="flex items-center gap-1 font-medium">
                            <User className="w-3 h-3 text-slate-400 shrink-0" />
                            <span className="truncate max-w-[130px] sm:max-w-[220px]">{book.author}</span>
                          </span>
                        )}
                        {book.publisher && (
                          <span className="flex items-center gap-1 text-slate-500">
                            <Building className="w-3 h-3 text-slate-400 shrink-0" />
                            <span className="truncate max-w-[110px] sm:max-w-[180px]">{book.publisher}</span>
                          </span>
                        )}
                      </div>

                      {/* Thể loại căn phải dòng dưới */}
                      <div className="shrink-0 ml-auto">
                        <span className="px-1.5 py-0.5 bg-emerald-50 text-emerald-800 rounded text-[9.5px] font-bold border border-emerald-200/80">
                          {book.category || 'Chung'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="bg-white rounded-2xl p-8 text-center text-slate-400 border border-slate-200 shadow-2xs">
                <Database className="w-10 h-10 mx-auto mb-2 text-slate-300 opacity-60" />
                <p className="text-xs font-bold text-slate-700">
                  Không tìm thấy cuốn sách nào khớp với từ khóa
                </p>
                <p className="text-[11px] text-slate-400 mt-1">
                  Thử chọn thể loại khác hoặc gõ tên sách/tác giả không dấu khác
                </p>
              </div>
            )}
          </div>

          {/* Pagination Controls */}
          {filteredData.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200/90 p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-600 shadow-2xs">
              <div className="flex items-center justify-between sm:justify-start gap-2">
                <span>
                  Hiển thị <span className="font-bold text-slate-900">{paginatedBooks.length}</span> /{' '}
                  <span className="font-bold text-slate-900">{filteredData.length}</span> cuốn
                </span>
                <div className="flex items-center gap-1 text-[11px]">
                  <span>Mỗi trang:</span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPageIndex(0);
                    }}
                    className="bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-0.5 text-xs font-semibold text-slate-800"
                  >
                    {[25, 50, 100, 200, 500].map((ps) => (
                      <option key={ps} value={ps}>
                        {ps}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-2">
                <span className="text-[11px]">
                  Trang <span className="font-bold text-slate-900">{pageIndex + 1}</span> /{' '}
                  <span className="font-bold text-slate-900">{totalPages}</span>
                </span>

                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                    disabled={pageIndex === 0}
                    className="p-1 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setPageIndex((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={pageIndex >= totalPages - 1}
                    className="p-1 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Category Bubble Chart View */
        <CategoryBubbleChart
          books={books}
          onSelectCategory={handleSelectCategoryFromChart}
        />
      )}
    </div>
  );
};
