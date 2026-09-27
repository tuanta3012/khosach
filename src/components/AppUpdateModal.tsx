import React, { useState } from 'react';
import { ArrowUpCircle, X, Download, Calendar, CheckCircle2, Loader2 } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { Share } from '@capacitor/share';

export interface UpdateInfo {
  version: string;
  downloadUrl?: string;
  apkUrl?: string;
  changelog: string[];
  releaseDate?: string;
  notes?: string;
}

interface AppUpdateModalProps {
  isOpen: boolean;
  currentVersion: string;
  updateInfo: UpdateInfo | null;
  onClose: () => void;
}

export const AppUpdateModal: React.FC<AppUpdateModalProps> = ({
  isOpen,
  currentVersion,
  updateInfo,
  onClose,
}) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');

  if (!isOpen || !updateInfo) return null;

  const handleUpdate = async () => {
    const targetLink = updateInfo.apkUrl || updateInfo.downloadUrl;
    if (!targetLink) return;

    setIsDownloading(true);
    setDownloadProgress(10);
    setStatusMessage('Đang khởi tạo kết nối tải APK...');

    try {
      if (Capacitor.isNativePlatform()) {
        const fileName = `khosach_v${updateInfo.version}.apk`;
        setStatusMessage('Đang tải tệp APK trực tiếp về bộ nhớ máy...');
        setDownloadProgress(25);

        let savedUri = '';
        try {
          const downloadRes = await Filesystem.downloadFile({
            url: targetLink,
            path: fileName,
            directory: Directory.Cache,
            progress: true,
          });
          if (downloadRes.path) {
            savedUri = downloadRes.path;
          } else {
            const uriRes = await Filesystem.getUri({ path: fileName, directory: Directory.Cache });
            savedUri = uriRes.uri;
          }
          setDownloadProgress(85);
        } catch (downloadErr) {
          console.warn('Filesystem.downloadFile failed, trying fetch fallback:', downloadErr);
          setDownloadProgress(40);
          const response = await fetch(targetLink, { redirect: 'follow' });
          if (!response.ok) throw new Error('Không thể tải file APK từ máy chủ.');
          const blob = await response.blob();

          setDownloadProgress(70);
          setStatusMessage('Đang lưu tệp cài đặt...');

          const reader = new FileReader();
          const base64Data = await new Promise<string>((resolve, reject) => {
            reader.onloadend = () => {
              const res = reader.result as string;
              resolve(res.includes(',') ? res.split(',')[1] : res);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          const writeFileRes = await Filesystem.writeFile({
            path: fileName,
            data: base64Data,
            directory: Directory.Cache,
          });
          savedUri = writeFileRes.uri;
        }

        setDownloadProgress(95);
        setStatusMessage('Đã tải xong! Đang kích hoạt Trình Cài Đặt Android...');

        try {
          await FileOpener.open({
            filePath: savedUri,
            contentType: 'application/vnd.android.package-archive',
          });
          setDownloadProgress(100);
          setStatusMessage('Đang hiển thị màn hình cài đặt nâng cấp...');
        } catch (fileOpenerErr) {
          console.warn('FileOpener native trigger failed, trying Share intent fallback:', fileOpenerErr);
          const formattedUri = savedUri.startsWith('file://') || savedUri.startsWith('content://')
            ? savedUri
            : `file://${savedUri.startsWith('/') ? '' : '/'}${savedUri}`;

          try {
            await Share.share({
              title: `Cập nhật Kho Sách Cá Nhân v${updateInfo.version}`,
              url: formattedUri,
              dialogTitle: 'Mở bằng Trình Cài Đặt Gói (Package Installer) để nâng cấp',
            });
          } catch (shareErr) {
            console.warn('Share intent error, opening HTTPS release link:', shareErr);
            window.open(targetLink, '_system') || (window.location.href = targetLink);
          }
        }

        setIsDownloading(false);
        onClose();
      } else {
        setDownloadProgress(100);
        window.open(targetLink, '_blank') || (window.location.href = targetLink);
        setIsDownloading(false);
        onClose();
      }
    } catch (err: any) {
      console.error('Update download error:', err);
      setStatusMessage('Đang mở trình duyệt hệ thống để tải trực tiếp...');
      setTimeout(() => {
        try {
          window.open(targetLink, '_system') || (window.location.href = targetLink);
        } catch {}
        setIsDownloading(false);
      }, 1000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div 
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm transition-opacity" 
        onClick={!isDownloading ? onClose : undefined}
      />

      <div className="relative w-full max-w-md transform overflow-hidden rounded-3xl bg-slate-900 border border-slate-800 shadow-2xl transition-all p-6 text-slate-100 flex flex-col space-y-5">
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-400" />

        {!isDownloading && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-slate-400 hover:text-slate-100 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
            title="Bỏ qua"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        <div className="flex flex-col items-center text-center space-y-2 pt-2">
          <div className="p-3.5 bg-emerald-500/10 text-emerald-400 rounded-2xl border border-emerald-500/20 shadow-inner">
            {isDownloading ? (
              <Loader2 className="w-10 h-10 animate-spin text-emerald-400" />
            ) : (
              <ArrowUpCircle className="w-10 h-10 animate-bounce" />
            )}
          </div>
          <h2 className="text-lg font-extrabold tracking-tight text-white px-2">
            {isDownloading ? `Đang tải v${updateInfo.version}...` : `Đã có bản cập nhật mới (v${updateInfo.version})!`}
          </h2>
          <p className="text-xs text-slate-400 px-4">
            {isDownloading ? statusMessage : 'Bạn có muốn nâng cấp để vá lỗi và trải nghiệm tính năng tốt nhất không?'}
          </p>
        </div>

        {isDownloading ? (
          <div className="space-y-3 py-3">
            <div className="w-full bg-slate-800 rounded-full h-3 overflow-hidden p-0.5 border border-slate-700">
              <div 
                className="bg-gradient-to-r from-emerald-500 to-teal-400 h-full rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-slate-400 font-medium">
              <span>{statusMessage}</span>
              <span className="text-emerald-400 font-bold">{downloadProgress}%</span>
            </div>
            <div className="text-center pt-2 border-t border-slate-800/60">
              <button
                type="button"
                onClick={() => {
                  const targetLink = updateInfo.apkUrl || updateInfo.downloadUrl;
                  if (targetLink) window.open(targetLink, '_system') || (window.location.href = targetLink);
                }}
                className="text-xs text-teal-400 underline hover:text-teal-300 transition-colors font-medium"
              >
                Mở tải về trực tiếp bằng Trình duyệt
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 bg-slate-950/60 rounded-2xl p-3 border border-slate-800/80 text-center">
              <div>
                <span className="block text-[10px] text-slate-500 uppercase font-bold tracking-wider">Phiên bản hiện tại</span>
                <span className="text-sm font-semibold text-slate-300">v{currentVersion}</span>
              </div>
              <div className="border-l border-slate-800">
                <span className="block text-[10px] text-emerald-500 uppercase font-bold tracking-wider">Phiên bản mới nhất</span>
                <span className="text-sm font-extrabold text-emerald-400">v{updateInfo.version}</span>
              </div>
            </div>

            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-300 border-b border-slate-800 pb-1.5">
                <span>Danh sách thay đổi:</span>
                {updateInfo.releaseDate && (
                  <span className="flex items-center space-x-1 text-[10px] text-slate-500">
                    <Calendar className="w-3 h-3" />
                    <span>{updateInfo.releaseDate}</span>
                  </span>
                )}
              </div>
              <ul className="space-y-2 text-slate-300 text-xs">
                {updateInfo.changelog && updateInfo.changelog.length > 0 ? (
                  updateInfo.changelog.map((item, idx) => (
                    <li key={idx} className="flex items-start space-x-2 text-slate-300">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{item}</span>
                    </li>
                  ))
                ) : (
                  <li className="text-slate-400 italic text-center py-2">
                    {updateInfo.notes || 'Nâng cấp hiệu năng hệ thống, sửa lỗi và tối ưu hóa trải nghiệm.'}
                  </li>
                )}
              </ul>
            </div>

            <div className="flex space-x-3 pt-2">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 rounded-2xl border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-slate-100 font-bold text-xs transition-all"
              >
                Để sau
              </button>
              <button
                onClick={handleUpdate}
                className="flex-1 py-2.5 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-extrabold text-xs flex items-center justify-center space-x-1.5 shadow-lg shadow-emerald-500/10 transition-all active:scale-[0.98]"
              >
                <Download className="w-4 h-4 shrink-0" />
                <span>Cập nhật ngay</span>
              </button>
            </div>

            <p className="text-[10px] text-emerald-500 text-center font-medium pt-1">
              ✓ Giữ nguyên 100% dữ liệu sách đã lưu trong máy và đám mây
            </p>
          </>
        )}
      </div>
    </div>
  );
};
