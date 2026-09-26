import React, { useState } from 'react';
import { X, ArrowUpCircle, Download, Loader2 } from 'lucide-react';
import { UpdateCheckResult } from '../hooks/useAutoUpdate';

interface UpdateCheckerProps {
  isOpen: boolean;
  onClose: () => void;
  updateInfo: UpdateCheckResult | null;
  onDownload: (url: string) => Promise<void>;
}

export const UpdateChecker: React.FC<UpdateCheckerProps> = ({
  isOpen,
  onClose,
  updateInfo,
  onDownload
}) => {
  const [isDownloading, setIsDownloading] = useState(false);

  if (!isOpen || !updateInfo) return null;

  const handleDownloadClick = async () => {
    setIsDownloading(true);
    await onDownload(updateInfo.apkUrl);
    setTimeout(() => {
      setIsDownloading(false);
    }, 4000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl max-w-sm w-full shadow-xl border border-slate-100 overflow-hidden flex flex-col animate-in scale-in duration-200">
        
        {/* Compact Header */}
        <div className="p-4 bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-700 text-white relative flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="w-5 h-5 text-indigo-200 animate-pulse shrink-0" />
            <h3 className="text-sm font-bold text-white tracking-wide">
              Đã Có Bản Cập Nhật Mới!
            </h3>
            <span className="px-2 py-0.5 text-[10px] font-black bg-emerald-400 text-slate-950 rounded-full">
              v{updateInfo.latestVersion}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Đóng"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Compact Content */}
        <div className="p-4 space-y-3">
          {/* Version details & simple note */}
          <div className="text-xs text-slate-600 leading-normal font-medium">
            <div className="flex justify-between items-center bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-100 mb-2">
              <span>Bản hiện tại: <strong className="text-slate-800 font-bold">v{updateInfo.currentVersion}</strong></span>
              <span className="text-slate-300">|</span>
              <span>Bản mới nhất: <strong className="text-indigo-600 font-bold">v{updateInfo.latestVersion}</strong></span>
            </div>
            <p className="text-slate-500 text-[11px] line-clamp-2 italic text-center mt-1">
              "{updateInfo.notes || 'Nâng cấp hiệu năng & tối ưu hóa hệ thống.'}"
            </p>
          </div>

          {/* Inline Action Controls Side-by-Side */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 py-2 text-xs font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-50 border border-slate-200 rounded-xl transition-all duration-150 active:scale-98"
            >
              Để sau
            </button>
            <button
              onClick={handleDownloadClick}
              disabled={isDownloading}
              className="flex-[2] flex items-center justify-center gap-1.5 py-2 bg-indigo-600 hover:bg-indigo-700 active:scale-98 text-white text-xs font-black rounded-xl shadow-sm transition-all disabled:opacity-60"
            >
              {isDownloading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Đang tải...</span>
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5 stroke-[2.5]" />
                  <span>Nâng Cấp Ngay</span>
                </>
              )}
            </button>
          </div>

          {/* Micro safety text */}
          <p className="text-[10px] text-emerald-600 text-center font-medium animate-pulse">
            ✓ Giữ lại 100% dữ liệu sách hiện tại của bạn
          </p>
        </div>

      </div>
    </div>
  );
};
