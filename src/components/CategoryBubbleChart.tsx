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
}

// Bảng màu Gáy Sách Đa Sắc Tươi Sáng & Sang Trọng (Tối ưu cho nền sáng)
const LIGHT_SHELF_BOOK_PALETTES: { bg: string; accent: string; text: string }[] = [
  { bg: '#059669', accent: '#a7f3d0', text: '#ffffff' }, // Emerald Green
  { bg: '#2563eb', accent: '#bfdbfe', text: '#ffffff' }, // Royal Blue
  { bg: '#dc2626', accent: '#fecaca', text: '#ffffff' }, // Crimson Red
  { bg: '#d97706', accent: '#fde68a', text: '#ffffff' }, // Amber Ochre
  { bg: '#7c3aed', accent: '#ddd6fe', text: '#ffffff' }, // Amethyst Purple
  { bg: '#0891b2', accent: '#cffaff', text: '#ffffff' }, // Ocean Cyan
  { bg: '#ea580c', accent: '#ffedd5', text: '#ffffff' }, // Terracotta Orange
  { bg: '#0d9488', accent: '#ccfbf1', text: '#ffffff' }, // Dark Teal
  { bg: '#4f46e5', accent: '#c7d2fe', text: '#ffffff' }, // Indigo Velvet
  { bg: '#db2777', accent: '#fbcfe8', text: '#ffffff' }, // Rose Pink
  { bg: '#65a30d', accent: '#ecfccb', text: '#ffffff' }, // Olive Lime
  { bg: '#c026d3', accent: '#fae8ff', text: '#ffffff' }, // Fuchsia Magenta
  { bg: '#16a34a', accent: '#bbf7d0', text: '#ffffff' }, // Forest Green
  { bg: '#0284c7', accent: '#bae6fd', text: '#ffffff' }, // Sapphire
  { bg: '#ca8a04', accent: '#fef08a', text: '#ffffff' }, // Warm Yellow
  { bg: '#9333ea', accent: '#f3e8ff', text: '#ffffff' }, // Violet
];

