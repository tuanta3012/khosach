import React, { useState, useRef, useEffect } from 'react';
import {
  Camera,
  Layers,
  Settings,
  PlusCircle,
  ArrowUpDown,
  Cloud,
  HardDrive,
  Users,
  LogOut,
  ChevronDown,
  Sparkles,
  FileSpreadsheet,
  UploadCloud,
  Smartphone,
} from 'lucide-react';
import { AuthUser } from '../types';

export type NavTabType = 'table' | 'scanner';

export interface NavbarProps {
  currentTab: NavTabType;
  onTabChange: (tab: NavTabType) => void;
  totalBooksCount: number;
  currentUser: AuthUser | null;
  onOpenSyncModal: () => void;
  onOpenAddModal: () => void;
  onOpenSettingsModal: () => void;
  onOpenModeModal?: () => void;
  onOpenFamilyShare?: () => void;
  appMode?: 'offline' | 'online';
  isSyncingDrive?: boolean;
  spreadsheetInfo?: { id?: string; name?: string } | null;
  pendingAiCount?: number;
  onSwitchToCloud?: () => Promise<void>;
  onGoogleSignIn?: () => Promise<void>;
  onGoogleLogout?: () => Promise<void>;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onTabChange,
  totalBooksCount,
  currentUser,
  onOpenSyncModal,
  onOpenAddModal,
  onOpenSettingsModal,
  onOpenModeModal,
  onOpenFamilyShare,
  appMode = 'offline',
  isSyncingDrive = false,
  spreadsheetInfo,
  pendingAiCount = 0,
  onSwitchToCloud,
  onGoogleSignIn,
  onGoogleLogout,
}) => {
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isMigratingToCloud, setIsMigratingToCloud] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setIsAccountMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCloudUpload = async () => {
    if (isMigratingToCloud) return;
    setIsMigratingToCloud(true);
    try {
      if (onSwitchToCloud) {
        await onSwitchToCloud();
      } else if (onGoogleSignIn) {
        await onGoogleSignIn();
      }
    } catch (err) {
      console.error('Error migrating to Cloud:', err);
    } finally {
      setIsMigratingToCloud(false);
    }
  };

  const bookcaseName = spreadsheetInfo?.name || 'Kho Sách Online';

  return (
    <>
      {/* Top Bar for Mobile & Desktop - Emerald Green Theme */}
      <header className="sticky top-0 z-40 bg-emerald-900 text-white shadow-md border-b border-emerald-800 pt-[env(safe-area-inset-top,0px)]">
        <div className="max-w-7xl mx-auto px-3 sm:px-5">
          <div className="flex items-center justify-between h-15 sm:h-16 gap-2">
            {/* App Branding & Storage Mode Status Indicator */}
            <div className="flex items-center gap-2 min-w-0">
              <img
                src="/stk_app_icon.png"
                alt="Kho Sách"
                className="w-7.5 h-7.5 sm:w-8 sm:h-8 rounded-lg object-contain bg-white/95 p-0.5 shadow-sm border border-emerald-400/40 shrink-0"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h1 className="text-xs sm:text-sm font-extrabold tracking-tight text-white leading-tight">
                    Kho Sách
                  </h1>
                  <span className="px-1.5 py-0.2 text-[9.5px] font-bold bg-emerald-700 text-emerald-100 rounded border border-emerald-500/40">
                    {totalBooksCount}
                  </span>

                  {pendingAiCount > 0 && (
                    <span
                      title={`${pendingAiCount} cuốn sách đang chờ/chuẩn hóa AI`}
                      className="px-1.5 py-0.2 text-[9.5px] font-black bg-amber-400 text-slate-950 rounded-full animate-bounce shadow-xs flex items-center gap-0.5"
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      !{pendingAiCount}
                    </span>
                  )}
                </div>

                {appMode === 'online' ? (
                  <button
                    type="button"
                    onClick={onOpenModeModal}
                    className="text-[9.5px] sm:text-xs text-emerald-300 flex items-center gap-1 font-bold hover:text-white transition text-left"
                    title="Chế độ trực tuyến (Google Drive)"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        isSyncingDrive ? 'bg-amber-400 animate-ping' : 'bg-emerald-400 shadow-xs shadow-emerald-400/50'
                      }`}
                    />
                    <span>{isSyncingDrive ? 'Đang đồng bộ...' : 'Online'}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onOpenModeModal}
                    className="text-[9.5px] sm:text-xs text-emerald-200/70 flex items-center gap-1 font-bold hover:text-white transition text-left"
                    title="Chế độ ngoại tuyến (Bộ nhớ máy)"
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-slate-400" />
                    <span>Offline</span>
                  </button>
                )}
              </div>
            </div>

            {/* Desktop Navigation Tabs */}
            <div className="hidden md:flex items-center gap-1 bg-emerald-950 p-1 rounded-xl border border-emerald-800">
              <button
                onClick={() => onTabChange('table')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition ${
                  currentTab === 'table'
                    ? 'bg-emerald-600 text-white shadow-xs'
                    : 'text-emerald-200/70 hover:text-white hover:bg-emerald-800'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Kho Sách</span>
              </button>

              <button
                onClick={() => onTabChange('scanner')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition ${
                  currentTab === 'scanner'
                    ? 'bg-emerald-600 text-white shadow-xs'
                    : 'text-emerald-200/70 hover:text-white hover:bg-emerald-800'
                }`}
              >
                <div className="relative inline-flex items-center">
                  <Camera className="w-3.5 h-3.5" />
                  <span className="absolute -top-1 -right-1.5 bg-amber-400 text-slate-950 text-[6.5px] font-black px-0.5 rounded leading-tight shadow-xs">
                    AI
                  </span>
                </div>
                <span>Quét AI</span>
              </button>
            </div>

            {/* Direct Login / Logout & Account Access */}
            <div className="flex items-center gap-1">
              <div className="relative" ref={accountMenuRef}>
                {appMode === 'online' && currentUser ? (
                  <button
                    type="button"
                    onClick={() => setIsAccountMenuOpen(!isAccountMenuOpen)}
                    className="flex items-center gap-1 p-0.5 sm:px-1.5 rounded-full bg-emerald-800 hover:bg-emerald-700 border border-emerald-500/40 text-white text-xs font-bold transition active:scale-95 shadow-sm"
                    title={currentUser.email}
                  >
                    {currentUser.photoURL ? (
                      <img
                        src={currentUser.photoURL}
                        alt={currentUser.name}
                        className="w-6 h-6 rounded-full object-cover border border-emerald-400/60"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-amber-400 text-slate-950 flex items-center justify-center font-black text-[11px] shadow-xs">
                        {(currentUser.name || currentUser.email || 'U').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="hidden sm:inline max-w-[100px] truncate text-emerald-100 font-semibold">{currentUser.name}</span>
                    <ChevronDown className="w-3 h-3 text-emerald-300 opacity-80" />
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      if (onGoogleSignIn) {
                        onGoogleSignIn();
                      } else if (onOpenModeModal) {
                        onOpenModeModal();
                      }
                    }}
                    className="flex items-center gap-1.5 px-2 py-1 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white text-[11px] font-bold rounded-lg shadow-xs transition border border-emerald-400/30"
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24">
                      <path fill="#ffffff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#fef3c7" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    </svg>
                    <span>Đăng nhập</span>
                  </button>
                )}

                {/* Account Quick Dropdown Menu */}
                {isAccountMenuOpen && currentUser && (
                  <div
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    className="absolute right-0 mt-1.5 w-56 bg-white text-slate-900 border border-slate-200 rounded-2xl shadow-2xl p-2 z-50 animate-in fade-in duration-150 space-y-1"
                  >
                    <div className="p-2 border-b border-slate-100">
                      <p className="text-xs font-bold text-slate-900 truncate">{currentUser.name}</p>
                      <p className="text-[10px] text-slate-500 truncate">{currentUser.email}</p>
                    </div>

                    {onOpenFamilyShare && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsAccountMenuOpen(false);
                          onOpenFamilyShare();
                        }}
                        className="w-full flex items-center gap-2 p-2 rounded-xl text-xs font-semibold text-slate-700 hover:bg-slate-100 transition text-left cursor-pointer"
                      >
                        <Users className="w-4 h-4 text-emerald-600" />
                        <span>Quản lý thành viên</span>
                      </button>
                    )}

                    {onGoogleLogout && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsAccountMenuOpen(false);
                          onGoogleLogout();
                        }}
                        className="w-full flex items-center gap-2 p-2 rounded-xl text-xs font-bold text-rose-600 hover:bg-rose-50 transition text-left cursor-pointer"
                      >
                        <LogOut className="w-4 h-4 text-rose-500" />
                        <span>Đăng xuất</span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Settings Icon */}
              <button
                onClick={onOpenSettingsModal}
                title="Cài đặt"
                className="p-1.5 text-emerald-100 hover:text-white hover:bg-emerald-800 active:scale-95 rounded-lg transition border border-transparent hover:border-emerald-700"
              >
                <Settings className="w-4.5 h-4.5" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Bottom Navigation Dock for Mobile - Emerald Green Theme */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-emerald-950/95 backdrop-blur-md border-t border-emerald-800 px-4 pt-1.5 pb-[max(0.4rem,env(safe-area-inset-bottom,0px))] shadow-2xl">
        <div className="flex items-center justify-around max-w-md mx-auto h-12">
          <button
            onClick={() => onTabChange('table')}
            title="Kho Sách"
            className={`p-1 rounded-lg transition-all duration-150 active:scale-95 ${
              currentTab === 'table'
                ? 'text-white bg-emerald-600 font-bold shadow-xs'
                : 'text-emerald-200/70 hover:text-white hover:bg-emerald-800'
            }`}
          >
            <Layers className="w-[23.4px] h-[23.4px]" />
          </button>

          <button
            onClick={() => onTabChange('scanner')}
            title="Quét AI"
            className={`p-1 rounded-lg transition-all duration-150 active:scale-95 ${
              currentTab === 'scanner'
                ? 'text-white bg-emerald-600 font-bold shadow-xs'
                : 'text-emerald-200/70 hover:text-white hover:bg-emerald-800'
            }`}
          >
            <div className="relative inline-flex items-center justify-center">
              <Camera className="w-[23.4px] h-[23.4px]" />
              <span className="absolute -top-1 -right-1.5 bg-amber-400 text-slate-950 text-[6.5px] font-black px-0.5 rounded leading-tight shadow-xs">
                AI
              </span>
            </div>
          </button>

          <button
            onClick={onOpenAddModal}
            title="Thêm Sách"
            className="p-1 rounded-lg text-amber-300 hover:bg-emerald-800 transition-all duration-150 active:scale-95"
          >
            <PlusCircle className="w-[23.4px] h-[23.4px]" />
          </button>

          <button
            onClick={onOpenSyncModal}
            title="Đồng Bộ"
            className="p-1 rounded-lg text-emerald-200/70 hover:text-white hover:bg-emerald-800 transition-all duration-150 active:scale-95"
          >
            <ArrowUpDown className="w-[23.4px] h-[23.4px]" />
          </button>
        </div>
      </nav>
    </>
  );
};
