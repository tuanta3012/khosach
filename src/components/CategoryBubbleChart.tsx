import React, { useMemo } from 'react';
import { BookRecord } from '../types';
import { BookOpen, Layers, ArrowUpRight, Sparkles, Loader2, Square } from 'lucide-react';

interface CategoryBubbleChartProps {
  books: BookRecord[];
  onSelectCategory: (category: string) => void;
  onReclassifyCategories?: () => Promise<void>;
  onStopReclassify?: () => void;
  isReclassifying?: boolean;
  reclassifyProgress?: { processed: number; total: number } | null;
}

interface HorizontalBookTagItem {
  id: string;
  category: string;
  count: number;
  spineColor: string;
  accentColor: string;
  textColor: string;
}

// Bảng màu các cuốn sách chủ đạo từ App Icon + các sắc thái trang nhã
const BRAND_SHELF_BOOK_PALETTES: { bg: string; accent: string; text: string }[] = [
  { bg: '#0284C7', accent: '#bae6fd', text: '#ffffff' }, // Ocean Blue
  { bg: '#10B981', accent: '#a7f3d0', text: '#ffffff' }, // Emerald Green
  { bg: '#EA580C', accent: '#ffedd5', text: '#ffffff' }, // Warm Orange
  { bg: '#653f96', accent: '#e9d5ff', text: '#ffffff' }, // Royal Violet
  { bg: '#295588', accent: '#bfdbfe', text: '#ffffff' }, // Denim Navy
  { bg: '#0f766e', accent: '#99f6e4', text: '#ffffff' }, // Teal Emerald
  { bg: '#7c2d12', accent: '#fed7aa', text: '#ffffff' }, // Terracotta
  { bg: '#4c1d95', accent: '#ddd6fe', text: '#ffffff' }, // Deep Purple
];