export const CategoryBubbleChart: React.FC<CategoryBubbleChartProps> = ({
  books,
  onSelectCategory,
}) => {
  // Thống kê danh mục và chia các tầng kệ sách
  const { shelves, totalBooks, totalCategories, topCategory } = useMemo(() => {
    const counts: Record<string, number> = {};
    const total = books.length;

    books.forEach((b) => {
      const cat = (b.category || 'Chung').trim() || 'Chung';
      counts[cat] = (counts[cat] || 0) + 1;
    });

    const items = Object.entries(counts)
      .map(([category, count], idx) => {
        const palette = LIGHT_SHELF_BOOK_PALETTES[idx % LIGHT_SHELF_BOOK_PALETTES.length];

        // Độ rộng gáy sách tỉ lệ với số lượng (từ 34px đến 76px)
        const minW = 34;
        const maxW = 76;
        const normalizedW = Math.min(1, Math.max(0, (count - 1) / 75));
        const width = Math.round(minW + normalizedW * (maxW - minW));

        // Chiều cao biến thiên tự nhiên (120px - 150px)
        const height = 120 + (idx % 4) * 8 + (count > 25 ? 6 : 0);

        return {
          id: `book_spine_${idx}_${encodeURIComponent(category)}`,
          category,
          count,
          spineColor: palette.bg,
          accentColor: palette.accent,
          textColor: palette.text,
          height,
          width,
        };
      })
      .sort((a, b) => b.count - a.count);

    // Chia thành các tầng kệ sách đều đặn (mỗi tầng chứa 1/3 số thể loại)
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
        {/* Nút 1: Tổng số sách */}
        <div className="bg-emerald-600 text-white rounded-xl py-2 px-2.5 shadow-xs flex items-center justify-between transition active:scale-95">
          <div className="flex items-center gap-1.5 min-w-0">
            <BookOpen className="w-3.5 h-3.5 shrink-0 opacity-90" />
            <span className="text-xs font-bold tracking-tight whitespace-nowrap">
              {totalBooks} cuốn
            </span>
          </div>
        </div>

        {/* Nút 2: Số lượng thể loại */}
        <div className="bg-indigo-600 text-white rounded-xl py-2 px-2.5 shadow-xs flex items-center justify-between transition active:scale-95">
          <div className="flex items-center gap-1.5 min-w-0">
            <Layers className="w-3.5 h-3.5 shrink-0 opacity-90" />
            <span className="text-xs font-bold tracking-tight whitespace-nowrap">
              {totalCategories} thể loại
            </span>
          </div>
        </div>

        {/* Nút 3: Mũi tên + số sách thể loại nhiều nhất */}
        <div className="bg-amber-600 text-white rounded-xl py-2 px-2.5 shadow-xs flex items-center justify-between transition active:scale-95">
          <div className="flex items-center gap-1 min-w-0">
            <ArrowUpRight className="w-4 h-4 shrink-0 font-extrabold" />
            <span className="text-xs font-bold tracking-tight whitespace-nowrap">
              {topCategory ? `${topCategory.count} cuốn` : '0 cuốn'}
            </span>
          </div>
        </div>
      </div>

      {/* Container Kệ Sách Nền Sáng (Chạm vào gáy sách để chuyển ngay tới thể loại đó) */}
      <div className="bg-amber-50/40 rounded-2xl p-3 sm:p-4 border border-amber-200/80 shadow-xs relative overflow-hidden space-y-4">
        {shelves.map((shelf, shelfIdx) => (
          <div key={`shelf_${shelfIdx}`} className="relative pt-1">
            {/* Các Tập Sách xếp dọc trên Kệ */}
            <div className="flex items-end justify-center gap-1.5 px-1 min-h-[155px] overflow-x-auto no-scrollbar scroll-smooth">
              {shelf.map((book) => (
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
                  {/* Băng Dán Trang (Bookmark Ribbon) */}
                  <div
                    className="absolute -top-2 right-1.5 w-1.5 h-3 rounded-b-xs shadow-xs z-20"
                    style={{ backgroundColor: book.accentColor }}
                  />

                  {/* Đường Gân Gáy Sách Phía Trên */}
                  <div className="w-full space-y-1 opacity-35">
                    <div className="w-full h-0.5 bg-white" />
                    <div className="w-full h-0.5 bg-black/20" />
                  </div>

                  {/* Tên Thể Loại Viết Dọc */}
                  <div className="flex-1 flex items-center justify-center my-1 overflow-hidden w-full">
                    <span
                      className="text-[11px] font-bold tracking-wide truncate max-h-[95px] text-center"
                      style={{
                        writingMode: 'vertical-rl',
                        textTransform: 'uppercase',
                        color: book.textColor,
                        letterSpacing: '0.03em',
                        textShadow: '0px 1px 2px rgba(0,0,0,0.3)',
                      }}
                    >
                      {book.category}
                    </span>
                  </div>

                  {/* Con số số lượng trên gáy sách */}
                  <div
                    className="w-full py-0.5 rounded-xs text-[10px] font-black text-center text-slate-900 shadow-2xs"
                    style={{ backgroundColor: book.accentColor }}
                  >
                    {book.count}
                  </div>

                  {/* Đường Gân Gáy Sách Phía Dưới */}
                  <div className="w-full mt-1 opacity-35">
                    <div className="w-full h-0.5 bg-white" />
                  </div>
                </div>
              ))}
            </div>

            {/* Tấm Kệ Sách Gỗ Sáng Màu (Oak Wood Shelf Board) */}
            <div className="relative w-full mt-0">
              <div className="h-3.5 bg-gradient-to-r from-amber-200 via-amber-100 to-amber-200 rounded-xs shadow-inner border-t border-amber-300/80 flex items-center px-3 justify-between">
                <div className="w-1.5 h-1 bg-amber-400/60 rounded-full" />
                <div className="w-1.5 h-1 bg-amber-400/60 rounded-full" />
              </div>
              <div className="h-1.5 bg-amber-900/10 rounded-b-sm shadow-xs" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
