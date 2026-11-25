import React, { useState, useMemo, useRef, useDeferredValue, useCallback, useEffect } from "react";
import {
  Search,
  X,
  Trash2,
  Database,
  LayoutList,
  LayoutGrid,
  PieChart,
  User,
  Building,
  Sparkles,
  Upload,
  Camera,
  ArrowUpDown,
  PlusCircle,
} from "lucide-react";
import { BookRecord, UserRole } from "../types";
import { removeVietnameseTones } from "../utils/fuzzyMatcher";
import { useToast } from "../context/ToastContext";
import { CategoryBubbleChart } from "./CategoryBubbleChart";
import { SortSelectDropdown, BookSortOption } from "./SortSelectDropdown";
import { BookCover } from "./BookCover";
import { registerBackButtonHandler } from "../services/backButtonService";
import {
  reclassifyBookCategories,
  ensureGeminiAccessAvailable,
} from "../utils/geminiService";

interface BookTableViewProps {
  books: BookRecord[];
  categories: string[];
  onSaveBook?: (book: BookRecord) => Promise<void>;
  onDeleteBook: (id: string) => Promise<void>;
  onBatchUpdateBooks?: (updatedBooksList: BookRecord[], options?: { skipSync?: boolean }) => Promise<void>;
  onSyncDriveNow?: () => Promise<void>;
  onOpenAddModal: () => void;
  onOpenEditModal?: (book: BookRecord) => void;
  onOpenImportModal: () => void;
  onSwitchToScanner?: () => void;
  onOpenSettingsKey?: () => void;
  userRole?: UserRole;
  appMode?: "offline" | "online";
  isSyncingDrive?: boolean;
}

