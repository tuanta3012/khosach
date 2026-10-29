import React, { useMemo } from 'react';
import { BookRecord } from '../types';
import { BookOpen, Layers, ArrowUpRight } from 'lucide-react';

interface CategoryBubbleChartProps {
  books: BookRecord[];
  onSelectCategory: (category: string) => void;
}

interface ShelfBookItem {
  id: string;
  category: string;
  count: number;
  spineColor: string;
  accentColor: string;
  textColor: string;
  height: number;
  width: number;
  displayName: string;
  fontSize: string;
}

// Bảng màu 5 cuốn sách chủ đạo từ App Icon + các sắc thái trang nhã
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

function formatCategorySpineText(rawCategory: string): { displayName: string; fontSize: string } {
  const cat = (rawCategory || 'Chung').trim();

  const smartAbbreviations: Record<string, string> = {
    'Văn học Việt Nam': 'VH Việt Nam',
    'Văn học nước ngoài': 'VH Nước Ngoài',
    'Văn học thiếu nhi': 'VH Thiếu Nhi',
    'Văn học kinh điển': 'VH Kinh Điển',
    'Tâm lý / Phát triển bản thân': 'Tâm Lý - Phát Triển',
    'Tâm lý - Phát triển bản thân': 'Tâm Lý - Phát Triển',
    'Tâm lý / Phát triển': 'Tâm Lý - Phát Triển',
    'Kỹ năng sống & Phát triển': 'Kỹ Năng Sống',
    'Kinh tế / Quản trị': 'Kinh Tế - Quản Trị',
    'Kinh tế - Đầu tư': 'Kinh Tế - Đầu Tư',
    'Trinh thám / Ly kỳ': 'Trinh Thám - Ly Kỳ',
    'Giả tưởng / Kỳ ảo': 'Giả Tưởng - Kỳ Ảo',
    'Tản văn / Tùy bút': 'Tản Văn - Tùy Bút',
    'Hồi ký / Tự truyện': 'Hồi Ký - Tự Truyện',
    'Triết học & Tâm linh': 'Triết Học - Tâm Linh',
    'Truyện tranh / Manga / Comic': 'Truyện Tranh - Manga',
  };

  let formatted = smartAbbreviations[cat] || cat;

  if (formatted.length > 18) {
    formatted = formatted
      .replace(/Văn [Hh]ọc/g, 'VH')
      .replace(/Kỹ [Nn]ăng/g, 'KN')
      .replace(/Phát [Tt]riển/g, 'PT')
      .replace(/\s*\/\s*/g, ' - ');
  }

  formatted = formatted.toUpperCase();
  const len = formatted.length;
  let fontSize = '10.5px';

  if (len <= 7) {
    fontSize = '11.5px';
  } else if (len <= 12) {
    fontSize = '10px';
  } else if (len <= 16) {
    fontSize = '9px';
  } else if (len <= 22) {
    fontSize = '8px';
  } else {
    fontSize = '7.5px';
  }

  return { displayName: formatted, fontSize };
}

