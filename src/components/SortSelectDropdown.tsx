import React, { useState, useRef, useEffect } from 'react';
import {
  Clock,
  History,
  ArrowDownAZ,
  ArrowUpZA,
  Check,
} from 'lucide-react';

export type BookSortOption = 'newest' | 'title_asc' | 'oldest' | 'title_desc';

interface SortSelectDropdownProps {
  value: BookSortOption;
  onChange: (sort: BookSortOption) => void;
  className?: string;
}

export const SORT_OPTIONS: {
  id: BookSortOption;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'newest', label: 'Mới nhất', icon: Clock },
  { id: 'title_asc', label: 'A → Z', icon: ArrowDownAZ },
  { id: 'oldest', label: 'Cũ nhất', icon: History },
  { id: 'title_desc', label: 'Z → A', icon: ArrowUpZA },
];

export const SortSelectDropdown: React.FC<SortSelectDropdownProps> = ({
  value,
  onChange,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isOpen]);

  const selectedItem = SORT_OPTIONS.find((s) => s.id === value) || SORT_OPTIONS[0];
  const CurrentIcon = selectedItem.icon;

  const handleSelect = (sortId: BookSortOption) => {
    onChange(sortId);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="h-7 w-7 bg-white hover:bg-slate-50 border border-slate-300 hover:border-slate-400 focus:border-[#0284C7] focus:ring-2 focus:ring-[#0284C7]/20 rounded-full text-slate-700 transition-all flex items-center justify-center shadow-2xs cursor-pointer select-none active:scale-95 shrink-0"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={`Sắp xếp: ${selectedItem.label}`}
        aria-label={`Sắp xếp: ${selectedItem.label}`}
      >
        <CurrentIcon className="w-3.5 h-3.5 text-[#0284C7] shrink-0" />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-1.5 w-36 bg-white border border-slate-200 rounded-xl shadow-xl z-50 p-1 space-y-0.5 animate-in fade-in zoom-in-95 duration-100">
          {SORT_OPTIONS.map((opt) => {
            const isSelected = opt.id === value;
            const IconComponent = opt.icon;

            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleSelect(opt.id)}
                className={`w-full px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all text-left flex items-center justify-between cursor-pointer active:scale-95 ${
                  isSelected
                    ? 'bg-sky-50 text-[#0284C7] font-black'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <IconComponent
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isSelected ? 'text-[#0284C7]' : 'text-slate-400'
                    }`}
                  />
                  <span className="truncate">{opt.label}</span>
                </div>
                {isSelected && (
                  <Check className="w-3.5 h-3.5 text-[#0284C7] stroke-[3] shrink-0 ml-1.5" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