export const CategoryBubbleChart: React.FC<CategoryBubbleChartProps> = React.memo(({
  books,
  onSelectCategory,
  onReclassifyCategories,
  onStopReclassify,
  isReclassifying = false,
  reclassifyProgress = null,
}) => {
  const { categoryTags, totalBooks, totalCategories, topCategory } = useMemo(() => {
    const counts: Record<string, number> = {};
    const total = books.length;

    books.forEach((b) => {
      const cat = (b.category || 'Chung').trim() || 'Chung';
      counts[cat] = (counts[cat] || 0) + 1;
    });

    const items: HorizontalBookTagItem[] = Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'vi'))
      .map(([category, count], idx) => {
        const palette = BRAND_SHELF_BOOK_PALETTES[idx % BRAND_SHELF_BOOK_PALETTES.length];
        return {
          id: `book_tag_${idx}_${encodeURIComponent(category)}`,
          category,
          count,
          spineColor: palette.bg,
          accentColor: palette.accent,
          textColor: palette.text,
        };
      });

    return {
      categoryTags: items,
      totalBooks: total,
      totalCategories: items.length,
      topCategory: items[0],
    };
  }, [books]);

  const progressPercent = reclassifyProgress && reclassifyProgress.total > 0
    ? Math.min(100, Math.round((reclassifyProgress.processed / reclassifyProgress.total) * 100))
    : 0;

  return (
    <div className="space-y-3 animate-in fade-in duration-300">
      {/* 3 Nút Thống Kê Thu Nhỏ Gọn Phía Trên */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-[#0284C7] text-white rounded-xl py-2 px-2.5 shadow-xs flex items-center justify-between transition active:scale-95">
          <div className="flex items-center gap-1.5 min-w-0">
            <BookOpen className="w-3.5 h-3.5 shrink-0 opacity-90" />
            <span className="text-xs font-bold tracking-tight whitespace-nowrap">
              {totalBooks} cuốn
            </span>
          </div>
        </div>

        <div className="bg-[#10B981] text-white rounded-xl py-2 px-2.5 shadow-xs flex items-center justify-between transition active:scale-95">
          <div className="flex items-center gap-1.5 min-w-0">
            <Layers className="w-3.5 h-3.5 shrink-0 opacity-90" />
            <span className="text-xs font-bold tracking-tight whitespace-nowrap">
              {totalCategories} thể loại
            </span>
          </div>
        </div>

        <div
          onClick={() => topCategory && onSelectCategory(topCategory.category)}
          title={topCategory ? `Lọc thể loại ${topCategory.category}` : ''}
          className="bg-[#EA580C] hover:bg-[#c2410c] text-white rounded-xl py-2 px-2.5 shadow-xs flex items-center justify-between transition active:scale-95 cursor-pointer"
        >
          <div className="flex items-center gap-1 min-w-0">
            <ArrowUpRight className="w-4 h-4 shrink-0 font-extrabold" />
            <span className="text-xs font-bold tracking-tight truncate">
              {topCategory ? `${topCategory.category} (${topCategory.count})` : '0 cuốn'}
            </span>
          </div>
        </div>
      </div>

      {/* Container Thẻ Thể Loại Hình Quyển Sách Nằm Ngang (Không Kệ) + Nút AI Góc Phải Trên */}
      <div className="bg-amber-50/40 rounded-2xl p-3 sm:p-4 border border-amber-200/80 shadow-xs relative space-y-3">
        {/* Header của khung thể loại với nút AI ở góc phải trên */}
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-amber-200/60">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-extrabold text-amber-950/85 tracking-tight">
              Thể loại sách
            </span>
            <span className="text-[10px] font-medium text-amber-800/70 hidden sm:inline">
              (Chạm vào sách để lọc)
            </span>
          </div>

          {onReclassifyCategories && (
            isReclassifying ? (
              <button
                type="button"
                onClick={onStopReclassify}
                title="Dừng phân loại thể loại"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-amber-100 hover:bg-amber-200 active:scale-95 text-amber-900 border border-amber-300 text-[11px] font-extrabold shadow-2xs transition cursor-pointer shrink-0"
              >
                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-700" />
                <span>Dừng</span>
                <Square className="w-2.5 h-2.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onReclassifyCategories}
                disabled={books.length === 0}
                title="Dùng AI hiệu chỉnh lại phần thể loại của toàn bộ kho sách"
                aria-label="Hiệu chỉnh thể loại toàn bộ kho sách bằng AI"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-50 hover:bg-emerald-100 active:scale-95 text-[#059669] border border-emerald-300/90 text-[11px] font-extrabold shadow-2xs transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>AI</span>
              </button>
            )
          )}
        </div>

        {/* Thanh tiến độ khi đang phân loại lại thể loại toàn bộ kho sách */}
        {isReclassifying && reclassifyProgress && (
          <div className="bg-white/90 border border-emerald-200 rounded-xl px-3 py-2 space-y-1.5 animate-in fade-in duration-200">
            <div className="flex items-center justify-between text-[11px] font-bold text-emerald-800">
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600" />
                <span>Đang phân loại lại thể loại bằng AI...</span>
              </span>
              <span className="font-mono text-emerald-700">
                {reclassifyProgress.processed}/{reclassifyProgress.total} ({progressPercent}%)
              </span>
            </div>
            <div className="w-full h-1.5 bg-emerald-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#10B981] transition-all duration-300 rounded-full"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Danh sách các cuốn sách nằm ngang xếp kiểu Tag */}
        {categoryTags.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-0.5">
            {categoryTags.map((book) => (
              <button
                key={book.id}
                type="button"
                onClick={() => onSelectCategory(book.category)}
                style={{ backgroundColor: book.spineColor }}
                className="relative inline-flex items-stretch rounded-l-sm rounded-r-lg cursor-pointer transition-all duration-150 shadow-xs border-t border-b border-white/25 border-r-[3px] border-r-amber-100/95 select-none group hover:-translate-y-0.5 hover:shadow-md hover:ring-2 hover:ring-amber-400/80 active:scale-95 text-left max-w-full"
              >
                {/* Bookmark Ribbon nhỏ phía trên mép phải của cuốn sách */}
                <span
                  className="absolute -top-1 right-2.5 w-1.5 h-2 rounded-b-xs shadow-2xs z-10 pointer-events-none"
                  style={{ backgroundColor: book.accentColor }}
                />

                {/* Gáy sách bên trái với đường chỉ gáy */}
                <span className="w-2.5 sm:w-3 shrink-0 rounded-l-sm bg-black/15 border-r border-white/25 flex flex-col justify-between py-1.5 px-0.5">
                  <span className="w-full h-[1.5px] bg-white/40 rounded-full" />
                  <span className="w-full h-[1.5px] bg-white/40 rounded-full" />
                </span>

                {/* Thân sách nằm ngang với tên thể loại & số lượng */}
                <span className="relative flex items-center gap-2 py-1.5 pl-2.5 pr-2 min-w-0">
                  <span className="absolute inset-x-2 top-0.5 h-[1px] bg-white/20 pointer-events-none" />
                  <span
                    className="text-xs font-extrabold tracking-tight leading-snug"
                    style={{
                      color: book.textColor,
                      textShadow: '0px 1px 1.5px rgba(0,0,0,0.35)',
                    }}
                  >
                    {book.category}
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded-xs text-[10px] font-black text-slate-900 shadow-2xs shrink-0 leading-none"
                    style={{ backgroundColor: book.accentColor }}
                  >
                    {book.count}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-xs font-medium text-slate-400">
            Chưa có sách nào trong kho để phân loại thể loại.
          </div>
        )}
      </div>
    </div>
  );
});
