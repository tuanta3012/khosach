import React, { useState, useRef, useEffect } from 'react';
import { ArrowUpDown, ChevronDown, Check } from 'lucide-react';

export type SortOption = 'maturity' | 'principal' | 'rate';

interface SortSelectDropdownProps {
  value: SortOption;
  onChange: (sort: SortOption) => void;
  className?: string;
}

const SORT_OPTIONS: { id: SortOption; label: string; desc: string }[] = [
  { id: 'maturity', label: 'Ngày đáo hạn', desc: 'Đáo hạn gần nhất xếp trước' },
  { id: 'principal', label: 'Tiền gốc', desc: 'Số tiền gửi lớn nhất xếp trước' },
  { id: 'rate', label: 'Lãi suất', desc: 'Lãi suất % cao nhất xếp trước' },
];

export const SortSelectDropdown: React.FC<SortSelectDropdownProps> = ({
  value,
  onChange,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const selectedItem = SORT_OPTIONS.find((s) => s.id === value) || SORT_OPTIONS[0];

  const handleSelect = (sortId: SortOption) => {
    onChange(sortId);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full min-h-[42px] px-3 py-2 bg-white hover:bg-slate-50 border border-slate-300 hover:border-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 rounded-xl text-xs font-semibold text-slate-900 transition-all flex items-center justify-between gap-2 shadow-2xs text-left cursor-pointer"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div className="flex items-center space-x-2 min-w-0 flex-1">
          <div className="w-6 h-6 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
            <ArrowUpDown className="w-3.5 h-3.5 text-emerald-600" />
          </div>
          <div className="truncate">
            <span className="font-bold text-slate-900 block truncate text-xs">
              {selectedItem.label}
            </span>
          </div>
        </div>

        <ChevronDown
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <>
          {/* Mobile backdrop */}
          <div
            className="fixed inset-0 bg-slate-950/40 backdrop-blur-[2px] z-40 sm:hidden"
            onClick={() => setIsOpen(false)}
          />

          <div className="fixed left-3 right-3 bottom-3 sm:bottom-auto sm:left-auto sm:right-0 sm:top-full sm:mt-1.5 sm:w-64 bg-white border border-slate-200 rounded-2xl shadow-2xl z-50 p-2 space-y-1 animate-in fade-in zoom-in-95 duration-100">
            <div className="px-2 py-1.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 mb-1 flex items-center justify-between">
              <span>Sắp xếp danh sách</span>
              <span className="text-[10px] text-slate-400 font-normal">Xếp theo tiêu chí</span>
            </div>

            {SORT_OPTIONS.map((opt) => {
              const isSelected = opt.id === value;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleSelect(opt.id)}
                  className={`w-full px-3 py-2.5 rounded-xl text-xs font-bold transition-all text-left flex items-center justify-between cursor-pointer ${
                    isSelected
                      ? 'bg-emerald-50 text-emerald-900 border border-emerald-200 shadow-2xs'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <div>
                    <div className="font-bold text-slate-900">{opt.label}</div>
                    <div className="text-[10px] text-slate-500 font-normal">{opt.desc}</div>
                  </div>
                  {isSelected && <Check className="w-4 h-4 text-emerald-600 shrink-0 ml-2" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
