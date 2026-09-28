import React, { useState, useRef } from 'react';
import { X, Settings as SettingsIcon, Check, RefreshCw, ArrowUpCircle, Sparkles, Pause, Loader2, CopyCheck } from 'lucide-react';
import { LibrarySettings, BookRecord } from '../types';
import { useToast } from '../context/ToastContext';
import { CURRENT_APP_VERSION } from '../version';
import { batchNormalize } from '../utils/geminiService';
import { deduplicateBookList } from '../utils/fuzzyMatcher';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: LibrarySettings;
  onSaveSettings: (newSettings: LibrarySettings) => Promise<void>;
  onResetMasterData?: () => Promise<void>;
  onCheckUpdates?: () => void;
  books?: BookRecord[];
  onBatchUpdateBooks?: (updatedBooksList: BookRecord[]) => Promise<void>;
  isAutoNormalizing?: boolean;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  onResetMasterData,
  onCheckUpdates,
  books = [],
  onBatchUpdateBooks,
  isAutoNormalizing = false,
}) => {
  const { showToast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isDeduplicating, setIsDeduplicating] = useState(false);

  // States cho chuẩn hóa bằng AI
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [currentBatchText, setCurrentBatchText] = useState('');
  const [, setProcessedCount] = useState(0);
  const stopNormalizingRef = useRef(false);

  const totalBooks = books.length;
  const normalizedCount = books.filter((b) => b.is_ai_normalized).length;
  const pendingBooks = books.filter((b) => !b.is_ai_normalized);

  if (!isOpen) return null;

  const handleStartNormalize = async () => {
    if (!onBatchUpdateBooks || pendingBooks.length === 0) return;

    setIsNormalizing(true);
    stopNormalizingRef.current = false;
    let localPending = [...pendingBooks];
    let currentProcessed = 0;

    showToast(`Bắt đầu chuẩn hóa ${localPending.length} cuốn sách...`, 'info');

    while (localPending.length > 0 && !stopNormalizingRef.current) {
      const batch = localPending.slice(0, 8);
      const titlesStr = batch.map((b) => `"${b.title}"`).join(', ');
      setCurrentBatchText(`Đang xử lý: ${titlesStr}`);

      try {
        const data = await batchNormalize(batch);

        if (data.success && Array.isArray(data.normalized)) {
          const updatedList: BookRecord[] = data.normalized.map((normItem: any) => {
            const orig = batch.find((b) => b.id === normItem.id);
            return {
              ...orig,
              title: normItem.title,
              author: normItem.author,
              publisher: normItem.publisher,
              category: normItem.category,
              is_ai_normalized: true,
              updated_at: Date.now(),
            } as BookRecord;
          });

          await onBatchUpdateBooks(updatedList);
          currentProcessed += batch.length;
          setProcessedCount(currentProcessed);
        }
      } catch (err: any) {
        console.error('Lỗi khi chuẩn hóa lô:', err);
      }

      localPending = localPending.slice(batch.length);
    }

    setIsNormalizing(false);
    setCurrentBatchText('');
    setProcessedCount(0);

    if (stopNormalizingRef.current) {
      showToast('Đã dừng chuẩn hóa AI!', 'info');
    } else {
      showToast('Toàn bộ kho sách đã được chuẩn hóa thành công!', 'success');
    }
  };

  const handleStopNormalize = () => {
    stopNormalizingRef.current = true;
    setCurrentBatchText('Đang hoàn thành lô rồi dừng...');
  };

  const handleResetAiStatus = async () => {
    if (!onBatchUpdateBooks || books.length === 0) return;
    const resetList: BookRecord[] = books.map((b) => ({
      ...b,
      is_ai_normalized: false,
    }));
    await onBatchUpdateBooks(resetList);
    showToast(`Đã đặt lại cờ AI cho ${books.length} cuốn sách! AI sẽ bắt đầu phân loại lại chi tiết.`, 'success');
  };

  const handleManualDeduplicate = async () => {
    if (!books || books.length === 0) return;
    setIsDeduplicating(true);
    try {
      const { cleanBooks, mergedCount } = deduplicateBookList(books);
      if (mergedCount > 0 && onBatchUpdateBooks) {
        await onBatchUpdateBooks(cleanBooks);
        showToast(`Đã tự động gộp & dọn dẹp thành công ${mergedCount} cuốn sách trùng lặp! Kho sách sạch sẽ hoàn toàn.`, 'success');
      } else {
        showToast('Kho sách hoàn toàn sạch sẽ, không tìm thấy cuốn nào bị trùng!', 'success');
      }
    } catch (err: any) {
      showToast(`Lỗi khi dọn dẹp sách trùng: ${err.message}`, 'error');
    } finally {
      setIsDeduplicating(false);
    }
  };

  const handleSaveAll = async () => {
    setIsSaving(true);
    try {
      await onSaveSettings({
        ...settings,
      });
      showToast('Đã lưu cấu hình thành công!', 'success');
      onClose();
    } catch (err: any) {
      showToast(`Lỗi khi lưu: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetData = async () => {
    if (!onResetMasterData) return;
    if (window.confirm('Khôi phục 591 cuốn sách gốc và dọn dẹp kho sách?')) {
      try {
        setIsResetting(true);
        await onResetMasterData();
        showToast('Đã nạp 591 cuốn sách gốc thành công!', 'success');
        onClose();
      } catch {
        showToast('Lỗi khi nạp dữ liệu', 'error');
      } finally {
        setIsResetting(false);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-slate-200 text-slate-700 flex items-center justify-center shrink-0">
              <SettingsIcon className="w-4.5 h-4.5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 leading-tight">Cấu Hình Kho Sách</h3>
              <p className="text-[10px] text-slate-500">Chuẩn hóa &amp; Tùy chọn hệ thống</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 active:scale-95 transition"
            aria-label="Đóng"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3.5 overflow-y-auto flex-1">
          {/* 1. Tự động dọn dẹp sách trùng lặp */}
          {onBatchUpdateBooks && (
            <div className="p-3 bg-emerald-50/70 rounded-2xl border border-emerald-100 flex items-center justify-between gap-3">
              <div>
                <span className="text-xs font-bold text-emerald-950 flex items-center gap-1.5">
                  <CopyCheck className="w-4 h-4 text-emerald-600" />
                  Dọn dẹp sách trùng lặp
                </span>
                <span className="text-[10px] text-emerald-800 block mt-0.5">
                  Quét toàn bộ {totalBooks} cuốn &amp; tự động gộp sách trùng
                </span>
              </div>
              <button
                type="button"
                onClick={handleManualDeduplicate}
                disabled={isDeduplicating}
                className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl transition shadow-xs disabled:opacity-50 whitespace-nowrap active:scale-95"
              >
                <RefreshCw className={`w-3 h-3 ${isDeduplicating ? 'animate-spin' : ''}`} />
                <span>Lọc trùng ngay</span>
              </button>
            </div>
          )}

          {/* 2. AI Chuẩn Hóa */}
          {onBatchUpdateBooks && (
            <div className="p-3 bg-purple-50/60 rounded-2xl border border-purple-100 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-purple-950 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-purple-600" />
                  Chuẩn hóa AI (Gemini)
                </span>
                <span className="text-[10.5px] font-mono text-purple-800 font-bold bg-purple-100 px-2 py-0.5 rounded-md">
                  {normalizedCount}/{totalBooks} cuốn
                </span>
              </div>

              {/* Công tắc tự động ngầm */}
              <div className="flex items-center justify-between p-2 bg-white/70 border border-purple-100 rounded-xl">
                <span className="text-xs font-semibold text-purple-950">Chuẩn hóa tự động ngầm</span>
                <button
                  type="button"
                  onClick={() => {
                    onSaveSettings({
                      ...settings,
                      autoNormalizeEnabled: !settings.autoNormalizeEnabled,
                    });
                    showToast(
                      !settings.autoNormalizeEnabled
                        ? 'Đã bật chuẩn hóa tự động ngầm!'
                        : 'Đã tắt chuẩn hóa tự động ngầm!',
                      'success'
                    );
                  }}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    settings.autoNormalizeEnabled ? 'bg-purple-600' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                      settings.autoNormalizeEnabled ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Thanh tiến trình */}
              <div className="w-full bg-slate-200/60 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-purple-600 h-full rounded-full transition-all duration-300"
                  style={{ width: `${totalBooks > 0 ? (normalizedCount / totalBooks) * 100 : 0}%` }}
                />
              </div>

              {isNormalizing && (
                <div className="p-2 bg-white/80 border border-purple-100 rounded-xl">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-purple-900">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-600 shrink-0" />
                    <span className="truncate">{currentBatchText || 'Đang xử lý...'}</span>
                  </div>
                </div>
              )}

              {isAutoNormalizing && !isNormalizing && (
                <div className="p-2 bg-emerald-50 border border-emerald-100 rounded-xl">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-900">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" />
                    <span>Đang chuẩn hóa ngầm toàn bộ kho sách...</span>
                  </div>
                </div>
              )}

              {/* Nút đặt lại trạng thái để AI quét lại chuyên sâu */}
              <div className="pt-1.5 flex items-center justify-between gap-2 border-t border-purple-100/80">
                <span className="text-[10px] text-slate-500">Phân loại lại thể loại chuyên sâu:</span>
                <button
                  type="button"
                  onClick={handleResetAiStatus}
                  disabled={isNormalizing || isAutoNormalizing}
                  className="px-2.5 py-1 bg-purple-100 hover:bg-purple-200 text-purple-800 text-[11px] font-bold rounded-lg transition active:scale-95 disabled:opacity-50 shrink-0 flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Đặt lại AI</span>
                </button>
              </div>

              {/* Nút thủ công khi tắt auto */}
              {!settings.autoNormalizeEnabled && (
                <div className="pt-0.5">
                  {!isNormalizing ? (
                    <button
                      type="button"
                      onClick={handleStartNormalize}
                      disabled={pendingBooks.length === 0}
                      className="w-full flex items-center justify-center gap-1.5 py-2 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-xl transition shadow-xs disabled:opacity-40 active:scale-[0.99]"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{pendingBooks.length === 0 ? 'Tất cả đã chuẩn hóa' : `Chuẩn hóa ${pendingBooks.length} cuốn`}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStopNormalize}
                      className="w-full flex items-center justify-center gap-1.5 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl transition shadow-xs active:scale-[0.99]"
                    >
                      <Pause className="w-3.5 h-3.5" />
                      <span>Tạm dừng</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 3. Quản lý cập nhật phiên bản */}
          <div className="pt-2 border-t border-slate-100">
            <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200/80 flex items-center justify-between gap-3">
              <div>
                <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                  <ArrowUpCircle className="w-4 h-4 text-emerald-600" />
                  Phiên bản ứng dụng
                </span>
                <span className="text-[10px] text-slate-500 block mt-0.5">
                  Bản hiện tại: <strong className="text-slate-800 font-bold">v{CURRENT_APP_VERSION}</strong>
                </span>
              </div>
              {onCheckUpdates && (
                <button
                  type="button"
                  onClick={onCheckUpdates}
                  className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl transition shadow-xs whitespace-nowrap active:scale-95"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Cập nhật</span>
                </button>
              )}
            </div>
          </div>

          {/* 4. Nạp lại dữ liệu gốc */}
          {onResetMasterData && (
            <div className="pt-2 border-t border-slate-100">
              <div className="p-3 bg-amber-50/60 rounded-2xl border border-amber-100 flex items-center justify-between gap-3">
                <div>
                  <span className="text-xs font-bold text-amber-950">Dữ liệu mẫu gốc</span>
                  <span className="text-[10px] text-amber-800 block mt-0.5">Khôi phục 591 cuốn ban đầu</span>
                </div>
                <button
                  type="button"
                  onClick={handleResetData}
                  disabled={isResetting}
                  className="flex items-center gap-1 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl transition shadow-xs disabled:opacity-50 whitespace-nowrap active:scale-95"
                >
                  <RefreshCw className={`w-3 h-3 ${isResetting ? 'animate-spin' : ''}`} />
                  <span>Khôi phục</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200/60 rounded-xl transition active:scale-95"
          >
            Đóng
          </button>
          <button
            type="button"
            onClick={handleSaveAll}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition disabled:opacity-50 active:scale-95"
          >
            <Check className="w-4 h-4" />
            <span>Lưu Cấu Hình</span>
          </button>
        </div>
      </div>
    </div>
  );
};