export const CategoryBubbleChart: React.FC<CategoryBubbleChartProps> = React.memo(({
  books,
  onSelectCategory,
}) => {
  const { shelves, totalBooks, totalCategories, topCategory } = useMemo(() => {
    const counts: Record<string, number> = {};
    const total = books.length;

    books.forEach((b) => {
      const cat = (b.category || 'Chung').trim() || 'Chung';
      counts[cat] = (counts[cat] || 0) + 1;
    });

    const items = Object.entries(counts)
      .map(([category, count], idx) => {
        const palette = BRAND_SHELF_BOOK_PALETTES[idx % BRAND_SHELF_BOOK_PALETTES.length];

        const minW = 38;
        const maxW = 62;
        const normalizedW = Math.min(1, Math.max(0, (count - 1) / 75));
        const width = Math.round(minW + normalizedW * (maxW - minW));
        const height = 135 + (idx % 4) * 8 + (count > 25 ? 6 : 0);

        const { displayName, fontSize } = formatCategorySpineText(category);

        return {
          id: `book_spine_${idx}_${encodeURIComponent(category)}`,
          category,
          count,
          spineColor: palette.bg,
          accentColor: palette.accent,
          textColor: palette.text,
          height,
          width,
          displayName,
          fontSize,
        };
      })
      .sort((a, b) => b.count - a.count);

    const shelf1: ShelfBookItem[] = [];
    const shelf2: ShelfBookItem[] = [];
    const shelf3: ShelfBookItem[] = [];

    items.forEach((item, index) => {
      if (index % 3 === 0) shelf1.push(item);
      else if (index % 3 === 1) shelf2.push(item);
      else shelf3.push(item);
    });

    const shelvesList = [shelf1, shelf2, shelf3].filter((s) => s.length > 0);

    return {
      shelves: shelvesList,
      totalBooks: total,
      totalCategories: items.length,
      topCategory: items[0],
    };
  }, [books]);

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

      {/* Container Kệ Sách Nền Sáng */}
      <div className="bg-amber-50/40 rounded-2xl p-3 sm:p-4 border border-amber-200/80 shadow-xs relative overflow-hidden space-y-4">
        {shelves.map((shelf, shelfIdx) => (
          <div key={`shelf_${shelfIdx}`} className="relative pt-1">
            <div className="flex items-end justify-center gap-1.5 px-1 min-h-[170px] overflow-x-auto no-scrollbar scroll-smooth">
              {shelf.map((book) => {
                const maxTextLength = book.height - 44;

                return (
                  <div
                    key={book.id}
                    onClick={() => onSelectCategory(book.category)}
                    style={{
                      width: `${book.width}px`,
                      height: `${book.height}px`,
                      backgroundColor: book.spineColor,
                    }}
                    className="relative shrink-0 rounded-t-md cursor-pointer transition-all duration-200 flex flex-col items-center justify-between py-2 px-1 shadow-sm border-t border-l border-r border-white/30 select-none group hover:-translate-y-3 hover:shadow-xl hover:ring-2 hover:ring-amber-500 hover:z-30 hover:scale-105 active:scale-95 opacity-95 hover:opacity-100"
                  >
                    {/* Bookmark Ribbon */}
                    <div
                      className="absolute -top-2 right-1.5 w-1.5 h-3 rounded-b-xs shadow-xs z-20"
                      style={{ backgroundColor: book.accentColor }}
                    />

                    {/* Top Accent Line */}
                    <div className="w-full space-y-1 opacity-35">
                      <div className="w-full h-0.5 bg-white" />
                      <div className="w-full h-0.5 bg-black/20" />
                    </div>

                    {/* Category Vertical Text */}
                    <div className="flex-1 flex items-center justify-center relative my-1 overflow-hidden w-full">
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span
                          className="font-black tracking-wider whitespace-nowrap text-center transition-transform pointer-events-none"
                          style={{
                            transform: 'rotate(-90deg)',
                            color: book.textColor,
                            maxWidth: `${maxTextLength}px`,
                            fontSize: book.fontSize,
                            textShadow: '0px 1px 2px rgba(0,0,0,0.5)',
                          }}
                        >
                          {book.displayName}
                        </span>
                      </div>
                    </div>

                    {/* Count Badge on Spine */}
                    <div
                      className="w-full py-0.5 rounded-xs text-[10px] font-black text-center text-slate-900 shadow-2xs z-10"
                      style={{ backgroundColor: book.accentColor }}
                    >
                      {book.count}
                    </div>

                    {/* Bottom Accent Line */}
                    <div className="w-full mt-1 opacity-35">
                      <div className="w-full h-0.5 bg-white" />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Honey Sand Wood Shelf Plank */}
            <div className="relative w-full mt-0">
              <div className="h-3.5 bg-gradient-to-r from-amber-300 via-amber-200 to-amber-300 rounded-xs shadow-inner border-t border-amber-400/80 flex items-center px-3 justify-between">
                <div className="w-1.5 h-1 bg-amber-500/60 rounded-full" />
                <div className="w-1.5 h-1 bg-amber-500/60 rounded-full" />
              </div>
              <div className="h-1.5 bg-amber-900/10 rounded-b-sm shadow-xs" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
