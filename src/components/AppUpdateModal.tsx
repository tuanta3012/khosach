import React, { useState } from 'react';
import { ArrowUpCircle, X, Download, CheckCircle2, Loader2 } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { Share } from '@capacitor/share';
import { IS_BUILD_AAB } from '../config/buildConfig';

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

  if (IS_BUILD_AAB || !isOpen || !updateInfo) return null;

  const handleUpdate = async () => {
    const targetLink = updateInfo.apkUrl || updateInfo.downloadUrl;
    if (!targetLink) return;

    setIsDownloading(true);
    setDownloadProgress(10);
    setStatusMessage('Đang kết nối...');

    try {
      if (Capacitor.isNativePlatform()) {
        const fileName = `khosach_v${updateInfo.version}.apk`;
        setStatusMessage('Đang tải bản cập nhật...');
        setDownloadProgress(25);

        let progressVal = 25;
        const progressInterval = setInterval(() => {
          const step = Math.floor(Math.random() * 3) + 1;
          progressVal = Math.min(progressVal + step, 82);
          setDownloadProgress(progressVal);
        }, 150);

        let filesystemListener: any = null;
        try {
          filesystemListener = await Filesystem.addListener('progress' as any, (progress: any) => {
            const bytes = progress.bytes || progress.bytesWritten || 0;
            const total = progress.chunk || progress.contentLength || 0;
            if (total > 0) {
              const realPercent = Math.round((bytes / total) * 100);
              progressVal = Math.max(progressVal, Math.min(realPercent, 84));
              setDownloadProgress(progressVal);
            }
          });
        } catch (listenerErr) {
          console.warn('Filesystem progress listener warning:', listenerErr);
        }

        let savedUri = '';
        try {
          const downloadRes = await Filesystem.downloadFile({
            url: targetLink,
            path: fileName,
            directory: Directory.Cache,
            progress: true,
          });

          clearInterval(progressInterval);
          if (filesystemListener) {
            filesystemListener.remove();
          }

          if (downloadRes.path) {
            savedUri = downloadRes.path;
          } else {
            const uriRes = await Filesystem.getUri({ path: fileName, directory: Directory.Cache });
            savedUri = uriRes.uri;
          }
          setDownloadProgress(88);
        } catch (downloadErr) {
          clearInterval(progressInterval);
          if (filesystemListener) {
            filesystemListener.remove();
          }

          console.warn('Filesystem download failed, fallback to fetch:', downloadErr);
          setStatusMessage('Đang tải dữ liệu...');
          setDownloadProgress(40);

          let fetchProgressVal = 40;
          const fetchInterval = setInterval(() => {
            const step = Math.floor(Math.random() * 2) + 1;
            fetchProgressVal = Math.min(fetchProgressVal + step, 68);
            setDownloadProgress(fetchProgressVal);
          }, 180);

          const response = await fetch(targetLink, { redirect: 'follow' });
          if (!response.ok) {
            clearInterval(fetchInterval);
            throw new Error('Không thể tải tệp APK.');
          }
          const blob = await response.blob();

          clearInterval(fetchInterval);
          setDownloadProgress(75);
          setStatusMessage('Đang lưu tệp...');

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
        setStatusMessage('Đang mở cài đặt...');

        try {
          await FileOpener.open({
            filePath: savedUri,
            contentType: 'application/vnd.android.package-archive',
          });
          setDownloadProgress(100);
        } catch (fileOpenerErr) {
          console.warn('FileOpener fallback to share intent:', fileOpenerErr);
          const formattedUri = savedUri.startsWith('file://') || savedUri.startsWith('content://')
            ? savedUri
            : `file://${savedUri.startsWith('/') ? '' : '/'}${savedUri}`;

          try {
            await Share.share({
              title: `Cập nhật v${updateInfo.version}`,
              url: formattedUri,
            });
          } catch (shareErr) {
            console.warn('Share intent error, open in browser:', shareErr);
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
      setStatusMessage('Chuyển sang trình duyệt...');
      setTimeout(() => {
        try {
          window.open(targetLink, '_system') || (window.location.href = targetLink);
        } catch {}
        setIsDownloading(false);
      }, 800);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div 
        className="absolute inset-0 bg-slate-950/60 backdrop-blur-xs transition-opacity" 
        onClick={!isDownloading ? onClose : undefined}
      />

      <div className="relative w-full max-w-sm rounded-3xl bg-white border border-slate-100 shadow-2xl p-5 text-slate-800 flex flex-col space-y-4">
        {!isDownloading && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition cursor-pointer"
            aria-label="Đóng"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Header gọn gàng, phong cách mobile-first */}
        <div className="flex items-center gap-3 pt-0.5">
          <div className="w-10 h-10 rounded-2xl bg-sky-50 text-[#0284C7] flex items-center justify-center shrink-0 border border-sky-100 shadow-3xs">
            {isDownloading ? (
              <Loader2 className="w-5 h-5 animate-spin text-[#0284C7]" />
            ) : (
              <ArrowUpCircle className="w-5 h-5 text-[#0284C7]" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-black tracking-tight text-slate-900 leading-tight">
              {isDownloading ? `Đang tải v${updateInfo.version}` : `Cập nhật v${updateInfo.version}`}
            </h2>
            <p className="text-xs text-slate-500 font-medium mt-0.5">
              {isDownloading ? statusMessage : `Bản hiện tại: v${currentVersion}`}
            </p>
          </div>
        </div>

        {/* Nội dung tương tác */}
        {isDownloading ? (
          <div className="space-y-3 py-1">
            <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
              <div 
                className="bg-[#0284C7] h-full rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-slate-500 font-medium">
              <span>{statusMessage}</span>
              <span className="text-[#0284C7] font-bold">{downloadProgress}%</span>
            </div>
            <div className="text-center pt-1 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  const targetLink = updateInfo.apkUrl || updateInfo.downloadUrl;
                  if (targetLink) window.open(targetLink, '_system') || (window.location.href = targetLink);
                }}
                className="text-xs text-[#0284C7] hover:underline font-semibold cursor-pointer"
              >
                Tải qua trình duyệt
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Changelog ngắn gọn, súc tích */}
            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              <ul className="space-y-1.5 text-slate-700 text-xs">
                {updateInfo.changelog && updateInfo.changelog.length > 0 ? (
                  updateInfo.changelog.map((item, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                      <span className="leading-snug">{item}</span>
                    </li>
                  ))
                ) : (
                  <li className="text-slate-500 text-xs py-1">
                    {updateInfo.notes || 'Cải thiện hiệu năng và tối ưu trải nghiệm.'}
                  </li>
                )}
              </ul>
            </div>

            {/* Nút hành động */}
            <div className="flex gap-2.5 pt-1">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition cursor-pointer"
              >
                Để sau
              </button>
              <button
                onClick={handleUpdate}
                className="flex-1 py-2 rounded-xl bg-[#0284C7] hover:bg-[#0369a1] text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-xs transition active:scale-[0.98] cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 shrink-0" />
                <span>Cập nhật</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
