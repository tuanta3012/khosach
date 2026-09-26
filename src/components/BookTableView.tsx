import React, { useState, useMemo, useRef } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  SortingState,
  ColumnDef,
  flexRender,
} from '@tanstack/react-table';
import {
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Edit2,
  Check,
  X,
  Plus,
  Trash2,
  FileSpreadsheet,
  Download,
  Upload,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Database,
  LayoutList,
  Table as TableIcon,
  MoreVertical,
  User,
  Building,
  Sparkles,
} from 'lucide-react';
import { BookRecord } from '../types';
import { removeVietnameseTones, stringSimilarity } from '../utils/fuzzyMatcher';
import { exportBooksToExcel, exportBooksToCsv } from '../utils/backupService';
import { useToast } from '../context/ToastContext';

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
  onOpenAddModal,
  onOpenImportModal,
  onResetMasterData,
}) => {
  const { showToast } = useToast();
  const [globalFilter, setGlobalFilter] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'table'>('list');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'title', desc: false },
  ]);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editingValues, setEditingValues] = useState<Partial<BookRecord>>({});
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

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

    for (const book of result) {
      const normTitle = removeVietnameseTones(book.title || '');
      const normAuthor = removeVietnameseTones(book.author || '');
      const normPublisher = removeVietnameseTones(book.publisher || '');
      const normCat = removeVietnameseTones(book.category || '');

      let score = 0;

      // Khớp chính xác hoàn toàn hoặc bắt đầu bằng từ khóa
      if (normTitle === normQuery) {
        score += 100;
      } else if (normTitle.startsWith(normQuery)) {
        score += 85;
      } else if (normTitle.includes(normQuery)) {
        score += 70;
      } else {
        // Kiểm tra khớp từng từ
        const allWordsInTitle = queryWords.every((w) => normTitle.includes(w));
        if (allWordsInTitle) {
          score += 60;
        } else {
          let matchedCount = 0;
          for (const w of queryWords) {
            if (normTitle.includes(w) || normAuthor.includes(w)) {
              matchedCount++;
            }
          }
          if (matchedCount > 0) {
            score += Math.round((matchedCount / queryWords.length) * 45);
          } else {
            // Fuzzy similarity fallback (cho từ gõ sai/gần đúng)
            const titleSim = stringSimilarity(normQuery, normTitle);
            if (titleSim >= 0.45) {
              score += Math.round(titleSim * 35);
            }
          }
        }
      }

      // Khớp Tác Giả, Thể loại, NXB
      if (normAuthor.includes(normQuery)) score += 40;
      if (normCat.includes(normQuery)) score += 20;
      if (normPublisher.includes(normQuery)) score += 15;

      if (score > 0) {
        scored.push({ book, score });
      }
    }

    // Sắp xếp theo độ khớp giảm dần
    scored.sort((a, b) => b.score - a.score);

    return scored.map((item) => item.book);
  }, [books, globalFilter, selectedCategory]);

  const handleFocusSearch = () => {
    setIsSearchFocused(true);
    // Cuộn nhẹ lên đầu để nhường tối đa không gian cho kết quả khi bàn phím ảo bật lên
    if (searchContainerRef.current) {
      searchContainerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleStartEdit = (book: BookRecord) => {
    setEditingRowId(book.id);
    setEditingValues({
      title: book.title,
      author: book.author,
      category: book.category || 'Chung',
      publisher: book.publisher || '',
    });
  };

  const handleCancelEdit = () => {
    setEditingRowId(null);
    setEditingValues({});
  };

  const handleSaveInline = async (originalBook: BookRecord) => {
    try {
      const updatedBook: BookRecord = {
        ...originalBook,
        ...editingValues,
        updated_at: Date.now(),
      };
      await onSaveBook(updatedBook);
      setEditingRowId(null);
      setEditingValues({});
      showToast('Đã cập nhật sách!', 'success');
    } catch {
      showToast('Lỗi khi lưu cập nhật', 'error');
    }
  };

  const handleResetData = async () => {
    if (!onResetMasterData) return;
    if (
      window.confirm(
        'Bạn có chắc chắn muốn nạp lại 100% dữ liệu gốc (591 cuốn sách) vào Firestore?'
      )
    ) {
      try {
        setIsResetting(true);
        await onResetMasterData();
        showToast('Đã nạp 591 cuốn sách gốc thành công!', 'success');
      } catch {
        showToast('Lỗi khi nạp dữ liệu gốc', 'error');
      } finally {
        setIsResetting(false);
      }
    }
  };

  const columns = useMemo<ColumnDef<BookRecord>[]>(
    () => [
      {
        id: 'index',
        header: '#',
        cell: (info) => (
          <span className="text-[11px] font-mono text-slate-400 font-semibold">
            {info.row.index + 1}
          </span>
        ),
        size: 40,
        enableSorting: false,
      },
      {
        accessorKey: 'title',
        header: ({ column }) => (
          <button
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
            className="flex items-center gap-1 font-bold text-slate-800 hover:text-emerald-700 transition"
          >
            <span>Tên Sách</span>
            {column.getIsSorted() === 'asc' ? (
              <ArrowUp className="w-3 h-3 text-emerald-600" />
            ) : column.getIsSorted() === 'desc' ? (
              <ArrowDown className="w-3 h-3 text-emerald-600" />
            ) : (
              <ArrowUpDown className="w-3 h-3 text-slate-400 opacity-60" />
            )}
          </button>
        ),
        cell: ({ row }) => {
          const isEditing = editingRowId === row.original.id;
          if (isEditing) {
            return (
              <input
                type="text"
                value={editingValues.title ?? row.original.title}
                onChange={(e) =>
                  setEditingValues((prev) => ({ ...prev, title: e.target.value }))
                }
                className="w-full px-2 py-1 text-xs font-semibold text-slate-900 bg-white border border-emerald-500 rounded focus:ring-1 focus:ring-emerald-400 focus:outline-none"
                autoFocus
              />
            );
          }
          return (
            <span className="text-xs font-bold text-slate-900 leading-snug line-clamp-2">
              {row.original.title}
            </span>
          );
        },
      },
      {
        accessorKey: 'author',
        header: ({ column }) => (
          <button
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
            className="flex items-center gap-1 font-bold text-slate-800 hover:text-emerald-700 transition"
          >
            <span>Tác Giả</span>
            {column.getIsSorted() === 'asc' ? (
              <ArrowUp className="w-3 h-3 text-emerald-600" />
            ) : column.getIsSorted() === 'desc' ? (
              <ArrowDown className="w-3 h-3 text-emerald-600" />
            ) : (
              <ArrowUpDown className="w-3 h-3 text-slate-400 opacity-60" />
            )}
          </button>
        ),
        cell: ({ row }) => {
          const isEditing = editingRowId === row.original.id;
          if (isEditing) {
            return (
              <input
                type="text"
                value={editingValues.author ?? row.original.author}
                onChange={(e) =>
                  setEditingValues((prev) => ({ ...prev, author: e.target.value }))
                }
                className="w-full px-2 py-1 text-xs text-slate-800 bg-white border border-emerald-500 rounded focus:outline-none"
              />
            );
          }
          return (
            <span className="text-xs font-medium text-slate-700">
              {row.original.author || '—'}
            </span>
          );
        },
      },
      {
        accessorKey: 'category',
        header: ({ column }) => (
          <button
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
            className="flex items-center gap-1 font-bold text-slate-800 hover:text-emerald-700 transition"
          >
            <span>Thể Loại</span>
            {column.getIsSorted() === 'asc' ? (
              <ArrowUp className="w-3 h-3 text-emerald-600" />
            ) : column.getIsSorted() === 'desc' ? (
              <ArrowDown className="w-3 h-3 text-emerald-600" />
            ) : (
              <ArrowUpDown className="w-3 h-3 text-slate-400 opacity-60" />
            )}
          </button>
        ),
        cell: ({ row }) => {
          const isEditing = editingRowId === row.original.id;
          if (isEditing) {
            return (
              <input
                type="text"
                value={editingValues.category ?? row.original.category}
                onChange={(e) =>
                  setEditingValues((prev) => ({ ...prev, category: e.target.value }))
                }
                className="w-full px-2 py-1 text-xs bg-white border border-emerald-500 rounded focus:outline-none"
              />
            );
          }
          const cat = row.original.category || 'Chung';
          return (
            <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
              {cat}
            </span>
          );
        },
      },
      {
        accessorKey: 'publisher',
        header: 'NXB',
        cell: ({ row }) => {
          const isEditing = editingRowId === row.original.id;
          if (isEditing) {
            return (
              <input
                type="text"
                value={editingValues.publisher ?? row.original.publisher}
                onChange={(e) =>
                  setEditingValues((prev) => ({
                    ...prev,
                    publisher: e.target.value,
                  }))
                }
                className="w-full px-2 py-1 text-xs bg-white border border-emerald-500 rounded focus:outline-none"
              />
            );
          }
          return (
            <span className="text-[11px] text-slate-500 truncate block max-w-[120px]">
              {row.original.publisher || '—'}
            </span>
          );
        },
      },
      {
        id: 'actions',
        header: () => <span className="text-right block">Sửa</span>,
        cell: ({ row }) => {
          const isEditing = editingRowId === row.original.id;
          if (isEditing) {
            return (
              <div className="flex items-center justify-end gap-1">
                <button
                  onClick={() => handleSaveInline(row.original)}
                  className="p-1 bg-emerald-600 text-white rounded hover:bg-emerald-700 transition"
                  title="Lưu"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={handleCancelEdit}
                  className="p-1 bg-slate-200 text-slate-700 rounded hover:bg-slate-300 transition"
                  title="Hủy"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          }
          return (
            <div className="flex items-center justify-end gap-1">
              <button
                onClick={() => handleStartEdit(row.original)}
                className="p-1 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition"
                title="Sửa nhanh"
              >
                <Edit2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      `Xóa cuốn "${row.original.title}" khỏi kho?`
                    )
                  ) {
                    onDeleteBook(row.original.id);
                  }
                }}
                className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition"
                title="Xóa"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        },
        size: 70,
        enableSorting: false,
      },
    ],
    [editingRowId, editingValues]
  );

  const table = useReactTable({
    data: filteredData,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageSize: 50,
      },
    },
  });

  const isSearching = Boolean(globalFilter.trim());

  return (
    <div className="space-y-2">
      {/* Search Bar - Sticky on top so results remain strictly visible above software keyboard */}
      <div
        ref={searchContainerRef}
        className="sticky top-14 z-30 bg-white/95 backdrop-blur-md rounded-xl border border-slate-200/90 shadow-xs p-2.5 space-y-2 transition-all"
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
              onFocus={handleFocusSearch}
              onBlur={() => setIsSearchFocused(false)}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder="Gõ tên sách, tác giả... (không dấu)"
              className="w-full pl-9 pr-8 py-2 text-xs sm:text-sm bg-slate-50 focus:bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none transition font-medium"
            />
            {globalFilter && (
              <button
                onClick={() => setGlobalFilter('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1 rounded-full bg-slate-200/70"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* View Switcher */}
          <div className="flex items-center bg-slate-100 p-1 rounded-lg border border-slate-200 shrink-0">
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-md transition ${
                viewMode === 'list'
                  ? 'bg-white text-emerald-700 shadow-xs font-bold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title="Thẻ Gọn Mobile"
            >
              <LayoutList className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 rounded-md transition ${
                viewMode === 'table'
                  ? 'bg-white text-emerald-700 shadow-xs font-bold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title="Bảng Chi Tiết"
            >
              <TableIcon className="w-4 h-4" />
            </button>
          </div>

          {/* More Actions */}
          <div className="relative shrink-0">
            <button
              onClick={() => setIsMoreMenuOpen(!isMoreMenuOpen)}
              className="p-2 text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {isMoreMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-52 bg-white border border-slate-200 rounded-xl shadow-lg py-1.5 z-30">
                {onResetMasterData && (
                  <button
                    onClick={() => {
                      setIsMoreMenuOpen(false);
                      handleResetData();
                    }}
                    disabled={isResetting}
                    className="w-full px-3 py-2 text-left text-xs font-semibold text-amber-700 hover:bg-amber-50 flex items-center gap-2"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${isResetting ? 'animate-spin' : ''}`}
                    />
                    <span>Nạp Dữ Liệu Gốc (591 cuốn)</span>
                  </button>
                )}
                <button
                  onClick={() => {
                    setIsMoreMenuOpen(false);
                    onOpenAddModal();
                  }}
                  className="w-full px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <Plus className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Thêm sách mới</span>
                </button>
                <div className="my-1 border-t border-slate-100"></div>
                <button
                  onClick={() => {
                    setIsMoreMenuOpen(false);
                    exportBooksToExcel(books);
                    showToast('Đã xuất file Excel!', 'success');
                  }}
                  className="w-full px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Xuất File Excel (.xlsx)</span>
                </button>
                <button
                  onClick={() => {
                    setIsMoreMenuOpen(false);
                    exportBooksToCsv(books);
                    showToast('Đã xuất file CSV!', 'success');
                  }}
                  className="w-full px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <Download className="w-3.5 h-3.5 text-slate-600" />
                  <span>Xuất File CSV (UTF-8)</span>
                </button>
                <button
                  onClick={() => {
                    setIsMoreMenuOpen(false);
                    onOpenImportModal();
                  }}
                  className="w-full px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <Upload className="w-3.5 h-3.5 text-indigo-600" />
                  <span>Nhập / Sao Lưu File</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Live Search Results Header or Category Horizontal Scroll */}
        {isSearching ? (
          <div className="flex items-center justify-between text-xs bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200">
            <span className="font-bold text-emerald-900 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
              <span>
                Tìm thấy <strong className="text-emerald-700 font-extrabold">{filteredData.length}</strong> cuốn gần giống
              </span>
            </span>
            <button
              onClick={() => setGlobalFilter('')}
              className="text-[11px] font-bold text-slate-500 hover:text-slate-800 underline"
            >
              Thoát tìm kiếm
            </button>
          </div>
        ) : (
          /* Categories row (hidden during search to save space) */
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none text-xs">
            <button
              onClick={() => setSelectedCategory('ALL')}
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
                  onClick={() => setSelectedCategory(cat)}
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
        )}
      </div>

      {/* Main Search Results & List View */}
      {viewMode === 'list' ? (
        /* Mobile Compact Cards View */
        <div className="space-y-1.5">
          {table.getRowModel().rows.length > 0 ? (
            table.getRowModel().rows.map((row) => {
              const book = row.original;
              const isEditing = editingRowId === book.id;

              if (isEditing) {
                return (
                  <div
                    key={book.id}
                    className="bg-emerald-50/70 border border-emerald-400 rounded-xl p-3 space-y-2 shadow-xs"
                  >
                    <div className="text-[10px] font-bold text-emerald-800 uppercase tracking-wider">
                      Sửa nhanh cuốn #{row.index + 1}
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
                        className="w-full px-2.5 py-1.5 text-xs font-bold text-slate-900 bg-white border border-emerald-500 rounded-lg focus:outline-none"
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
                          className="w-full px-2 py-1 text-xs bg-white border border-emerald-500 rounded-lg focus:outline-none"
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
                          className="w-full px-2 py-1 text-xs bg-white border border-emerald-500 rounded-lg focus:outline-none"
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
                        className="w-full px-2 py-1 text-xs bg-white border border-emerald-500 rounded-lg focus:outline-none"
                      />
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        onClick={handleCancelEdit}
                        className="px-3 py-1 bg-slate-200 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-300 transition"
                      >
                        Hủy
                      </button>
                      <button
                        onClick={() => handleSaveInline(book)}
                        className="px-3 py-1 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 transition shadow-xs"
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
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <span className="text-[10px] font-mono font-bold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded mt-0.5 shrink-0">
                        #{row.index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h2 className="text-xs sm:text-sm font-extrabold text-slate-900 leading-tight">
                          {book.title}
                        </h2>
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 mt-1 text-[11px] text-slate-600">
                          {book.author && (
                            <span className="flex items-center gap-1 font-medium">
                              <User className="w-3 h-3 text-slate-400 shrink-0" />
                              <span className="truncate">{book.author}</span>
                            </span>
                          )}
                          {book.publisher && (
                            <span className="flex items-center gap-1 text-slate-500">
                              <Building className="w-3 h-3 text-slate-400 shrink-0" />
                              <span className="truncate">{book.publisher}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <span className="px-1.5 py-0.5 bg-emerald-50 text-emerald-800 rounded text-[10px] font-bold border border-emerald-200">
                        {book.category || 'Chung'}
                      </span>
                      <button
                        onClick={() => handleStartEdit(book)}
                        className="p-1 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition"
                        title="Sửa nhanh"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          if (
                            window.confirm(
                              `Xóa cuốn "${book.title}" khỏi kho?`
                            )
                          ) {
                            onDeleteBook(book.id);
                          }
                        }}
                        className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                        title="Xóa"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="bg-white rounded-xl p-6 text-center text-slate-400 border border-slate-200 shadow-2xs">
              <Database className="w-8 h-8 mx-auto mb-2 text-slate-300 opacity-60" />
              <p className="text-xs font-semibold text-slate-600">
                Không tìm thấy cuốn sách nào khớp với từ khóa
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Thử gõ tên sách hoặc tác giả không dấu khác
              </p>
            </div>
          )}
        </div>
      ) : (
        /* Dense Table View */
        <div className="bg-white rounded-xl border border-slate-200/90 shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr
                    key={headerGroup.id}
                    className="bg-slate-100/90 border-b border-slate-200 text-[10px] text-slate-600 uppercase tracking-wider"
                  >
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        className="px-2.5 py-2 font-bold whitespace-nowrap"
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext()
                            )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-slate-100">
                {table.getRowModel().rows.length > 0 ? (
                  table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className={`hover:bg-slate-50 transition-colors ${
                        editingRowId === row.original.id ? 'bg-emerald-50/40' : ''
                      }`}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-2.5 py-2 align-middle">
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </td>
                      ))}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="py-8 text-center text-slate-400 text-xs"
                    >
                      Không tìm thấy cuốn sách nào
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination Footer */}
      <div className="bg-white rounded-xl border border-slate-200/90 p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-600 shadow-2xs">
        <div className="flex items-center justify-between sm:justify-start gap-2">
          <span>
            Hiển thị <span className="font-bold text-slate-900">{table.getRowModel().rows.length}</span> /{' '}
            <span className="font-bold text-slate-900">{filteredData.length}</span> cuốn
          </span>
          <div className="flex items-center gap-1 text-[11px]">
            <span>Mỗi trang:</span>
            <select
              value={table.getState().pagination.pageSize}
              onChange={(e) => table.setPageSize(Number(e.target.value))}
              className="bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-xs font-semibold text-slate-800"
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
            Trang <span className="font-bold text-slate-900">{table.getState().pagination.pageIndex + 1}</span> /{' '}
            <span className="font-bold text-slate-900">{table.getPageCount() || 1}</span>
          </span>

          <div className="flex items-center gap-1">
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="p-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="p-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
