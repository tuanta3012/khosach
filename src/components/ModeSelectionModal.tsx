import React from 'react';
import { HardDrive, RefreshCw, X } from 'lucide-react';
import { CURRENT_APP_VERSION } from '../version';

interface ModeSelectionModalProps {
  isOpen: boolean;
  onSelectMode: (mode: 'offline' | 'online') => void;
  currentMode?: 'offline' | 'online';
  onClose?: () => void;
  canClose?: boolean;
  onCheckUpdates?: () => void;
}

export const ModeSelectionModal: React.FC<ModeSelectionModalProps> = ({
  isOpen,
  onSelectMode,
  onClose,
  canClose = false,
  onCheckUpdates,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[#1c0e08] text-white flex flex-col justify-between items-center px-6 py-8 sm:py-10 select-none overflow-y-auto">
      {/* Ambient Glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center -z-10 overflow-hidden">
        <div className="w-[420px] h-[420px] bg-[#9e5628]/25 rounded-full blur-3xl" />
      </div>

      {/* Top spacer */}
      <div className="w-full max-w-md h-4 shrink-0" />

      {/* Center Section: Bookshelf App Icon & Title */}
      <div className="flex flex-col items-center justify-center my-auto py-6 shrink-0 text-center">
        <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-3xl bg-white/95 p-2 flex items-center justify-center shadow-[0_0_50px_rgba(158,86,40,0.4)] border-2 border-amber-400/50 transition transform hover:scale-105">
          <img src="/stk_app_icon.png" alt="Kho Sách" className="w-full h-full object-contain" />
        </div>

        <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white mt-5">
          Kho sách
        </h1>
      </div>

      {/* Bottom Action Cards */}
      <div className="w-full max-w-md space-y-3 shrink-0">
        {/* Card 1: Google Login */}
        <button
          type="button"
          onClick={() => onSelectMode('online')}
          className="w-full p-4 rounded-2xl bg-white hover:bg-slate-50 text-slate-900 shadow-xl transition-all flex items-center gap-3.5 active:scale-[0.98] group text-left border border-white"
        >
          <div className="w-11 h-11 rounded-xl bg-amber-50 flex items-center justify-center shrink-0 border border-amber-200/60 group-hover:scale-105 transition-transform">
            <svg className="w-6 h-6" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-slate-900 leading-tight">
              Đăng nhập Google
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Sao lưu & đồng bộ online
            </p>
          </div>
        </button>

        {/* Card 2: Offline Mode */}
        <button
          type="button"
          onClick={() => onSelectMode('offline')}
          className="w-full p-4 rounded-2xl bg-[#2b170e] hover:bg-[#381c12] text-white border border-[#452215] hover:border-amber-500/50 shadow-lg transition-all flex items-center gap-3.5 active:scale-[0.98] group text-left"
        >
          <div className="w-11 h-11 rounded-xl bg-[#9e5628]/30 border border-amber-500/40 text-amber-300 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
            <HardDrive className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-white leading-tight">
              Sử dụng Offline
            </h3>
            <p className="text-xs text-amber-200/70 mt-0.5">
              Lưu trữ an toàn trên máy
            </p>
          </div>
        </button>

        {/* Footer Version */}
        <div className="pt-2 text-center text-xs text-amber-200/50 flex items-center justify-center gap-2">
          <span>v{CURRENT_APP_VERSION}</span>
          {onCheckUpdates && (
            <button
              onClick={onCheckUpdates}
              className="text-amber-400/80 hover:text-amber-300 flex items-center gap-1 font-semibold cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Cập nhật</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