function getCategoryBadgeStyle(categoryName: string): { bg: string; text: string; border: string } {
  const cat = (categoryName || "").toLowerCase();
  if (cat.includes("kinh tế") || cat.includes("đầu tư") || cat.includes("kinh doanh") || cat.includes("quản trị")) {
    return { bg: "bg-emerald-50", text: "text-[#059669]", border: "border-emerald-200" };
  }
  if (cat.includes("lịch sử") || cat.includes("hồi ký") || cat.includes("tự truyện")) {
    return { bg: "bg-amber-50", text: "text-[#EA580C]", border: "border-amber-200" };
  }
  if (cat.includes("tâm lý") || cat.includes("triết học") || cat.includes("kỹ năng")) {
    return { bg: "bg-violet-50", text: "text-violet-700", border: "border-violet-200" };
  }
  if (cat.includes("y học") || cat.includes("sức khỏe") || cat.includes("giáo dục")) {
    return { bg: "bg-teal-50", text: "text-teal-700", border: "border-teal-200" };
  }
  if (cat.includes("trinh thám") || cat.includes("giả tưởng") || cat.includes("khoa học")) {
    return { bg: "bg-indigo-50", text: "text-indigo-700", border: "border-indigo-200" };
  }
  if (cat.includes("nghệ thuật") || cat.includes("lãng mạn") || cat.includes("tản văn")) {
    return { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200" };
  }
  return { bg: "bg-sky-50", text: "text-[#0284C7]", border: "border-[#bfdbfe]" };
}

export const BookTableView: React.FC<BookTableViewProps> = React.memo(({
  books,
  categories,
  onDeleteBook,
  onBatchUpdateBooks,
  onSyncDriveNow,
  onOpenAddModal,
  onOpenEditModal,
  onOpenImportModal,
  onSwitchToScanner,
  onOpenSettingsKey,
  userRole,
}) => {
  const { showToast } = useToast();
  const [globalFilter, setGlobalFilter] = useState("");
  const deferredFilter = useDeferredValue(globalFilter);
  const [viewMode, setViewModeState] = useState<"list" | "grid" | "chart">(() => {
    try {
      const saved = localStorage.getItem("book_library_view_mode");
      if (saved === "list" || saved === "grid" || saved === "chart") {
        return saved;
      }
    } catch {}
    return "grid";
  });
  const setViewMode = useCallback((mode: "list" | "grid" | "chart") => {
    setViewModeState(mode);
    try {
      localStorage.setItem("book_library_view_mode", mode);
    } catch {}
  }, []);
  const [isReclassifyingCategories, setIsReclassifyingCategories] = useState(false);
  const [reclassifyProgress, setReclassifyProgress] = useState<{ processed: number; total: number } | null>(null);
  const stopReclassifyRef = useRef(false);
  const [selectedCategory, setSelectedCategory] = useState<string>("ALL");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
  };

  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Tối ưu hóa đếm số lượng sách theo danh mục trong O(N) duy nhất
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < books.length; i++) {
      const cat = (books[i].category || "Chung").trim() || "Chung";
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }, [books]);

  // Kết hợp danh sách thể loại của kho với bất kỳ thể loại nào đang có sách thực tế
  const filterCategories = useMemo(() => {
    const merged = new Set<string>(categories);
    Object.keys(categoryCounts).forEach((cat) => merged.add(cat));
    return Array.from(merged);
  }, [categories, categoryCounts]);

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

  const handleFilterChange = (val: string) => {
    setGlobalFilter(val);
  };

  const handleCategorySelect = (cat: string) => {
    setSelectedCategory(cat);
  };

  const handleSelectCategoryFromChart = useCallback((catName: string) => {
    setSelectedCategory(catName);
    setViewMode('list');
    showToast(`Đã lọc: ${catName}`, 'info');
  }, [setViewMode, showToast]);

  const handleStartReclassifyCategories = useCallback(async () => {
    if (userRole === 'VIEWER') {
      showToast('⚠️ Bạn đang ở chế độ CHỈ XEM (Viewer). Không có quyền hiệu chỉnh thể loại!', 'warning');
      return;
    }
    if (!onBatchUpdateBooks || books.length === 0) return;
    if (!(await ensureGeminiAccessAvailable())) {
      showToast('Vui lòng thêm Gemini API Key trong Cài đặt để phân loại bằng AI!', 'warning');
      onOpenSettingsKey?.();
      return;
    }

    stopReclassifyRef.current = false;
    setIsReclassifyingCategories(true);
    setReclassifyProgress({ processed: 0, total: books.length });

    try {
      const res = await reclassifyBookCategories(books, {
        categories,
        stopSignal: stopReclassifyRef,
        onChunkComplete: (_chunkUpdates, processed, total) => {
          setReclassifyProgress({ processed, total });
        },
      });

      const updateMap = new Map(res.updates.map((u) => [u.id, u.category]));
      const now = Date.now();
      const changedBooks: BookRecord[] = [];

      books.forEach((book) => {
        const nextCat = updateMap.get(book.id);
        if (nextCat && nextCat !== (book.category || 'Chung').trim()) {
          changedBooks.push({
            ...book,
            category: nextCat,
            updated_at: now,
          });
        }
      });

      if (changedBooks.length > 0) {
        await onBatchUpdateBooks(changedBooks, { skipSync: true });
        await onSyncDriveNow?.();
      }

      if (res.stopped) {
        showToast(
          changedBooks.length > 0
            ? `Đã dừng và cập nhật thể loại cho ${changedBooks.length} cuốn sách.`
            : 'Đã dừng phân loại thể loại.',
          'info'
        );
      } else if (res.failedChunks.length > 0) {
        const failedCount = res.failedChunks.reduce((acc, c) => acc + c.bookIds.length, 0);
        showToast(
          `Đã cập nhật thể loại cho ${changedBooks.length} cuốn; còn ${failedCount} cuốn chưa xử lý được.`,
          'warning'
        );
      } else if (changedBooks.length > 0) {
        showToast(`✨ Đã phân loại lại thể loại cho ${changedBooks.length} cuốn sách!`, 'success');
      } else {
        showToast('Thể loại của toàn bộ kho sách đã chuẩn xác rồi!', 'success');
      }
    } catch (err: any) {
      showToast(`Lỗi phân loại thể loại AI: ${err?.message || String(err)}`, 'error');
    } finally {
      setIsReclassifyingCategories(false);
      setReclassifyProgress(null);
      stopReclassifyRef.current = false;
    }
  }, [userRole, onBatchUpdateBooks, onSyncDriveNow, books, categories, onOpenSettingsKey, showToast]);

  const handleStopReclassifyCategories = useCallback(() => {
    stopReclassifyRef.current = true;
  }, []);

  // Xử lý phím Back Android cho các trạng thái của Bảng sách
  // 1. Nếu đang có hộp thoại xác nhận xóa sách -> Back để hủy xác nhận xóa
  useEffect(() => {
    if (!confirmDeleteId) return;
    return registerBackButtonHandler(() => {
      setConfirmDeleteId(null);
      return true;
    });
  }, [confirmDeleteId]);

  // 3. Nếu đang mở biểu đồ thống kê -> Back để quay lại chế độ danh sách
  useEffect(() => {
    if (viewMode !== 'chart') return;
    return registerBackButtonHandler(() => {
      setViewMode('list');
      return true;
    });
  }, [viewMode]);

  // 4. Nếu đang lọc theo danh mục cụ thể -> Back để quay về "Tất cả"
  useEffect(() => {
    if (selectedCategory === 'ALL') return;
    return registerBackButtonHandler(() => {
      setSelectedCategory('ALL');
      return true;
    });
  }, [selectedCategory]);

  // 5. Nếu đang nhập ô tìm kiếm -> Back để xóa ô tìm kiếm
  useEffect(() => {
    if (!globalFilter) return;
    return registerBackButtonHandler(() => {
      handleFilterChange('');
      return true;
    });
  }, [globalFilter]);

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
              type="text"
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
              className="w-full pl-9 pr-9 py-2 text-xs sm:text-sm bg-slate-50 focus:bg-white border border-slate-200 focus:border-[#0284C7] rounded-xl focus:ring-2 focus:ring-[#0284C7]/20 focus:outline-none transition font-medium [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:hidden"
            />
            {globalFilter && (
              <button
                type="button"
                onClick={() => handleFilterChange('')}
                aria-label="Xóa từ khóa tìm kiếm"
                className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center text-slate-500 hover:text-slate-800 bg-slate-200/80 hover:bg-slate-300 rounded-full transition active:scale-95 shadow-2xs cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </form>

          {/* View Switcher: Kệ bìa (đầu tiên) / Danh sách / Thể loại (sau cùng) */}
          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 shrink-0">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-lg text-xs transition cursor-pointer ${
                viewMode === 'grid'
                  ? 'bg-[#10B981] text-white shadow-xs font-bold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title="Kệ Bìa Sách"
              aria-label="Xem dạng kệ bìa sách"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-lg text-xs transition cursor-pointer ${
                viewMode === 'list'
                  ? 'bg-[#10B981] text-white shadow-xs font-bold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title="Danh Sách"
              aria-label="Xem dạng danh sách"
            >
              <LayoutList className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('chart')}
              className={`p-1.5 rounded-lg text-xs transition cursor-pointer ${
                viewMode === 'chart'
                  ? 'bg-[#10B981] text-white shadow-xs font-bold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title="Thống Kê Thể Loại"
              aria-label="Xem thống kê thể loại"
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
          viewMode !== 'chart' && (
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
                {filterCategories.map((cat) => {
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
      {viewMode !== 'chart' ? (
        <div className="space-y-2.5">
          {/* Books List or Grid Shelf */}
          <div
            className={
              viewMode === 'grid' && filteredData.length > 0
                ? 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2.5 sm:gap-3.5'
                : 'space-y-1'
            }
          >
            {filteredData.length > 0 ? (
              filteredData.map((book, idx) => {
                const displayIndex = idx + 1;
                const badgeStyle = getCategoryBadgeStyle(book.category || '');

                if (viewMode === 'grid') {
                  return (
                    <div
                      key={book.id}
                      onClick={() => onOpenEditModal?.(book)}
                      className="group bg-white border border-slate-200/90 rounded-2xl p-2 shadow-2xs hover:border-emerald-300 transition flex flex-col cursor-pointer active:scale-[0.98]"
                    >
                      <BookCover
                        coverUrl={book.cover_url}
                        title={book.title}
                        author={book.author}
                        category={book.category}
                        size="grid"
                      />
                      <div className="pt-1.5 space-y-0.5 min-w-0 flex-1 flex flex-col justify-between">
                        <h2 className="text-[11px] sm:text-xs font-extrabold text-slate-900 leading-tight line-clamp-2">
                          {book.title}
                        </h2>
                        {book.author && (
                          <p className="text-[10px] text-slate-500 font-medium truncate">
                            {book.author}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={book.id}
                    onClick={() => onOpenEditModal?.(book)}
                    className="bg-white border border-slate-200/90 rounded-xl px-2.5 py-1.5 shadow-2xs hover:border-emerald-300 active:bg-slate-50 transition cursor-pointer"
                  >
                    {/* Top Row: Index + Title + Delete Action */}
                    <div className="flex items-start justify-between gap-1.5">
                      <h2 className="text-xs sm:text-[13px] font-extrabold text-slate-900 leading-snug min-w-0 flex-1">
                        <span className="text-slate-400 font-mono font-bold mr-1">{displayIndex}.</span>
                        {book.title}
                      </h2>

                      <div
                        className="flex items-center gap-0.5 shrink-0 pt-0.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {confirmDeleteId === book.id ? (
                          <div className="flex items-center gap-1 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded-lg animate-in fade-in duration-150">
                            <span className="text-[9.5px] font-bold text-rose-700 shrink-0">Xóa?</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteBook(book.id);
                                setConfirmDeleteId(null);
                              }}
                              className="px-1.5 py-0.5 bg-rose-600 text-white rounded text-[9.5px] font-bold hover:bg-rose-700 transition cursor-pointer"
                            >
                              Có
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(null);
                              }}
                              className="px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded text-[9.5px] font-bold hover:bg-slate-300 transition cursor-pointer"
                            >
                              Không
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteId(book.id);
                            }}
                            className="p-0.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition cursor-pointer"
                            title="Xóa"
                            aria-label="Xóa sách"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
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
        </div>
      ) : (
        <CategoryBubbleChart
          books={books}
          onSelectCategory={handleSelectCategoryFromChart}
          onReclassifyCategories={onBatchUpdateBooks ? handleStartReclassifyCategories : undefined}
          onStopReclassify={handleStopReclassifyCategories}
          isReclassifying={isReclassifyingCategories}
          reclassifyProgress={reclassifyProgress}
        />
      )}
    </div>
  );
});
