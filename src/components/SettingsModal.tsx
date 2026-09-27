import React, { useState, useRef } from 'react';
import { X, Settings as SettingsIcon, Tag, Plus, Trash2, Check, RefreshCw, ArrowUpCircle, Sparkles, AlertCircle, Play, Pause, Loader2 } from 'lucide-react';
import { LibrarySettings, BookRecord } from '../types';
import { useToast } from '../context/ToastContext';
import { CURRENT_APP_VERSION } from '../version';
import { batchNormalize } from '../utils/geminiService';

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
  const [categories, setCategories] = useState<string[]>(settings.categoriesList || []);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // States cho chuẩn hóa bằng AI
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [currentBatchText, setCurrentBatchText] = useState('');
  const [processedCount, setProcessedCount] = useState(0);
  const stopNormalizingRef = useRef(false);

  const totalBooks = books.length;
  const normalizedCount = books.filter((b) => b.is_ai_normalized).length;
  const pendingBooks = books.filter((b) => !b.is_ai_normalized);

  const handleStartNormalize = async () => {
    if (!onBatchUpdateBooks || pendingBooks.length === 0) return;

    setIsNormalizing(true);
    stopNormalizingRef.current = false;
    let localPending = [...pendingBooks];
    let currentProcessed = 0;

    showToast(`Bắt đầu dọn dẹp & chuẩn hóa ${localPending.length} cuốn sách bằng AI...`, 'info');

    while (localPending.length > 0 && !stopNormalizingRef.current) {
      // Mỗi lô xử lý tối đa 8 cuốn sách để vừa nhanh vừa không quá tải API
      const batch = localPending.slice(0, 8);
      const titlesStr = batch.map((b) => `"${b.title}"`).join(', ');
      setCurrentBatchText(`Đang chuẩn hóa: ${titlesStr}`);

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
      showToast('Chúc mừng! 100% kho sách của bạn đã được chuẩn hóa đạt chuẩn 5 sao!', 'success');
    }
  };

  const handleStopNormalize = () => {
    stopNormalizingRef.current = true;
    setCurrentBatchText('Đang hoàn thành lô hiện tại rồi dừng...');
  };

  if (!isOpen) return null;

  const handleAddCategory = () => {
    if (!newCategoryInput.trim()) return;
    if (categories.includes(newCategoryInput.trim())) {
      showToast('Thể loại này đã tồn tại!', 'info');
      return;
    }
    setCategories([...categories, newCategoryInput.trim()]);
    setNewCategoryInput('');
  };

  const handleRemoveCategory = (cat: string) => {
    setCategories(categories.filter((c) => c !== cat));
  };

  const handleSaveAll = async () => {
    setIsSaving(true);
    try {
      await onSaveSettings({
        ...settings,
        categoriesList: categories,
      });
      showToast('Đã lưu cấu hình kho sách thành công!', 'success');
      onClose();
    } catch (err: any) {
      showToast(`Lỗi khi lưu cài đặt: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetData = async () => {
    if (!onResetMasterData) return;
    if (window.confirm('Khôi phục toàn bộ 591 cuốn sách gốc từ file và xóa sạch dữ liệu trùng lặp/mẫu cũ?')) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-lg w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-slate-200 text-slate-700 flex items-center justify-center shrink-0">
              <SettingsIcon className="w-4.5 h-4.5" />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-900 leading-tight">Cấu Hình Kho Sách</h3>
              <p className="text-[10px] text-slate-500">Thể loại &amp; CSDL Gốc</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 overflow-y-auto">
          {/* Quản lý danh sách Thể loại */}
          <div className="space-y-2">
            <label className="block text-[11px] font-extrabold text-slate-700 uppercase tracking-wider">
              Danh mục Thể loại sách
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newCategoryInput}
                onChange={(e) => setNewCategoryInput(e.target.value)}
                placeholder="Thêm thể loại mới (e.g. Văn học, Kinh tế...)"
                className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-slate-400"
                onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
              />
              <button
                onClick={handleAddCategory}
                className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold flex items-center gap-1 transition shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Thêm</span>
              </button>
            </div>

            <div className="flex flex-wrap gap-1 pt-1 max-h-36 overflow-y-auto">
              {categories.map((cat) => (
                <span
                  key={cat}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-50 text-slate-800 text-[11px] font-bold rounded-lg border border-slate-250 shadow-2xs"
                >
                  <Tag className="w-3 h-3 text-slate-500" />
                  <span>{cat}</span>
                  <button
                    onClick={() => handleRemoveCategory(cat)}
                    className="ml-0.5 text-slate-400 hover:text-rose-600 p-0.5"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* AI Dọn Dẹp & Chuẩn Hóa Toàn Kho */}
          {onBatchUpdateBooks && (
            <div className="pt-3 border-t border-slate-100">
              <div className="p-3 bg-gradient-to-r from-purple-50/50 to-indigo-50/50 rounded-2xl border border-purple-100 flex flex-col gap-2.5 shadow-2xs">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-extrabold text-purple-950 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-purple-600 animate-pulse" />
                    AI Chuẩn Hóa 5 Sao (Gemini Lite)
                  </span>
                  <span className="text-[10px] font-mono text-purple-800 font-extrabold bg-purple-100/50 px-1.5 py-0.5 rounded-md">
                    {normalizedCount}/{totalBooks} cuốn
                  </span>
                </div>

                <p className="text-[10px] text-purple-800 leading-normal">
                  Sửa chính tả, chuẩn hóa có dấu chuẩn mực cho tên tác giả/NXB và tự động phân loại. Sách đã chuẩn hóa sẽ được đánh dấu để bỏ qua không quét lại lần sau.
                </p>

                {/* Công tắc gạt (Toggle Switch) cho chuẩn hóa tự động ngầm */}
                <div className="flex items-center justify-between p-2 bg-white/50 border border-purple-100/30 rounded-xl">
                  <div className="max-w-[75%]">
                    <span className="text-[10.5px] font-bold text-purple-950 block">Chuẩn hóa tự động ngầm</span>
                    <span className="text-[9px] text-purple-800/80 leading-tight block">
                      Tự sửa và gắn nhãn có dấu chuẩn mực ngầm khi có công tắc gạt ON.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onSaveSettings({
                        ...settings,
                        autoNormalizeEnabled: !settings.autoNormalizeEnabled,
                      });
                      showToast(
                        !settings.autoNormalizeEnabled
                          ? 'Đã bật chế độ tự động chuẩn hóa ngầm!'
                          : 'Đã tắt chế độ tự động chuẩn hóa ngầm!',
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
                  <div className="p-2 bg-white/60 border border-purple-100/50 rounded-xl space-y-1">
                    <div className="flex items-center gap-1.5 text-[9.5px] font-extrabold text-purple-900">
                      <Loader2 className="w-3 h-3 animate-spin text-purple-600 shrink-0" />
                      <span className="truncate">{currentBatchText || 'Đang chuẩn hóa...'}</span>
                    </div>
                  </div>
                )}

                {isAutoNormalizing && !isNormalizing && (
                  <div className="p-2 bg-emerald-50/60 border border-emerald-100/50 rounded-xl">
                    <div className="flex items-center gap-1.5 text-[9.5px] font-extrabold text-emerald-900">
                      <Loader2 className="w-3 h-3 animate-spin text-emerald-600 shrink-0" />
                      <span>Đang chuẩn hóa ngầm toàn bộ kho sách...</span>
                    </div>
                  </div>
                )}

                {/* Nút bấm thủ công chỉ hiển thị/khả dụng khi công tắc gạt OFF */}
                {!settings.autoNormalizeEnabled && (
                  <div className="flex gap-2 pt-1">
                    {!isNormalizing ? (
                      <button
                        type="button"
                        onClick={handleStartNormalize}
                        disabled={pendingBooks.length === 0}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-purple-600 hover:bg-purple-700 text-white text-[11px] font-bold rounded-xl transition shadow-xs disabled:opacity-40"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>{pendingBooks.length === 0 ? 'Toàn bộ kho đã chuẩn hóa' : `Chuẩn hóa ${pendingBooks.length} cuốn chưa đạt chuẩn`}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleStopNormalize}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-bold rounded-xl transition shadow-xs"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        <span>Tạm dừng dọn dẹp AI</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Quản lý cập nhật phiên bản */}
          <div className="pt-3 border-t border-slate-100">
            <div className="p-3 bg-slate-50/50 rounded-2xl border border-slate-200/60 flex items-center justify-between gap-3">
              <div>
                <span className="text-[11px] font-extrabold text-slate-800 flex items-center gap-1.5">
                  <ArrowUpCircle className="w-4 h-4 text-emerald-600" />
                  Phiên bản ứng dụng
                </span>
                <span className="text-[10px] text-slate-500 block mt-0.5">
                  Bản hiện tại: <strong className="text-slate-700 font-extrabold">v{CURRENT_APP_VERSION}</strong>
                </span>
              </div>
              {onCheckUpdates && (
                <button
                  type="button"
                  onClick={onCheckUpdates}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold rounded-xl transition shadow-xs whitespace-nowrap"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Cập nhật</span>
                </button>
              )}
            </div>
          </div>

          {/* Nạp lại dữ liệu gốc */}
          {onResetMasterData && (
            <div className="pt-3 border-t border-slate-100">
              <div className="p-3 bg-amber-50/40 rounded-2xl border border-amber-100 flex flex-col gap-1.5">
                <span className="text-[11px] font-extrabold text-amber-950">Dữ liệu danh mục gốc (591 cuốn)</span>
                <span className="text-[10px] text-amber-800 leading-normal">
                  Nạp lại toàn bộ 591 cuốn sách gốc để khôi phục và dọn dẹp kho sách chuẩn.
                </span>
                <button
                  type="button"
                  onClick={handleResetData}
                  disabled={isResetting}
                  className="mt-1 self-start flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold rounded-xl transition shadow-xs disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isResetting ? 'animate-spin' : ''}`} />
                  <span>Nạp Lại Dữ Liệu Gốc</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2.5">
          <button
            onClick={onClose}
            className="px-3.5 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200/60 rounded-xl transition h-9 flex items-center"
          >
            Đóng
          </button>
          <button
            onClick={handleSaveAll}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition disabled:opacity-50 h-9"
          >
            <Check className="w-4 h-4" />
            <span>Lưu Cấu Hình</span>
          </button>
        </div>
      </div>
    </div>
  );
};
