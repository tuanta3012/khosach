import React, { useState, useMemo, useRef, useDeferredValue, useCallback } from "react";
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
  Upload,
  Camera,
  Plus,
  ArrowUpDown,
  PlusCircle,
} from "lucide-react";
import { BookRecord } from "../types";
import { removeVietnameseTones } from "../utils/fuzzyMatcher";
import { useToast } from "../context/ToastContext";
import { CategoryBubbleChart } from "./CategoryBubbleChart";
import { SortSelectDropdown, BookSortOption } from "./SortSelectDropdown";

interface BookTableViewProps {
  books: BookRecord[];
  categories: string[];
  onSaveBook: (book: BookRecord) => Promise<void>;
  onDeleteBook: (id: string) => Promise<void>;
  onOpenAddModal: () => void;
  onOpenImportModal: () => void;
  onSwitchToScanner?: () => void;
  appMode?: "offline" | "online";
  isSyncingDrive?: boolean;
}

function getCategoryBadgeStyle(categoryName: string): { bg: string; text: string; border: string } {
  const cat = (categoryName || "").toLowerCase();
  if (cat.includes("kinh tế") || cat.includes("đầu tư") || cat.includes("kinh doanh")) {
    return { bg: "bg-emerald-50", text: "text-[#10B981]", border: "border-emerald-200" };
  }
  if (cat.includes("lịch sử") || cat.includes("hồi ký") || cat.includes("tự truyện")) {
    return { bg: "bg-amber-50", text: "text-[#EA580C]", border: "border-amber-200" };
  }
  return { bg: "bg-sky-50", text: "text-[#0284C7]", border: "border-[#bfdbfe]" };
}

