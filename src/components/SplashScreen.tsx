import React, { useState, useEffect } from 'react';
import { CURRENT_APP_VERSION } from '../version';

export interface SplashScreenProps {
  onFinished: () => void;
  minDurationMs?: number;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({
  onFinished,
  minDurationMs = 2400,
}) => {
  const [isFadingOut, setIsFadingOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsFadingOut(true);
      const finishTimer = setTimeout(() => {
        onFinished();
      }, 400); // 400ms transition fade out
      return () => clearTimeout(finishTimer);
    }, minDurationMs);

    return () => clearTimeout(timer);
  }, [minDurationMs, onFinished]);

  return (
    <div
      className={`fixed inset-0 z-100 bg-[#0f172a] text-white flex flex-col items-center justify-center p-6 select-none transition-opacity duration-400 ${
        isFadingOut ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      {/* Ambient Glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center -z-10 overflow-hidden">
        <div className="w-[380px] h-[380px] bg-[#0284C7]/25 rounded-full blur-3xl animate-pulse" />
      </div>

      <div className="flex flex-col items-center justify-center text-center space-y-5 animate-in zoom-in-95 duration-300">
        <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-3xl overflow-hidden shadow-[0_0_50px_rgba(2,132,199,0.35)] border border-sky-300/40 bg-white p-1">
          <img src="/stk_app_icon.png" alt="Kho Sách" className="w-full h-full object-cover rounded-2xl block" />
        </div>

        <div className="space-y-1.5">
          <h1 className="text-3xl font-black tracking-tight text-white">
            Kho sách
          </h1>
          <p className="text-xs text-sky-200/80 font-medium tracking-wide">
            Quản lý & Hiệu chỉnh thư viện cá nhân
          </p>
        </div>

        {/* Loading Spinner / Bar */}
        <div className="pt-6 flex flex-col items-center space-y-2">
          <div className="w-36 h-1.5 bg-slate-800 rounded-full overflow-hidden shadow-inner">
            <div className="h-full bg-gradient-to-r from-sky-400 to-emerald-400 rounded-full animate-[shimmer_1.5s_infinite]" style={{ width: '100%' }} />
          </div>
          <span className="text-[10px] text-slate-400 tracking-wider font-semibold">
            v{CURRENT_APP_VERSION}
          </span>
        </div>
      </div>
    </div>
  );
};
