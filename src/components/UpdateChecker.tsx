import React, { useState } from 'react';
import { X, ArrowUpCircle, Download, Sparkles, CheckCircle2, Loader2 } from 'lucide-react';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col animate-in slide-in-from-bottom duration-300">
        
        {/* Header Banner with Premium Gradient */}
        <div className="p-6 bg-gradient-to-br from-indigo-600 via-violet-700 to-slate-900 text-white relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 rounded-full text-white/70 hover:text-white hover:bg-white/10 active:scale-90 transition-all duration-150"
            aria-label="Đóng"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="w-12 h-12 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center mb-3 shadow-inner">
            <ArrowUpCircle className="w-7 h-7 text-indigo-300 animate-bounce" />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-xl font-extrabold tracking-tight text-white">
              Phát Hiện Bản Cập Nhật Mới!
            </h3>
            <span className="px-2.5 py-0.5 text-xs font-black bg-emerald-400 text-slate-950 rounded-full shadow-sm animate-pulse">
              v{updateInfo.latestVersion}
            </span>
          </div>
          
          <p className="text-xs text-indigo-100/80 mt-1.5">
            Phiên bản hiện tại của bạn: <span className="font-semibold text-white">v{updateInfo.currentVersion}</span>
          </p>
        </div>

        {/* Update Content Details */}
        <div className="p-6 space-y-4">
          
          {/* Release Notes Container */}
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-150 flex flex-col">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-2 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
              Nội dung cập nhật mới:
            </span>
            <div className="max-h-40 overflow-y-auto pr-1 text-xs text-slate-700 font-medium whitespace-pre-line leading-relaxed scrollbar-thin">
              {updateInfo.notes || 'Bản phát hành này bao gồm một số cải tiến hiệu năng, sửa lỗi nhỏ và nâng cấp trải nghiệm người dùng.'}
            </div>
          </div>

          {/* Data Safety Assurance Card */}
          <div className="text-[11px] text-emerald-800 flex items-start gap-2 bg-emerald-50 p-3.5 rounded-xl border border-emerald-100">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <span className="leading-normal">
              <strong>Yên tâm nâng cấp:</strong> Toàn bộ dữ liệu thư viện sách cá nhân của bạn trên thiết bị sẽ được giữ lại an toàn 100%.
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="p-6 pt-0 flex flex-col gap-2.5">
          <button
            onClick={handleDownloadClick}
            disabled={isDownloading}
            className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] text-white text-sm font-bold rounded-2xl shadow-md shadow-indigo-600/20 transition-all disabled:opacity-50"
          >
            {isDownloading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Đang kết nối để tải xuống...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4 stroke-[2.5]" />
                <span>Tải Về & Cài Đặt (APK)</span>
              </>
            )}
          </button>

          <button
            onClick={onClose}
            className="w-full py-2.5 text-xs font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-all duration-150"
          >
            Để sau
          </button>
        </div>
      </div>
    </div>
  );
};
