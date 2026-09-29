import React, { useState, useRef } from 'react';
import { X, Settings as SettingsIcon, Check, RefreshCw, ArrowUpCircle, Sparkles, Pause, Loader2, CopyCheck } from 'lucide-react';
import { LibrarySettings, BookRecord } from '../types';
import { useToast } from '../context/ToastContext';
import { CURRENT_APP_VERSION } from '../version';
import { batchNormalize } from '../utils/geminiService';
import { deduplicateBookList, groupDuplicateBooks, groupDuplicateBooksAsync, DuplicateGroup } from '../utils/fuzzyMatcher';
import { saveAllLocalBooks } from '../utils/localBooksStorage';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: LibrarySettings;
  onSaveSettings: (newSettings: LibrarySettings) => Promise<void>;
  onResetMasterData?: () => Promise<void>;
  onCheckUpdates?: () => void;
  books?: BookRecord[];
  onBatchUpdateBooks?: (updatedBooksList: BookRecord[]) => Promise<void>;
  onBatchDeleteBooks?: (idsToDelete: string[]) => Promise<void>;
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
  onBatchDeleteBooks,
  isAutoNormalizing = false,
}) => {
  const { showToast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isDeduplicating, setIsDeduplicating] = useState(false);
  const [dedupProgress, setDedupProgress] = useState<{ percent: number; current: number; total: number } | null>(null);

  // States cho xử lý trùng lặp chọn lọc thủ công
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[] | null>(null);
  const [selectedKeepIds, setSelectedKeepIds] = useState<Record<string, string[]>>({});

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
    setDedupProgress({ percent: 0, current: 0, total: books.length });
    try {
      const groups = await groupDuplicateBooksAsync(books, (percent, current, total) => {
        setDedupProgress({ percent, current, total });
      });
      if (groups.length > 0) {
        // Mặc định chọn giữ lại cuốn đầu tiên trong từng nhóm trùng lặp (người dùng có thể tích chọn thêm nhiều cuốn để giữ lại)
        const selections: Record<string, string[]> = {};
        groups.forEach((g) => {
          selections[g.id] = [g.books[0].id];
        });
        setDuplicateGroups(groups);
        setSelectedKeepIds(selections);
      } else {
        showToast('Kho sách hoàn toàn sạch sẽ, không tìm thấy cuốn nào bị trùng!', 'success');
      }
    } catch (err: any) {
      showToast(`Lỗi khi quét sách trùng: ${err.message}`, 'error');
    } finally {
      setIsDeduplicating(false);
      setDedupProgress(null);
    }
  };

  const handleConfirmKeepDuplicates = async () => {
    if (!duplicateGroups) return;

    // Kiểm tra nếu có nhóm nào bị bỏ chọn toàn bộ cuốn
    const emptyGroup = duplicateGroups.find((g) => (selectedKeepIds[g.id] || []).length === 0);
    if (emptyGroup) {
      showToast('Mỗi nhóm cần giữ lại ít nhất 1 cuốn sách để tránh làm mất sách!', 'warning');
      return;
    }

    setIsSaving(true);
    try {
      const idsToDelete = new Set<string>();
      duplicateGroups.forEach((group) => {
        const keepIds = new Set(selectedKeepIds[group.id] || []);
        group.books.forEach((book) => {
          // Nếu cuốn sách không được tích chọn giữ lại -> xóa khỏi kho
          if (!keepIds.has(book.id)) {
            idsToDelete.add(book.id);
          }
        });
      });

      if (idsToDelete.size === 0) {
        showToast('Bạn đã chọn giữ lại toàn bộ sách, không có cuốn nào bị xóa.', 'info');
        setDuplicateGroups(null);
        return;
      }

      const deleteIdsList = Array.from(idsToDelete);
      if (onBatchDeleteBooks) {
        await onBatchDeleteBooks(deleteIdsList);
      } else {
        const remainingBooks = books.filter((b) => !idsToDelete.has(b.id));
        saveAllLocalBooks(remainingBooks);
        if (onBatchUpdateBooks) {
          await onBatchUpdateBooks(remainingBooks);
        }
      }

      showToast(`Đã dọn dẹp thành công! Đã xóa ${idsToDelete.size} cuốn trùng và giữ lại các cuốn đã chọn.`, 'success');
      setDuplicateGroups(null);
    } catch (err: any) {
      showToast(`Lỗi khi gộp dọn sách trùng: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
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
        {!duplicateGroups ? (
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
        ) : (
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0" />
              <div>
                <h3 className="text-xs sm:text-sm font-bold text-slate-800 leading-tight">
                  Phát hiện <strong className="text-emerald-700 font-extrabold">{duplicateGroups.length}</strong> nhóm sách trùng
                </h3>
                <p className="text-[10px] text-slate-500 mt-0.5">Tích chọn các cuốn muốn giữ lại trong kho</p>
              </div>
            </div>
            <button
              onClick={() => setDuplicateGroups(null)}
              className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 active:scale-95 transition"
              aria-label="Đóng"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Content & Footer */}
        {duplicateGroups ? (
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* List các nhóm trùng */}
            <div className="p-4 space-y-3.5 overflow-y-auto flex-1 bg-slate-50">
              {duplicateGroups.map((group, groupIdx) => {
                const groupKeepIds = selectedKeepIds[group.id] || [];
                const isAllSelected = group.books.length > 0 && group.books.every((b) => groupKeepIds.includes(b.id));

                return (
                  <div key={group.id} className="bg-white border border-slate-200/80 rounded-2xl p-3 shadow-2xs space-y-2.5">
                    {/* Header từng nhóm */}
                    <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-bold text-slate-800 bg-slate-100 px-2 py-0.5 rounded-md">
                          Nhóm #{groupIdx + 1}
                        </span>
                        <span className="text-[10px] text-slate-500 font-medium">
                          ({group.books.length} cuốn)
                        </span>
                        {group.reason && (
                          <span className="text-[9px] text-emerald-700 bg-emerald-50 border border-emerald-200/60 px-1.5 py-0.5 rounded">
                            {group.reason}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const allIds = group.books.map((b) => b.id);
                          setSelectedKeepIds((prev) => ({
                            ...prev,
                            [group.id]: isAllSelected ? [group.books[0].id] : allIds,
                          }));
                        }}
                        className="text-[10.5px] text-emerald-600 font-bold hover:text-emerald-700 transition active:scale-95 shrink-0 ml-2"
                      >
                        {isAllSelected ? 'Chỉ giữ 1 cuốn' : 'Giữ lại tất cả'}
                      </button>
                    </div>

                    {/* Danh sách sách trong nhóm */}
                    <div className="space-y-1.5">
                      {group.books.map((book, bookIdx) => {
                        const isSelected = groupKeepIds.includes(book.id);
                        return (
                          <div
                            key={book.id}
                            onClick={() => {
                              setSelectedKeepIds((prev) => {
                                const currentList = prev[group.id] || [];
                                const exists = currentList.includes(book.id);
                                const updated = exists
                                  ? currentList.filter((id) => id !== book.id)
                                  : [...currentList, book.id];
                                return { ...prev, [group.id]: updated };
                              });
                            }}
                            className={`flex items-start gap-2.5 p-2 rounded-xl border transition cursor-pointer select-none active:scale-[0.99] ${
                              isSelected
                                ? 'border-emerald-500 bg-emerald-50/40 shadow-xs'
                                : 'border-slate-100 hover:border-slate-200 bg-slate-50/30 opacity-70'
                            }`}
                          >
                            <div className="mt-0.5 shrink-0">
                              <div
                                className={`w-4 h-4 rounded-md border flex items-center justify-center transition ${
                                  isSelected
                                    ? 'border-emerald-600 bg-emerald-600 text-white shadow-xs'
                                    : 'border-slate-300 bg-white hover:border-slate-400'
                                }`}
                              >
                                {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                              </div>
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <div className="font-bold text-slate-800 text-xs leading-snug break-words">
                                  {book.title}
                                </div>
                                {bookIdx === 0 && (
                                  <span className="shrink-0 text-[8.5px] font-semibold text-emerald-700 bg-emerald-100/70 px-1.5 py-0.2 rounded">
                                    Ưu tiên
                                  </span>
                                )}
                              </div>
                              <div className="text-slate-500 text-[10px] mt-0.5">
                                Tác giả: <strong className="text-slate-700">{book.author || 'Khuyết danh'}</strong>
                              </div>
                              {(book.publisher || book.category) && (
                                <div className="text-slate-400 text-[9px] mt-0.5 flex items-center gap-1.5 flex-wrap">
                                  {book.publisher && <span>NXB: {book.publisher}</span>}
                                  {book.category && (
                                    <span className="bg-slate-100 px-1 py-0.2 rounded text-slate-500">
                                      {book.category}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Confirm & Cancel Buttons */}
            {(() => {
              const totalToDelete = duplicateGroups.reduce((acc, g) => {
                const keepCount = (selectedKeepIds[g.id] || []).length;
                return acc + Math.max(0, g.books.length - keepCount);
              }, 0);

              return (
                <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100 flex gap-2.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setDuplicateGroups(null)}
                    className="flex-1 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200/60 rounded-xl transition active:scale-95 whitespace-nowrap"
                  >
                    Hủy bỏ
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmKeepDuplicates}
                    disabled={isSaving}
                    className="flex-[2] flex items-center justify-center gap-1.5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition disabled:opacity-50 active:scale-95 whitespace-nowrap"
                  >
                    {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    {totalToDelete > 0
                      ? `Xác nhận (Xóa ${totalToDelete} cuốn trùng)`
                      : 'Giữ lại tất cả các cuốn'}
                  </button>
                </div>
              );
            })()}
          </div>
        ) : (
          <>
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
                  Quét toàn bộ {totalBooks} cuốn &amp; đối chiếu thông minh
                </span>
              </div>
              <button
                type="button"
                onClick={handleManualDeduplicate}
                disabled={isDeduplicating}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl transition shadow-xs disabled:opacity-50 whitespace-nowrap active:scale-95 shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isDeduplicating ? 'animate-spin' : ''}`} />
                <span>{isDeduplicating ? (dedupProgress ? `Quét ${dedupProgress.percent}%` : 'Đang quét...') : 'Lọc trùng ngay'}</span>
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
          </>
        )}
      </div>
    </div>
  );
};
