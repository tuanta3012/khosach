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

  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success'>('idle');

  useEffect(() => {
    if (isSyncingDrive) {
      setSyncStatus('syncing');
    } else {
      setSyncStatus((prev) => {
        if (prev === 'syncing') {
          return 'success';
        }
        return prev;
      });
    }
  }, [isSyncingDrive]);

  useEffect(() => {
    if (syncStatus === 'success') {
      const timer = setTimeout(() => {
        setSyncStatus('idle');
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [syncStatus]);

  // Close account menu when clicking outside
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
      {/* Top Bar for Mobile & Desktop - Tông màu Xanh Dương Hiện Đại (#0284C7) */}
      <header className="sticky top-0 z-40 bg-[#0284C7] text-white shadow-md border-b border-sky-700/80 pt-[env(safe-area-inset-top,0px)]">
        <div className="max-w-7xl mx-auto px-3 sm:px-5">
          <div className="flex items-center justify-between h-15 sm:h-16 gap-2">
            {/* App Branding & Storage Mode Status Indicator */}
            <div className="flex items-center gap-2 min-w-0">
              <img
                src="/stk_app_icon.png"
                alt="Kho Sách"
                className="w-7.5 h-7.5 sm:w-8 sm:h-8 rounded-lg object-cover shadow-xs border border-sky-200/40 shrink-0"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h1 className="text-xs sm:text-sm font-extrabold tracking-tight text-white leading-tight">
                    Kho Sách
                  </h1>
                  <span className="px-1.5 py-0.2 text-[9.5px] font-bold bg-[#0369a1] text-sky-100 rounded border border-sky-300/40">
                    {totalBooksCount}
                  </span>

                  {/* Badge chỉ số thay đổi lớn !X khi AI đang làm giàu dữ liệu */}
                  {pendingAiCount > 0 && (
                    <span
                      title={`${pendingAiCount} cuốn sách đang chờ/chuẩn hóa AI`}
                      className="px-1.5 py-0.2 text-[9.5px] font-black bg-[#F59E0B] text-slate-950 rounded-full animate-bounce shadow-xs flex items-center gap-0.5"
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      !{pendingAiCount}
                    </span>
                  )}
                </div>

                {/* Storage Mode Status Indicator */}
                {appMode === 'online' ? (
                  /* Trạng thái Online: Chấm xanh ngọc + chữ "Online" tinh gọn */
                  <button
                    type="button"
                    onClick={onOpenModeModal}
                    className="text-[9.5px] sm:text-xs text-sky-100 flex items-center gap-1 font-bold hover:text-white transition text-left"
                    title="Chế độ trực tuyến (Google Drive)"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        syncStatus === 'syncing'
                          ? 'bg-[#F59E0B] animate-ping'
                          : syncStatus === 'success'
                          ? 'bg-[#10B981] animate-pulse'
                          : 'bg-[#10B981] shadow-xs shadow-emerald-400/50'
                      }`}
                    />
                    <span>
                      {syncStatus === 'syncing'
                        ? 'Đang đồng bộ...'
                        : syncStatus === 'success'
                        ? 'Đồng bộ thành công'
                        : 'Online'}
                    </span>
                  </button>
                ) : (
                  /* Trạng thái Offline: Chấm xám + chữ "Offline" tinh gọn */
                  <button
                    type="button"
                    onClick={onOpenModeModal}
                    className="text-[9.5px] sm:text-xs text-sky-200/80 flex items-center gap-1 font-bold hover:text-white transition text-left"
                    title="Chế độ ngoại tuyến (Bộ nhớ máy)"
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-slate-300" />
                    <span>Offline</span>
                  </button>
                )}
              </div>
            </div>

            {/* Desktop Navigation Tabs */}
            <div className="hidden xl:flex items-center gap-1 bg-[#0369a1] p-1 rounded-xl border border-sky-500/50">
              <button
                onClick={() => onTabChange('table')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition ${
                  currentTab === 'table'
                    ? 'bg-[#10B981] text-white shadow-xs'
                    : 'text-sky-100/80 hover:text-white hover:bg-sky-600/60'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Kho Sách</span>
              </button>

              <button
                onClick={() => onTabChange('scanner')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition ${
                  currentTab === 'scanner'
                    ? 'bg-[#10B981] text-white shadow-xs'
                    : 'text-sky-100/80 hover:text-white hover:bg-sky-600/60'
                }`}
              >
                <div className="relative inline-flex items-center">
                  <Camera className="w-3.5 h-3.5" />
                  <span className="absolute -top-1 -right-1.5 bg-[#F59E0B] text-slate-950 text-[6.5px] font-black px-0.5 rounded leading-tight shadow-xs">
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
                  /* User logged in: Profile Pill with Avatar & Direct Actions */
                  <button
                    type="button"
                    onClick={() => setIsAccountMenuOpen(!isAccountMenuOpen)}
                    className="flex items-center gap-1 p-0.5 sm:px-1.5 rounded-full bg-[#0369a1] hover:bg-sky-600 border border-sky-300/50 text-white text-xs font-bold transition active:scale-95 shadow-xs"
                    title={currentUser.email}
                  >
                    {currentUser.photoURL ? (
                      <img
                        src={currentUser.photoURL}
                        alt={currentUser.name}
                        className="w-6 h-6 rounded-full object-cover border border-white/60"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-[#F59E0B] text-slate-950 flex items-center justify-center font-black text-[11px] shadow-xs">
                        {(currentUser.name || currentUser.email || 'U').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="hidden sm:inline max-w-[100px] truncate text-white font-semibold">{currentUser.name}</span>
                    <ChevronDown className="w-3 h-3 text-sky-200 opacity-80" />
                  </button>
                ) : (
                  /* User logged out / Offline: Direct Google Sign-In Button */
                  <button
                    onClick={() => {
                      if (onGoogleSignIn) {
                        onGoogleSignIn();
                      } else if (onOpenModeModal) {
                        onOpenModeModal();
                      }
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 bg-[#EA580C] hover:bg-[#c2410c] active:scale-95 text-white text-[11px] font-bold rounded-lg shadow-xs transition border border-orange-400/30 cursor-pointer"
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24">
                      <path fill="#ffffff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#fef3c7" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    </svg>
                    <span>Đăng nhập</span>
                  </button>
                )}

                {/* Account Quick Dropdown Menu - Bright Light Theme */}
                {isAccountMenuOpen && currentUser && (
                  <div
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    className="absolute right-0 mt-1.5 w-56 bg-white text-slate-800 border border-slate-200/90 rounded-2xl shadow-2xl p-2 z-50 animate-in fade-in duration-150 space-y-1"
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
                        className="w-full flex items-center gap-2 p-2 rounded-xl text-xs font-semibold text-slate-700 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 transition text-left cursor-pointer"
                      >
                        <Users className="w-4 h-4 text-[#0284C7]" />
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
                        className="w-full flex items-center gap-2 p-2 rounded-xl text-xs font-bold text-rose-600 hover:bg-rose-50 active:bg-rose-100 transition text-left cursor-pointer"
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
                className="p-1.5 text-sky-100 hover:text-white hover:bg-sky-600/60 active:scale-95 rounded-lg transition border border-transparent hover:border-sky-400/40"
              >
                <Settings className="w-4.5 h-4.5" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Bottom Navigation Dock for Mobile - Tông màu Xanh Dương Hiện Đại (#0284C7) */}
      <nav className="xl:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0284C7]/95 backdrop-blur-md border-t border-sky-700/80 px-4 pt-1.5 pb-[max(0.4rem,env(safe-area-inset-bottom,0px))] shadow-2xl">
        <div className="flex items-center justify-around max-w-md mx-auto h-12">
          {/* 1. Kho Sách */}
          <button
            onClick={() => onTabChange('table')}
            title="Kho Sách"
            className={`p-1 rounded-lg transition-all duration-150 active:scale-95 ${
              currentTab === 'table'
                ? 'text-white bg-[#10B981] font-bold shadow-xs'
                : 'text-sky-100/80 hover:text-white hover:bg-sky-600/50'
            }`}
          >
            <Layers className="w-[23.4px] h-[23.4px]" />
          </button>

          {/* 2. Quét AI */}
          <button
            onClick={() => onTabChange('scanner')}
            title="Quét AI"
            className={`p-1 rounded-lg transition-all duration-150 active:scale-95 ${
              currentTab === 'scanner'
                ? 'text-white bg-[#10B981] font-bold shadow-xs'
                : 'text-sky-100/80 hover:text-white hover:bg-sky-600/50'
            }`}
          >
            <div className="relative inline-flex items-center justify-center">
              <Camera className="w-[23.4px] h-[23.4px]" />
              <span className="absolute -top-1 -right-1.5 bg-[#F59E0B] text-slate-950 text-[6.5px] font-black px-0.5 rounded leading-tight shadow-xs">
                AI
              </span>
            </div>
          </button>

          {/* 3. Thêm Sách */}
          <button
            onClick={onOpenAddModal}
            title="Thêm Sách"
            className="p-1 rounded-lg text-[#F59E0B] hover:text-amber-300 transition-all duration-150 active:scale-95"
          >
            <PlusCircle className="w-[23.4px] h-[23.4px]" />
          </button>

          {/* 4. Đồng Bộ / Xuất Nhập */}
          <button
            onClick={onOpenSyncModal}
            title="Đồng Bộ"
            className="p-1 rounded-lg text-sky-100/80 hover:text-white hover:bg-sky-600/50 transition-all duration-150 active:scale-95"
          >
            <ArrowUpDown className="w-[23.4px] h-[23.4px]" />
          </button>
        </div>
      </nav>
    </>
  );
};
