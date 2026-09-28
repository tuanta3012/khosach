import React from 'react';
import {
  BookOpen,
  Camera,
  Layers,
  Settings,
  PlusCircle,
  ArrowUpDown,
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
  isSyncingDrive?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onTabChange,
  totalBooksCount,
  onOpenSyncModal,
  onOpenAddModal,
  onOpenSettingsModal,
  isSyncingDrive = false,
}) => {
  return (
    <>
      {/* Top Bar for Mobile & Desktop */}
      <header className="sticky top-0 z-40 bg-slate-900 text-white shadow-md border-b border-slate-800/80 pt-[env(safe-area-inset-top,0px)]">
        <div className="max-w-7xl mx-auto px-3.5 sm:px-6">
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
                  <span className={`w-1.5 h-1.5 rounded-full ${isSyncingDrive ? 'bg-amber-400' : 'bg-emerald-400'}`}></span>
                  <span>{isSyncingDrive ? 'Đang đồng bộ Drive...' : 'Bộ nhớ máy + Drive'}</span>
                </p>
              </div>
            </div>

            {/* Desktop Nav Tabs */}
            <div className="hidden md:flex items-center gap-1 bg-slate-800/90 p-1 rounded-xl border border-slate-700/60">
              <button
                onClick={() => onTabChange('table')}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
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
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
                  currentTab === 'scanner'
                    ? 'bg-emerald-500 text-slate-950 shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
                }`}
              >
                <Camera className="w-4 h-4" />
                <span>Quét Gáy AI</span>
              </button>
            </div>

            {/* Header Right Action Button - ONLY Settings Gear */}
            <div className="flex items-center">
              <button
                onClick={onOpenSettingsModal}
                title="Cài đặt hệ thống"
                className="p-2.5 text-slate-300 hover:text-white hover:bg-slate-800 active:scale-95 rounded-xl transition border border-transparent hover:border-slate-700/60"
              >
                <Settings className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Bottom Navigation Dock for Mobile (Icon-only, compact, touch-optimized) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 px-5 pt-1 pb-[max(0.35rem,env(safe-area-inset-bottom,0px))] shadow-2xl">
        <div className="flex items-center justify-around max-w-md mx-auto h-11">
          {/* 1. Kho Sách */}
          <button
            onClick={() => onTabChange('table')}
            title="Kho Sách"
            className={`p-1.5 rounded-lg transition-all duration-150 active:scale-95 ${
              currentTab === 'table'
                ? 'text-emerald-400 bg-emerald-500/10 font-bold border border-emerald-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Layers className="w-5 h-5" />
          </button>

          {/* 2. Quét AI */}
          <button
            onClick={() => onTabChange('scanner')}
            title="Quét Gáy AI"
            className={`p-1.5 rounded-lg transition-all duration-150 active:scale-95 ${
              currentTab === 'scanner'
                ? 'text-emerald-400 bg-emerald-500/10 font-bold border border-emerald-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Camera className="w-5 h-5" />
          </button>

          {/* 3. Thêm Sách */}
          <button
            onClick={onOpenAddModal}
            title="Thêm Sách Mới"
            className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-slate-800/60 transition-all duration-150 active:scale-95"
          >
            <PlusCircle className="w-5 h-5 text-emerald-400" />
          </button>

          {/* 4. Đồng Bộ */}
          <button
            onClick={onOpenSyncModal}
            title="Sao Lưu / Đồng Bộ"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-all duration-150 active:scale-95"
          >
            <ArrowUpDown className="w-5 h-5" />
          </button>
        </div>
      </nav>
    </>
  );
};