export const BookTableView: React.FC<BookTableViewProps> = React.memo(({
  books,
  categories,
  onSaveBook,
  onDeleteBook,
  onOpenAddModal,
  onOpenImportModal,
  onSwitchToScanner,
}) => {
  const { showToast } = useToast();
  const [globalFilter, setGlobalFilter] = useState("");
  const deferredFilter = useDeferredValue(globalFilter);
  const [viewMode, setViewMode] = useState<"list" | "chart">("list");
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editingValues, setEditingValues] = useState<Partial<BookRecord>>({});
  const [selectedCategory, setSelectedCategory] = useState<string>("ALL");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Pagination state
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // Sắp xếp
  const [sortBy, setSortBy] = useState<BookSortOption>(() => {
    try {
      return (localStorage.getItem("book_library_sort_by") as BookSortOption) || "newest";
    } catch {
      return "newest";
    }
  });

  const handleSortChange = (newSort: BookSortOption) => {
    setSortBy(newSort);
    try {
      localStorage.setItem("book_library_sort_by", newSort);
    } catch {}
    setPageIndex(0);
  };

  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Tối ưu hóa đếm số lượng sách theo danh mục trong O(N) duy nhất
  const categoryCounts = useMemo(() => {
    const counts = {};
    for (let i = 0; i < books.length; i++) {
      const cat = (books[i].category || "Chung").trim() || "Chung";
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }, [books]);

  // Bộ lọc thông minh + Fuzzy Match + Tự sắp xếp (chạy non-blocking với deferredFilter)
  const filteredData = useMemo(() => {
    let result = [...books];

    if (selectedCategory !== "ALL") {
      result = result.filter((b) => (b.category || "Chung") === selectedCategory);
    }

    const getBookTime = (b: BookRecord) => {
      if (typeof b.created_at === "number" && b.created_at > 0) return b.created_at;
      if (typeof b.updated_at === "number" && b.updated_at > 0) return b.updated_at;
      if (b.id && b.id.startsWith("book_")) {
        const parts = b.id.split("_");
        const num = Number(parts[1]);
        if (!isNaN(num) && num > 0) return num;
      }
      return 0;
    };

    const sortFn = (a: BookRecord, b: BookRecord) => {
      if (sortBy === "newest") {
        const timeDiff = getBookTime(b) - getBookTime(a);
        if (timeDiff !== 0) return timeDiff;
        return (a.title || "").localeCompare(b.title || "", "vi", { sensitivity: "base" });
      }
      if (sortBy === "oldest") {
        const timeDiff = getBookTime(a) - getBookTime(b);
        if (timeDiff !== 0) return timeDiff;
        return (a.title || "").localeCompare(b.title || "", "vi", { sensitivity: "base" });
      }
      if (sortBy === "title_asc") {
        const comp = (a.title || '').localeCompare(b.title || '', 'vi', { sensitivity: 'base' });
        if (comp !== 0) return comp;
        return getBookTime(b) - getBookTime(a);
      }
      if (sortBy === 'title_desc') {
        const comp = (b.title || '').localeCompare(a.title || '', 'vi', { sensitivity: 'base' });
        if (comp !== 0) return comp;
        return getBookTime(b) - getBookTime(a);
      }
      return 0;
    };

    const query = deferredFilter.trim();
    if (!query) {
      result.sort(sortFn);
      return result;
    }

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

      for (const qw of queryWords) {
        const inTitle = titleWords.includes(qw) || normTitle.includes(qw);
        const inAuthor = authorWords.includes(qw) || normAuthor.includes(qw);
        const inPublisher = normPublisher.includes(qw);
        const inCat = normCat.includes(qw);
        if (inTitle || inAuthor || inPublisher || inCat) {
          matchedWordsCount++;
        }
      }

      if (normAuthor === normQuery) {
        score += 5000;
      } else if (normTitle === normQuery) {
        score += 4000;
      } else if (normAuthor.startsWith(normQuery)) {
        score += 2000;
      } else if (normTitle.startsWith(normQuery)) {
        score += 1800;
      } else if (new RegExp(`\\b${escapeRegExp(normQuery)}\\b`).test(normAuthor)) {
        score += 1500;
      } else if (new RegExp(`\\b${escapeRegExp(normQuery)}\\b`).test(normTitle)) {
        score += 1300;
      } else if (normAuthor.includes(normQuery)) {
        score += 1000;
      } else if (normTitle.includes(normQuery)) {
        score += 900;
      }

      for (const qw of queryWords) {
        const isWordMatchTitle = titleWords.includes(qw);
        const isPrefixMatchTitle = qw.length >= 3 && titleWords.some((tw) => tw.startsWith(qw));

        if (isWordMatchTitle) {
          score += 100;
        } else if (isPrefixMatchTitle) {
          score += 50;
        }

        const isWordMatchAuthor = authorWords.includes(qw);
        const isPrefixMatchAuthor = qw.length >= 3 && authorWords.some((aw) => aw.startsWith(qw));
        if (isWordMatchAuthor) {
          score += 120;
        } else if (isPrefixMatchAuthor) {
          score += 60;
        }

        if (normPublisher.includes(qw)) score += 20;
        if (normCat.includes(qw)) score += 10;
      }

      if (queryWords.length > 1) {
        const containsExactPhrase =
          normTitle.includes(normQuery) ||
          normAuthor.includes(normQuery) ||
          normPublisher.includes(normQuery) ||
          normCat.includes(normQuery);

        const matchesAllWords = matchedWordsCount === queryWords.length;

        if (containsExactPhrase) {
          score += 3000;
        } else if (matchesAllWords) {
          score += 600;
        } else {
          score = 0;
        }
      }

      if (score > 0) {
        scored.push({ book, score });
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return sortFn(a.book, b.book);
    });
    return scored.map((s) => s.book);
  }, [books, deferredFilter, selectedCategory, sortBy]);

  // Phân trang
  const totalPages = Math.ceil(filteredData.length / pageSize) || 1;
  const paginatedBooks = useMemo(() => {
    const start = pageIndex * pageSize;
    return filteredData.slice(start, start + pageSize);
  }, [filteredData, pageIndex, pageSize]);

  const handleFilterChange = (val: string) => {
    setGlobalFilter(val);
    setPageIndex(0);
  };

  const handleCategorySelect = (cat: string) => {
    setSelectedCategory(cat);
    setPageIndex(0);
  };

  const handleSelectCategoryFromChart = useCallback((catName: string) => {
    setSelectedCategory(catName);
    setViewMode('list');
    setPageIndex(0);
    showToast(`Đã lọc: ${catName}`, 'info');
  }, [showToast]);

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
    showToast('Đã lưu sách!', 'success');
  };

  const isSearching = Boolean(globalFilter.trim());

  return (
    <div className="space-y-2.5">
      {/* Search & Filter Bar - Warm Sienna Accents */}
      <div
        ref={searchContainerRef}

      >
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Main Search Input */}
          <form
            role="search"
            onSubmit={(e) => e.preventDefault()}
            autoComplete="off"
            className="relative flex-1"
          >
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="search"
              name="nomatch_search"
              id="book-catalog-search-input"
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="search"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              value={globalFilter}
              onChange={(e) => handleFilterChange(e.target.value)}
              placeholder="Tìm tên sách, tác giả..."
              className="w-full pl-9 pr-8 py-2 text-xs sm:text-sm bg-slate-50 focus:bg-white border border-slate-200 focus:border-[#0284C7] rounded-xl focus:ring-2 focus:ring-[#0284C7]/20 focus:outline-none transition font-medium"
            />
            {globalFilter && (
              <button
                type="button"
                onClick={() => handleFilterChange('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1 rounded-full bg-slate-200/60"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </form>

          {/* View Switcher: Thẻ Sách vs Thống Kê */}
          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 shrink-0">
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-lg text-xs transition ${
                viewMode === 'list'
                  ? 'bg-[#10B981] text-white shadow-xs font-bold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title="Danh Sách"
            >
              <LayoutList className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('chart')}
              className={`p-1.5 rounded-lg text-xs transition ${
                viewMode === 'chart'
                  ? 'bg-[#10B981] text-white shadow-xs font-bold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title="Thống Kê Thể Loại"
            >
              <PieChart className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Live Search Header or Category Horizontal Scroll */}
        {isSearching ? (
          <div className="flex items-center justify-between text-xs bg-sky-50 px-3 py-1.5 rounded-xl border border-sky-200/80">
            <span className="font-bold text-[#0284C7] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[#0284C7]" />
              <span>
                Tìm thấy <strong className="text-[#0369a1] font-black">{filteredData.length}</strong> cuốn
              </span>
            </span>
            <div className="flex items-center gap-2">
              <SortSelectDropdown value={sortBy} onChange={handleSortChange} className="shrink-0" />
              <button
                onClick={() => handleFilterChange('')}
                className="text-[11px] font-bold text-slate-500 hover:text-slate-800 underline cursor-pointer"
              >
                Thoát
              </button>
            </div>
          </div>
        ) : (
          viewMode === 'list' && (
            <div className="flex items-center gap-1.5 text-xs">
              {/* Nút Sắp Xếp: Cố định bên trái, nằm ngoài thanh cuộn ngang để menu dropdown xổ xuống tự do */}
              <SortSelectDropdown value={sortBy} onChange={handleSortChange} className="shrink-0" />

              {/* Thanh cuộn ngang các thẻ phân loại */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none flex-1 min-w-0">
                <button
                  onClick={() => handleCategorySelect('ALL')}
                  className={`px-3 py-1 rounded-full text-xs font-bold shrink-0 transition ${
                    selectedCategory === 'ALL'
                      ? 'bg-[#10B981] text-white shadow-xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Tất cả ({books.length})
                </button>
                {categories.map((cat) => {
                  const count = categoryCounts[cat] || 0;
                  if (count === 0) return null;
                  const isSel = selectedCategory === cat;
                  return (
                    <button
                      key={cat}
                      onClick={() => handleCategorySelect(cat)}
                      className={`px-3 py-1 rounded-full text-xs font-medium shrink-0 transition ${
                        isSel
                          ? 'bg-[#10B981] text-white font-bold shadow-xs'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {cat} ({count})
                    </button>
                  );
                })}
              </div>
            </div>
          )
        )}
      </div>

      {/* Main Content Area */}
      {viewMode === 'list' ? (
        <div className="space-y-2.5">
          {/* Books List Cards (Khoảng cách gọn gàng) */}
          <div className="space-y-1">
            {paginatedBooks.length > 0 ? (
              paginatedBooks.map((book, idx) => {
                const isEditing = editingRowId === book.id;
                const displayIndex = pageIndex * pageSize + idx + 1;
                const badgeStyle = getCategoryBadgeStyle(book.category || '');

                if (isEditing) {
                  return (
                    <div
                      key={book.id}
                      className="bg-amber-50/80 border border-amber-300 rounded-xl p-2.5 space-y-1.5 shadow-xs"
                    >
                      <div className="text-[10px] font-bold text-[#85451e] uppercase tracking-wider">
                        Sửa cuốn #{displayIndex}
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-500">Tên Sách</label>
                        <input
                          type="text"
                          name="nomatch_inline_title"
                          autoComplete="new-password"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          data-lpignore="true"
                          data-1p-ignore="true"
                          data-form-type="other"
                          value={editingValues.title ?? book.title}
                          onChange={(e) =>
                            setEditingValues((prev) => ({
                              ...prev,
                              title: e.target.value,
                            }))
                          }
                          className="w-full px-2 py-1 text-xs font-bold text-slate-900 bg-white border border-[#EA580C] rounded-lg focus:outline-none"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] font-bold text-slate-500">Tác Giả</label>
                          <input
                            type="text"
                            name="nomatch_inline_author"
                            autoComplete="new-password"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-form-type="other"
                            value={editingValues.author ?? book.author}
                            onChange={(e) =>
                              setEditingValues((prev) => ({
                                ...prev,
                                author: e.target.value,
                              }))
                            }
                            className="w-full px-2 py-0.5 text-xs bg-white border border-[#EA580C] rounded-lg focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-500">Thể Loại</label>
                          <input
                            type="text"
                            name="nomatch_inline_category"
                            autoComplete="new-password"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-form-type="other"
                            value={editingValues.category ?? book.category}
                            onChange={(e) =>
                              setEditingValues((prev) => ({
                                ...prev,
                                category: e.target.value,
                              }))
                            }
                            className="w-full px-2 py-0.5 text-xs bg-white border border-[#EA580C] rounded-lg focus:outline-none"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-500">Nhà Xuất Bản</label>
                        <input
                          type="text"
                          name="nomatch_inline_publisher"
                          autoComplete="new-password"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          data-lpignore="true"
                          data-1p-ignore="true"
                          data-form-type="other"
                          value={editingValues.publisher ?? book.publisher}
                          onChange={(e) =>
                            setEditingValues((prev) => ({
                              ...prev,
                              publisher: e.target.value,
                            }))
                          }
                          className="w-full px-2 py-0.5 text-xs bg-white border border-[#EA580C] rounded-lg focus:outline-none"
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
                          className="px-2.5 py-0.5 bg-[#EA580C] text-white rounded-lg text-xs font-bold hover:bg-[#c2410c] transition shadow-xs cursor-pointer"
                        >
                          Lưu
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={book.id}
                    className="bg-white border border-slate-200/90 rounded-xl px-2.5 py-1.5 shadow-2xs hover:border-emerald-300 transition"
                  >
                    {/* Top Row: Index + Title + Quick Actions */}
                    <div className="flex items-start justify-between gap-1.5">
                      <h2 className="text-xs sm:text-[13px] font-extrabold text-slate-900 leading-snug min-w-0 flex-1">
                        <span className="text-slate-400 font-mono font-bold mr-1">{displayIndex}.</span>
                        {book.title}
                      </h2>

                      <div className="flex items-center gap-0.5 shrink-0 pt-0.5">
                        {confirmDeleteId === book.id ? (
                          <div className="flex items-center gap-1 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded-lg animate-in fade-in duration-150">
                            <span className="text-[9.5px] font-bold text-rose-700 shrink-0">Xóa?</span>
                            <button
                              onClick={() => {
                                onDeleteBook(book.id);
                                setConfirmDeleteId(null);
                              }}
                              className="px-1.5 py-0.2 bg-rose-600 text-white rounded text-[9.5px] font-bold hover:bg-rose-700 transition"
                            >
                              Có
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-1.5 py-0.2 bg-slate-200 text-slate-700 rounded text-[9.5px] font-bold hover:bg-slate-300 transition"
                            >
                              Không
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => handleStartEdit(book)}
                              className="p-0.5 text-slate-400 hover:text-[#0284C7] hover:bg-sky-50 rounded-md transition"
                              title="Sửa"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(book.id)}
                              className="p-0.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition"
                              title="Xóa"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Bottom Row: Author/Publisher + Category Badge */}
                    <div className="flex items-center justify-between gap-2 mt-1 pt-0.5 border-t border-slate-100/80 text-[10px] text-slate-600">
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

                      <div className="shrink-0 ml-auto">
                        <span
                          className={`px-1.5 py-0.2 rounded text-[9px] font-bold border ${badgeStyle.bg} ${badgeStyle.text} ${badgeStyle.border}`}
                        >
                          {book.category || 'Chung'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            ) : books.length === 0 ? (
              /* Kho Sách Đang Trống (0 cuốn) - Hiển thị Khối Đồng Bộ & Nhập Sách Nổi Bật */
              <div className="bg-white rounded-3xl p-6 sm:p-8 text-center border border-slate-200/90 shadow-2xs space-y-4 my-2">
                <div className="w-16 h-16 rounded-2xl bg-sky-50 border border-sky-200 text-[#0284C7] flex items-center justify-center mx-auto shadow-2xs">
                  <Upload className="w-8 h-8" />
                </div>

                <div className="space-y-1">
                  <h3 className="text-base sm:text-lg font-black text-slate-900">
                    Kho sách của bạn đang trống!
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
                    Hãy bắt đầu thêm sách vào kho của bạn bằng nhiều cách đa dạng và chính xác.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 max-w-xl mx-auto pt-2">
                  {/* Nút 1: Nhập file / Đồng bộ (Xanh Dương Hiện Đại) */}
                  <button
                    type="button"
                    onClick={onOpenImportModal}
                    className="px-4 py-3 bg-[#0284C7] hover:bg-[#0369a1] active:scale-95 text-white rounded-2xl font-bold text-xs shadow-md transition flex items-center justify-center gap-2 cursor-pointer border border-sky-400/30"
                  >
                    <ArrowUpDown className="w-4 h-4 shrink-0" />
                    <span>Nhập file / Đồng bộ</span>
                  </button>

                  {/* Nút 2: Thêm sách bằng ảnh (Xanh Ngọc Lục Bảo) */}
                  {onSwitchToScanner && (
                    <button
                      type="button"
                      onClick={onSwitchToScanner}
                      className="px-4 py-3 bg-[#10B981] hover:bg-[#059669] active:scale-95 text-white rounded-2xl font-bold text-xs shadow-md transition flex items-center justify-center gap-2 cursor-pointer border border-emerald-400/30"
                    >
                      <div className="relative inline-flex items-center shrink-0">
                        <Camera className="w-4 h-4" />
                        <span className="absolute -top-1.5 -right-2 bg-[#F59E0B] text-slate-950 text-[7px] font-black px-0.5 rounded-xs leading-none shadow-xs">
                          AI
                        </span>
                      </div>
                      <span>Thêm sách bằng ảnh</span>
                    </button>
                  )}

                  {/* Nút 3: Thêm sách mới (Cam San Hồ / Terracotta) */}
                  <button
                    type="button"
                    onClick={onOpenAddModal}
                    className="px-4 py-3 bg-[#EA580C] hover:bg-[#c2410c] active:scale-95 text-white rounded-2xl font-bold text-xs shadow-md transition flex items-center justify-center gap-2 cursor-pointer border border-orange-400/30"
                  >
                    <PlusCircle className="w-4 h-4 shrink-0" />
                    <span>Thêm sách mới</span>
                  </button>
                </div>
              </div>
            ) : (
              /* Trường hợp đang Tìm Kiếm hoặc Lọc Thể Loại nhưng Không Có Kết Quả */
              <div className="bg-white rounded-2xl p-8 text-center text-slate-400 border border-slate-200 shadow-2xs space-y-2">
                <Database className="w-10 h-10 mx-auto text-slate-300 opacity-60" />
                <p className="text-xs font-bold text-slate-700">Không tìm thấy sách phù hợp</p>
                <p className="text-[11px] text-slate-400">Thử chọn thể loại khác hoặc gõ từ khóa không dấu</p>
                {(globalFilter || selectedCategory !== 'ALL') && (
                  <button
                    type="button"
                    onClick={() => {
                      setGlobalFilter('');
                      setSelectedCategory('ALL');
                    }}
                    className="mt-2 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition cursor-pointer"
                  >
                    Xóa tìm kiếm & Bộ lọc
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Pagination */}
          {filteredData.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200/90 p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-600 shadow-2xs">
              <div className="flex items-center justify-between sm:justify-start gap-2">
                <span>
                  <strong className="text-slate-900">{paginatedBooks.length}</strong> /{' '}
                  <strong className="text-slate-900">{filteredData.length}</strong> cuốn
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
                  Trang <strong className="text-slate-900">{pageIndex + 1}</strong> /{' '}
                  <strong className="text-slate-900">{totalPages}</strong>
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
        <CategoryBubbleChart books={books} onSelectCategory={handleSelectCategoryFromChart} />
      )}
    </div>
  );
});
