import React from 'react';
import {
  BookOpen,
  Camera,
  Layers,
  Sparkles,
  HardDrive,
  Settings,
  Plus,
} from 'lucide-react';
import { AuthUser } from '../types';

export type NavTabType = 'table' | 'scanner';

interface NavbarProps {
  currentTab: NavTabType;
  onTabChange: (tab: NavTabType) => void;
  totalBooksCount: number;
  currentUser: AuthUser | null;
  onOpenSyncModal: () => void;
  onOpenAddModal: () => void;
  onOpenSettingsModal: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onTabChange,
  totalBooksCount,
  onOpenSyncModal,
  onOpenAddModal,
  onOpenSettingsModal,
}) => {
  return (
    <>
      {/* Top Bar for Mobile & Desktop */}
      <header className="sticky top-0 z-40 bg-slate-900 text-white shadow-md border-b border-slate-800 pt-[env(safe-area-inset-top,0px)]">
        <div className="max-w-7xl mx-auto px-3 sm:px-6">
          <div className="flex items-center justify-between h-14 sm:h-16 gap-2">
            {/* Logo & Branding */}
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-emerald-500 text-slate-950 flex items-center justify-center font-bold shadow-xs shrink-0">
                <BookOpen className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <h1 className="text-sm sm:text-base font-extrabold tracking-tight text-white leading-tight">
                    Kho Sách
                  </h1>
                  <span className="px-1.5 py-0.2 text-[10px] font-bold bg-emerald-500/20 text-emerald-400 rounded border border-emerald-500/30">
                    {totalBooksCount}
                  </span>
                </div>
                <p className="text-[10px] sm:text-xs text-slate-400 flex items-center gap-1 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  <span>Firestore Sync</span>
                </p>
              </div>
            </div>

            {/* Desktop Nav Tabs */}
            <div className="hidden md:flex items-center gap-1 bg-slate-800/90 p-1 rounded-xl border border-slate-700/60">
              <button
                onClick={() => onTabChange('table')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                  currentTab === 'table'
                    ? 'bg-emerald-500 text-slate-950 shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
                }`}
              >
                <Layers className="w-4 h-4" />
                <span>Danh Sách Kho</span>
              </button>

              <button
                onClick={() => onTabChange('scanner')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                  currentTab === 'scanner'
                    ? 'bg-emerald-500 text-slate-950 shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
                }`}
              >
                <Camera className="w-4 h-4" />
                <span>Quét Gáy AI</span>
                <Sparkles className="w-3 h-3 text-amber-300 animate-pulse" />
              </button>
            </div>

            {/* Header Right Quick Action Buttons */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={onOpenAddModal}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs transition active:scale-95 shadow-xs"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span className="hidden sm:inline">Thêm Sách</span>
              </button>

              <button
                onClick={onOpenSyncModal}
                title="Sao lưu / Nhập Xuất"
                className="p-2 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition"
              >
                <HardDrive className="w-4 h-4" />
              </button>

              <button
                onClick={onOpenSettingsModal}
                title="Cài đặt"
                className="p-2 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Bottom Sticky Navigation Dock for Mobile (Icon-only, touch-optimized) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 px-6 pt-2 pb-[max(0.625rem,env(safe-area-inset-bottom,0px))] flex items-center justify-around shadow-2xl">
        <button
          onClick={() => onTabChange('table')}
          title={`Kho Sách (${totalBooksCount})`}
          className={`p-2 rounded-xl transition ${
            currentTab === 'table' ? 'text-emerald-400 bg-slate-800/80 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-5 h-5" />
        </button>

        <button
          onClick={() => onTabChange('scanner')}
          title="Quét Gáy AI"
          className={`p-2 rounded-xl transition ${
            currentTab === 'scanner' ? 'text-emerald-400 bg-slate-800/80 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <div className="relative">
            <Camera className="w-5 h-5" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-amber-400 rounded-full animate-ping"></span>
          </div>
        </button>

        <button
          onClick={onOpenAddModal}
          title="Thêm Sách Mới"
          className="p-1.5 rounded-full bg-emerald-500 text-slate-950 font-bold active:scale-90 transition shadow-md"
        >
          <Plus className="w-5 h-5 stroke-[3]" />
        </button>

        <button
          onClick={onOpenSyncModal}
          title="Sao Lưu / Đồng Bộ"
          className="p-2 rounded-xl text-slate-400 hover:text-slate-200 transition"
        >
          <HardDrive className="w-5 h-5" />
        </button>
      </nav>
    </>
  );
};
