import React, { useState } from 'react';
import { Sparkles, Download, X, ArrowUpCircle, CheckCircle, ExternalLink, RefreshCw } from 'lucide-react';
import { UpdateCheckResult } from '../utils/updateService';

interface UpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  updateInfo: UpdateCheckResult | null;
}

export const UpdateModal: React.FC<UpdateModalProps> = ({
  isOpen,
  onClose,
  updateInfo,
}) => {
  const [isDownloading, setIsDownloading] = useState(false);

  if (!isOpen || !updateInfo) return null;

  const handleDownload = () => {
    if (!updateInfo.apkUrl) return;
    setIsDownloading(true);
    
    // Mở liên kết tải APK trực tiếp
    window.location.href = updateInfo.apkUrl;
    
    setTimeout(() => {
      setIsDownloading(false);
    }, 3000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col">
        {/* Header with gradient badge */}
        <div className="p-6 bg-gradient-to-br from-emerald-600 via-teal-700 to-slate-900 text-white relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="w-12 h-12 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center mb-3 shadow-inner">
            <ArrowUpCircle className="w-7 h-7 text-emerald-300 animate-bounce" />
          </div>

          <div className="flex items-center gap-2">
            <h3 className="text-lg font-black tracking-tight text-white">
              Đã Có Bản Cập Nhật Mới!
            </h3>
            <span className="px-2 py-0.5 text-xs font-black bg-emerald-400 text-slate-950 rounded-full shadow-xs">
              v{updateInfo.latestVersion}
            </span>
          </div>
          <p className="text-xs text-emerald-100/80 mt-1">
            Phiên bản hiện tại trên máy của bạn: <span className="font-semibold text-white">v{updateInfo.currentVersion}</span>
          </p>
        </div>

        {/* Content body */}
        <div className="p-6 space-y-4">
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/80">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-1.5 flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              Nội dung cập nhật mới:
            </span>
            <p className="text-xs font-medium text-slate-700 whitespace-pre-line leading-relaxed">
              {updateInfo.notes || 'Cải tiến hiệu năng, cập nhật tính năng mới và tối ưu trải nghiệm.'}
            </p>
          </div>

          <div className="text-[11px] text-slate-500 flex items-center gap-1.5 bg-emerald-50/70 p-3 rounded-xl border border-emerald-200/60 text-emerald-800">
            <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Toàn bộ dữ liệu sách trên máy của bạn sẽ được giữ nguyên an toàn khi nâng cấp.</span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="p-6 pt-0 flex flex-col gap-2.5">
          <button
            onClick={handleDownload}
            disabled={isDownloading}
            className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-2xl shadow-md shadow-emerald-600/20 active:scale-98 transition disabled:opacity-50"
          >
            {isDownloading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Đang bắt đầu tải APK...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4 stroke-[2.5]" />
                <span>Tải & Cài Đặt Bản Cập Nhật (APK)</span>
              </>
            )}
          </button>

          <button
            onClick={onClose}
            className="w-full py-2.5 text-xs font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition"
          >
            Để sau
          </button>
        </div>
      </div>
    </div>
  );
};
