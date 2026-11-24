import React, { useState, useEffect } from 'react';
import { BookOpen } from 'lucide-react';

interface BookCoverProps {
  coverUrl?: string;
  title: string;
  author?: string;
  category?: string;
  size?: 'xs' | 'sm' | 'md' | 'grid';
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}

interface CoverPalette {
  bg: string;
  spine: string;
  accent: string;
  text: string;
}

function getCoverPalette(category = '', title = ''): CoverPalette {
  const cat = category.toLowerCase();
  if (cat.includes('kinh tế') || cat.includes('kinh doanh') || cat.includes('quản trị')) {
    return {
      bg: 'from-emerald-700 to-teal-900',
      spine: 'bg-emerald-950/35',
      accent: 'border-emerald-300/35',
      text: 'text-emerald-50',
    };
  }
  if (cat.includes('lịch sử') || cat.includes('hồi ký') || cat.includes('tự truyện')) {
    return {
      bg: 'from-amber-700 to-orange-900',
      spine: 'bg-amber-950/35',
      accent: 'border-amber-200/35',
      text: 'text-amber-50',
    };
  }
  if (cat.includes('tâm lý') || cat.includes('triết học') || cat.includes('kỹ năng')) {
    return {
      bg: 'from-violet-700 to-purple-950',
      spine: 'bg-purple-950/40',
      accent: 'border-violet-200/35',
      text: 'text-violet-50',
    };
  }
  if (cat.includes('y học') || cat.includes('sức khỏe') || cat.includes('giáo dục')) {
    return {
      bg: 'from-teal-700 to-cyan-900',
      spine: 'bg-teal-950/35',
      accent: 'border-teal-200/35',
      text: 'text-teal-50',
    };
  }
  if (cat.includes('trinh thám') || cat.includes('giả tưởng') || cat.includes('khoa học')) {
    return {
      bg: 'from-indigo-700 to-slate-900',
      spine: 'bg-indigo-950/40',
      accent: 'border-indigo-200/35',
      text: 'text-indigo-50',
    };
  }
  if (cat.includes('nghệ thuật') || cat.includes('lãng mạn') || cat.includes('tản văn')) {
    return {
      bg: 'from-rose-700 to-pink-950',
      spine: 'bg-rose-950/35',
      accent: 'border-rose-200/35',
      text: 'text-rose-50',
    };
  }
  if (cat.includes('việt nam')) {
    return {
      bg: 'from-sky-700 to-blue-950',
      spine: 'bg-sky-950/35',
      accent: 'border-sky-200/35',
      text: 'text-sky-50',
    };
  }

  // Fallback hash theo tên sách để màu sắc đa dạng tự nhiên
  const palettes: CoverPalette[] = [
    { bg: 'from-sky-700 to-slate-900', spine: 'bg-slate-950/35', accent: 'border-sky-200/30', text: 'text-sky-50' },
    { bg: 'from-emerald-700 to-slate-900', spine: 'bg-slate-950/35', accent: 'border-emerald-200/30', text: 'text-emerald-50' },
    { bg: 'from-amber-700 to-stone-900', spine: 'bg-stone-950/35', accent: 'border-amber-200/30', text: 'text-amber-50' },
    { bg: 'from-indigo-700 to-slate-900', spine: 'bg-slate-950/35', accent: 'border-indigo-200/30', text: 'text-indigo-50' },
  ];
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) | 0;
  return palettes[Math.abs(hash) % palettes.length];
}

const SIZE_CLASSES: Record<NonNullable<BookCoverProps['size']>, string> = {
  xs: 'w-8 h-11 rounded-md',
  sm: 'w-11 h-[62px] rounded-lg',
  md: 'w-20 h-[112px] rounded-xl',
  grid: 'w-full aspect-[3/4] rounded-xl',
};

export const BookCover: React.FC<BookCoverProps> = ({
  coverUrl,
  title,
  author,
  category,
  size = 'sm',
  className = '',
  onClick,
}) => {
  const cleanUrl = (coverUrl || '').trim();
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [cleanUrl]);

  const isExplicitNone = cleanUrl.toUpperCase() === 'NONE';
  const showImage = Boolean(cleanUrl) && !isExplicitNone && !hasError;
  const palette = getCoverPalette(category, title);
  const initialLetter = (title || 'S').trim().charAt(0).toUpperCase();

  return (
    <div
      onClick={onClick}
      className={`relative overflow-hidden shrink-0 select-none bg-slate-100 shadow-xs ring-1 ring-slate-900/10 ${SIZE_CLASSES[size]} ${
        onClick ? 'cursor-pointer active:scale-95 transition-transform' : ''
      } ${className}`}
    >
      {showImage ? (
        <>
          <img
            src={cleanUrl}
            alt={title}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setHasError(true)}
            className="w-full h-full object-cover"
          />
          {/* Subtle spine crease highlight for real book depth */}
          <div className="pointer-events-none absolute inset-y-0 left-0 w-1.5 bg-gradient-to-r from-black/25 via-white/15 to-transparent" />
        </>
      ) : (
        <div className={`w-full h-full bg-gradient-to-br ${palette.bg} ${palette.text} relative flex flex-col justify-between p-1.5`}>
          {/* Spine shadow */}
          <div className={`pointer-events-none absolute inset-y-0 left-0 w-1.5 ${palette.spine}`} />
          <div className={`pointer-events-none absolute inset-1 border ${palette.accent} rounded-[4px] opacity-60`} />

          {size === 'grid' || size === 'md' ? (
            <>
              <div className="relative z-10 flex items-center justify-between pl-1">
                <BookOpen className="w-3 h-3 opacity-75" />
                {category && size === 'grid' && (
                  <span className="text-[8px] font-bold uppercase tracking-wider opacity-75 truncate max-w-[75%]">
                    {category}
                  </span>
                )}
              </div>
              <div className="relative z-10 pl-1 my-auto">
                <div
                  className={`${
                    size === 'grid' ? 'text-[11px] leading-tight' : 'text-[9.5px] leading-tight'
                  } font-extrabold line-clamp-3 drop-shadow-xs`}
                >
                  {title}
                </div>
              </div>
              {author && (
                <div className="relative z-10 pl-1 text-[8.5px] font-medium opacity-80 truncate">
                  {author}
                </div>
              )}
            </>
          ) : (
            <div className="relative z-10 m-auto flex flex-col items-center justify-center pl-0.5">
              <span className="text-sm font-black tracking-tight leading-none opacity-95">
                {initialLetter}
              </span>
              <BookOpen className="w-2.5 h-2.5 mt-1 opacity-70" />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
