import React, { useState, useRef } from 'react';
import {
  Camera,
  UploadCloud,
  Sparkles,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Layers,
  Loader2,
  RefreshCw,
  XCircle,
  Square,
} from 'lucide-react';
import { BookRecord, DraftBookItem } from '../types';
import { flagDuplicateDrafts, checkDuplicateBook } from '../utils/fuzzyMatcher';
import { scanImages, enrichBook } from '../utils/geminiService';

interface BatchScannerProps {
  existingBooks: BookRecord[];
  categories: string[];
  onSaveToLibrary: (books: BookRecord[]) => Promise<void>;
  onSwitchToTable: () => void;
}

/**
 * Tự động nén ảnh trên Client Canvas trước khi gửi AI OCR
 * Giúp giải phóng RAM di động (APK) và tăng tốc độ xử lý
 */
function compressImage(file: File, maxWidth = 1200, maxHeight = 1200, quality = 0.85): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxWidth || height > maxHeight) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        } else {
          resolve((e.target?.result as string) || '');
        }
      };
      img.onerror = () => resolve((e.target?.result as string) || '');
      img.src = (e.target?.result as string) || '';
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

const CHUNK_SIZE = 2; // Xử lý mỗi lần tối đa 2 ảnh để tránh timeout và tràn RAM
const MAX_RETRIES_PER_CHUNK = 3; // Thử lại tối đa 3 lần cho mỗi lô bị lỗi

export const BatchScanner: React.FC<BatchScannerProps> = ({
  existingBooks,
  categories,
  onSaveToLibrary,
  onSwitchToTable,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const stopScanRef = useRef(false);

  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({
    currentChunk: 0,
    totalChunks: 0,
    processedImages: 0,
    totalImages: 0,
    booksFound: 0,
    statusMessage: '',
  });

  // Hàng đợi lưu lại các ảnh bị lỗi chưa bóc tách xong để Resume / Retry
  const [failedImagesQueue, setFailedImagesQueue] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('batch_scanner_failed_queue');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Bảng sách đã trích xuất & kiểm trùng (Tự động nạp từ bộ nhớ tạm và tái đánh giá trùng lặp)
  const [draftItems, setDraftItems] = useState<DraftBookItem[]>(() => {
    try {
      const saved = localStorage.getItem('batch_scanner_drafts');
      const parsed = saved ? JSON.parse(saved) : [];
      return parsed.length > 0 ? flagDuplicateDrafts(parsed, existingBooks) : [];
    } catch {
      return [];
    }
  });

  const [isSaving, setIsSaving] = useState(false);
  const [enrichingId, setEnrichingId] = useState<string | null>(null);

  // Đồng bộ hóa trạng thái ra LocalStorage để tránh mất mát dữ liệu khi chuyển Tab
  React.useEffect(() => {
    localStorage.setItem('batch_scanner_drafts', JSON.stringify(draftItems));
  }, [draftItems]);

  React.useEffect(() => {
    localStorage.setItem('batch_scanner_failed_queue', JSON.stringify(failedImagesQueue));
  }, [failedImagesQueue]);

  /**
   * Hàm cốt lõi: Xử lý danh sách ảnh nén theo từng Lô (Chunk),
   * có Tự Động Thử Lại (Retry) khi gặp lỗi mạng/API timeout,
   * và Cập nhật kết quả nối tiếp ngay lập tức vào bảng chờ (Progressive Stream)
   */
  const processImageArrayChunked = async (validImages: string[]) => {
    if (validImages.length === 0) return;

    setIsScanning(true);
    stopScanRef.current = false;

    // Chia danh sách ảnh thành các Lô nhỏ (Mỗi lô 2 ảnh)
    const chunks: string[][] = [];
    for (let i = 0; i < validImages.length; i += CHUNK_SIZE) {
      chunks.push(validImages.slice(i, i + CHUNK_SIZE));
    }

    const totalImages = validImages.length;
    const totalChunks = chunks.length;
    let totalExtractedBooks = 0;
    let processedImagesCount = 0;
    const currentFailedImages: string[] = [];

    setScanProgress({
      currentChunk: 0,
      totalChunks,
      processedImages: 0,
      totalImages,
      booksFound: 0,
      statusMessage: `Bắt đầu xử lý ${totalImages} ảnh (${totalChunks} lô)...`,
    });

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      if (stopScanRef.current) {
        break; // Người dùng chủ động bấm Dừng
      }

      const chunk = chunks[chunkIdx];
      const chunkImageCount = chunk.length;

      setScanProgress((prev) => ({
        ...prev,
        currentChunk: chunkIdx + 1,
        processedImages: processedImagesCount,
        statusMessage: `Đang trích xuất Lô ${chunkIdx + 1}/${totalChunks} (Ảnh ${processedImagesCount + 1}-${processedImagesCount + chunkImageCount}/${totalImages})...`,
      }));

      // Cơ chế Thử lại (Retry) từng Lô tới MAX_RETRIES_PER_CHUNK lần
      let success = false;
      let rawBooks: any[] = [];

      for (let attempt = 1; attempt <= MAX_RETRIES_PER_CHUNK; attempt++) {
        if (stopScanRef.current) break;

        try {
          if (attempt > 1) {
            setScanProgress((prev) => ({
              ...prev,
              statusMessage: `Lô ${chunkIdx + 1}/${totalChunks} gián đoạn, đang tự động thử lại (Lần ${attempt}/${MAX_RETRIES_PER_CHUNK})...`,
            }));
            // Đợi backoff tăng dần (1.2s, 2.4s)
            await new Promise((res) => setTimeout(res, 1200 * attempt));
          }

          const res = await scanImages(chunk, existingBooks);
          if (res && Array.isArray(res.books)) {
            rawBooks = res.books;
            success = true;
            break; // Đã trích xuất thành công!
          }
        } catch (err: any) {
          console.warn(`Lô ${chunkIdx + 1} thử lần ${attempt} thất bại:`, err?.message || err);
        }
      }

      if (success && rawBooks.length > 0) {
        // Chuyển đổi thành Draft items
        const newDrafts: DraftBookItem[] = rawBooks.map((item: any, idx: number) => ({
          tempId: `draft_${Date.now()}_${chunkIdx}_${idx}_${Math.random().toString(36).substring(2, 5)}`,
          title: (item.title || 'Sách chưa đặt tên').trim(),
          author: (item.author || 'Khuyết danh').trim(),
          publisher: (item.publisher || '').trim(),
          category: (item.category || 'Chung').trim(),
          enriched: false,
        }));

        totalExtractedBooks += newDrafts.length;

        // TỰ ĐỘNG CẬP NHẬT TIẾN TRÌNH THỰC TẾ NGAY LẬP TỨC VÀO BẢNG CHỜ (Progressive Stream)
        setDraftItems((prev) => flagDuplicateDrafts([...prev, ...newDrafts], existingBooks));
      } else if (!success) {
        // Lưu các ảnh bị lỗi vào danh sách để Resume/Retry sau
        currentFailedImages.push(...chunk);
      }

      processedImagesCount += chunkImageCount;
      setScanProgress((prev) => ({
        ...prev,
        processedImages: processedImagesCount,
        booksFound: totalExtractedBooks,
      }));
    }

    // Cập nhật danh sách ảnh bị lỗi nếu có
    if (currentFailedImages.length > 0) {
      setFailedImagesQueue((prev) => [...prev, ...currentFailedImages]);
    }

    setIsScanning(false);
  };

  // TỰ ĐỘNG OCR NGAY KHI CHỌN HOẶC CHỤP ẢNH MỚI
  const handleAddAndScanFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList = Array.from(files);
    e.target.value = ''; // Reset input để có thể chọn tiếp

    setIsScanning(true);
    setScanProgress((prev) => ({
      ...prev,
      statusMessage: `Đang nén ${fileList.length} ảnh...`,
    }));

    try {
      // 1. Nén ảnh siêu tốc trên Canvas
      const compressedImages = await Promise.all(fileList.map((file) => compressImage(file)));
      const validImages = compressedImages.filter((img) => img.length > 0);

      if (validImages.length === 0) {
        setIsScanning(false);
        return;
      }

      // 2. Chạy quy trình bóc tách từng Lô có tự động Retry & Resume
      await processImageArrayChunked(validImages);
    } catch (err: any) {
      console.error('Lỗi khi nén hoặc nhận diện ảnh:', err);
      setIsScanning(false);
    }
  };

  // THỬ LẠI CÁC ẢNH BỊ LỖI (RESUME)
  const handleRetryFailedImages = async () => {
    if (failedImagesQueue.length === 0) return;
    const imagesToRetry = [...failedImagesQueue];
    setFailedImagesQueue([]); // Clear queue trước khi chạy lại
    await processImageArrayChunked(imagesToRetry);
  };

  // NÚT DỪNG QUÉT CỦA NGƯỜI DÙNG
  const handleStopScan = () => {
    stopScanRef.current = true;
    setScanProgress((prev) => ({
      ...prev,
      statusMessage: 'Đang dừng bóc tách...',
    }));
  };

  // Cập nhật giá trị một dòng trong Bảng chờ
  const handleUpdateDraft = (draftId: string, updates: Partial<DraftBookItem>) => {
    setDraftItems((prev) => {
      const updated = prev.map((item) => {
        if (item.tempId !== draftId) return item;
        return { ...item, ...updates };
      });
      return flagDuplicateDrafts(updated, existingBooks);
    });
  };

  // Làm giàu dữ liệu bằng AI cho 1 cuốn
  const handleEnrichDraft = async (draftId: string) => {
    const draft = draftItems.find((d) => d.tempId === draftId);
    if (!draft || !draft.title) return;

    setEnrichingId(draftId);
    try {
      const data = await enrichBook(draft.title, draft.author, draft.publisher);
      const enriched = data.enriched;

      if (enriched) {
        handleUpdateDraft(draftId, {
          title: enriched.title || draft.title,
          author: enriched.author || draft.author,
          publisher: enriched.publisher || draft.publisher,
          category: enriched.category || draft.category,
          enriched: true,
        });
      }
    } catch (err: any) {
      console.error('Lỗi tra cứu enrich:', err);
    } finally {
      setEnrichingId(null);
    }
  };

  // Xóa 1 dòng khỏi bảng chờ
  const handleRemoveDraft = (draftId: string) => {
    setDraftItems((prev) => prev.filter((d) => d.tempId !== draftId));
  };

  // Chỉ lưu các cuốn sách mới (chưa trùng) vào kho chính
  const handleSaveAllDrafts = async () => {
    const newDrafts = draftItems.filter((d) => !d.isDuplicate);
    if (newDrafts.length === 0) return;
    setIsSaving(true);

    try {
      const now = Date.now();
      const booksToSave: BookRecord[] = newDrafts.map((draft, idx) => {
        return {
          id: `book_${now}_${idx}_${Math.random().toString(36).substring(2, 5)}`,
          title: draft.title,
          author: draft.author || 'Khuyết danh',
          publisher: draft.publisher || '',
          category: draft.category || 'Chung',
          created_at: now,
          updated_at: now,
          is_ai_normalized: false,
        };
      });

      await onSaveToLibrary(booksToSave);
      
      // Chỉ giữ lại các cuốn sách TRÙNG (bỏ các cuốn mới đã được lưu thành công)
      setDraftItems((prev) => prev.filter((d) => d.isDuplicate));
      onSwitchToTable();
    } catch (err: any) {
      console.error('Lỗi khi lưu sách:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const progressPercent =
    scanProgress.totalImages > 0
      ? Math.round((scanProgress.processedImages / scanProgress.totalImages) * 100)
      : 0;

  return (
    <div className="space-y-3">
      {/* 1. Nút Chụp Ảnh / Thư Viện */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-3.5 sm:p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-black text-slate-900 flex items-center gap-2">
            <span className="p-1.5 bg-emerald-100 text-emerald-800 rounded-xl">
              <Camera className="w-4 h-4" />
            </span>
            <span>Nhập sách nhanh</span>
          </h2>

          <div className="flex items-center gap-2">
            {/* Input Camera */}
            <input
              type="file"
              ref={cameraInputRef}
              accept="image/*"
              capture="environment"
              onChange={handleAddAndScanFiles}
              className="hidden"
            />
            {/* Input Thư viện */}
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              multiple
              onChange={handleAddAndScanFiles}
              className="hidden"
            />

            <button
              onClick={() => cameraInputRef.current?.click()}
              disabled={isScanning}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 active:scale-98 text-white text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-50"
            >
              <Camera className="w-4 h-4" />
              <span>Chụp Ảnh</span>
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isScanning}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-slate-100 hover:bg-slate-200 active:scale-98 text-slate-700 text-xs font-bold rounded-xl transition disabled:opacity-50"
            >
              <UploadCloud className="w-4 h-4 text-slate-600" />
              <span>Thư Viện</span>
            </button>
          </div>
        </div>

        {/* Thanh Tiến Trình Bóc Tách Theo Lô (Real-time Streamed Chunking) */}
        {isScanning && (
          <div className="mt-3 p-3 bg-purple-50/90 border border-purple-200 rounded-xl space-y-2">
            <div className="flex items-center justify-between text-xs font-bold text-purple-950">
              <div className="flex items-center gap-1.5 truncate">
                <Loader2 className="w-4 h-4 animate-spin text-purple-600 shrink-0" />
                <span className="truncate">{scanProgress.statusMessage}</span>
              </div>
              <button
                type="button"
                onClick={handleStopScan}
                className="ml-2 px-2 py-1 bg-purple-200 hover:bg-rose-200 text-purple-900 hover:text-rose-900 rounded-lg text-[11px] font-bold shrink-0 transition flex items-center gap-1 active:scale-95"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>Dừng</span>
              </button>
            </div>

            {/* Thanh Progress */}
            <div className="w-full bg-purple-200/60 rounded-full h-2 overflow-hidden">
              <div
                className="bg-purple-600 h-full rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[10.5px] font-semibold text-purple-800">
              <span>Đã xong: {scanProgress.processedImages}/{scanProgress.totalImages} ảnh ({progressPercent}%)</span>
              <span className="font-bold text-purple-950">Đã bóc tách được: {scanProgress.booksFound} cuốn</span>
            </div>
          </div>
        )}

        {/* Thẻ Cảnh báo & Nút THỬ LẠI / RESUME các ảnh bị lỗi */}
        {!isScanning && failedImagesQueue.length > 0 && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-amber-950 text-xs font-bold">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>Có {failedImagesQueue.length} ảnh bị gián đoạn chưa bóc tách xong.</span>
            </div>
            <button
              type="button"
              onClick={handleRetryFailedImages}
              className="flex items-center gap-1 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold shadow-2xs transition active:scale-95 shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Thử lại {failedImagesQueue.length} ảnh</span>
            </button>
          </div>
        )}
      </div>

      {/* 2. Danh sách đã quét & Kiểm trùng tự động */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-3.5 sm:p-4">
        <div className="flex items-center justify-between gap-3 pb-2.5 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <span className="p-1.5 bg-amber-100 text-amber-700 rounded-xl">
              <Layers className="w-4 h-4" />
            </span>
            <h3 className="text-sm font-black text-slate-900">
              Danh sách đã quét ({draftItems.length})
            </h3>
          </div>

          <div className="flex items-center gap-2">
            {draftItems.length > 0 && (
              <button
                onClick={() => setDraftItems([])}
                className="px-2.5 py-1 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-lg transition"
              >
                Xóa hết
              </button>
            )}

            <button
              onClick={handleSaveAllDrafts}
              disabled={draftItems.filter((d) => !d.isDuplicate).length === 0 || isSaving}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-40"
            >
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              <span>Lưu vào kho ({draftItems.filter((d) => !d.isDuplicate).length})</span>
            </button>
          </div>
        </div>

        {/* Bảng sách trích xuất */}
        {draftItems.length > 0 ? (
          <div className="mt-3 overflow-x-auto border border-slate-100 rounded-xl">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-500 font-extrabold border-b border-slate-100 uppercase tracking-wider text-[11px]">
                  <th className="py-2 px-2 text-center w-7">#</th>
                  <th className="py-2 px-3">Tên Sách</th>
                  <th className="py-2 px-3">Tác Giả</th>
                  <th className="py-2 px-3">Thể Loại</th>
                  <th className="py-2 px-3">NXB</th>
                  <th className="py-2 px-2">Trạng Thái</th>
                  <th className="py-2 px-2 text-right w-14">Xóa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {draftItems.map((draft, idx) => (
                  <tr
                    key={draft.tempId}
                    className={`transition ${
                      draft.isDuplicate
                        ? 'bg-slate-50/70 hover:bg-slate-100 border-l-4 border-l-slate-300 text-slate-400'
                        : 'bg-emerald-50/80 hover:bg-emerald-100/90 border-l-4 border-l-emerald-500 text-emerald-950'
                    }`}
                  >
                    <td className="py-1.5 px-2 text-center font-mono text-slate-500 font-bold text-[11px]">
                      {idx + 1}
                    </td>

                    {/* Tên sách */}
                    <td className="py-1.5 px-2 min-w-[170px]">
                      <input
                        type="text"
                        value={draft.title}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { title: e.target.value })}
                        className={`w-full px-2 py-1 border border-slate-200/80 rounded-lg font-bold focus:outline-none transition text-xs shadow-2xs ${
                          draft.isDuplicate
                            ? 'bg-slate-50/40 focus:bg-white text-slate-800'
                            : 'bg-emerald-50/30 focus:bg-white text-emerald-950'
                        }`}
                      />
                    </td>

                    {/* Tác giả */}
                    <td className="py-1.5 px-2 min-w-[130px]">
                      <input
                        type="text"
                        value={draft.author}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { author: e.target.value })}
                        className={`w-full px-2 py-1 border border-slate-200/80 rounded-lg focus:outline-none transition text-xs shadow-2xs ${
                          draft.isDuplicate
                            ? 'bg-slate-50/40 focus:bg-white text-slate-800'
                            : 'bg-emerald-50/30 focus:bg-white text-emerald-950'
                        }`}
                      />
                    </td>

                    {/* Thể loại */}
                    <td className="py-1.5 px-2 min-w-[110px]">
                      <input
                        type="text"
                        list="cat-suggestions"
                        value={draft.category || 'Chung'}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { category: e.target.value })}
                        className={`w-full px-2 py-1 border border-slate-200/80 rounded-lg focus:outline-none transition text-xs shadow-2xs ${
                          draft.isDuplicate
                            ? 'bg-slate-50/40 focus:bg-white text-slate-800'
                            : 'bg-emerald-50/30 focus:bg-white text-emerald-950'
                        }`}
                      />
                      <datalist id="cat-suggestions">
                        {categories.map((c) => (
                          <option key={c} value={c} />
                        ))}
                      </datalist>
                    </td>

                    {/* NXB */}
                    <td className="py-1.5 px-2 min-w-[100px]">
                      <input
                        type="text"
                        value={draft.publisher || ''}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { publisher: e.target.value })}
                        className={`w-full px-2 py-1 border border-slate-200/80 rounded-lg focus:outline-none transition text-xs shadow-2xs ${
                          draft.isDuplicate
                            ? 'bg-slate-50/40 focus:bg-white text-slate-800'
                            : 'bg-emerald-50/30 focus:bg-white text-emerald-950'
                        }`}
                        placeholder="NXB..."
                      />
                    </td>

                    {/* Trạng thái kiểm trùng */}
                    <td className="py-1.5 px-2 whitespace-nowrap">
                      {draft.isDuplicate ? (
                        <div
                          className="inline-flex items-center gap-1 text-slate-900 bg-slate-200/80 px-2 py-0.5 rounded-md text-[10px] font-bold border border-slate-350 shadow-2xs"
                          title={`Trùng với: "${draft.duplicateMatchTitle}"`}
                        >
                          <AlertTriangle className="w-3 h-3 text-slate-700 shrink-0" />
                          <span>Trùng kho</span>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1 text-emerald-900 bg-emerald-100/90 px-2 py-0.5 rounded-md text-[10px] font-bold border border-emerald-300 shadow-2xs">
                          <CheckCircle2 className="w-3 h-3 text-emerald-700 shrink-0" />
                          <span>Sách mới</span>
                        </div>
                      )}
                    </td>

                    {/* Thao tác */}
                    <td className="py-1.5 px-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleEnrichDraft(draft.tempId)}
                          disabled={enrichingId === draft.tempId}
                          title="Làm giàu dữ liệu AI"
                          className="p-1 text-purple-600 hover:bg-purple-50 rounded-lg transition disabled:opacity-40"
                        >
                          {enrichingId === draft.tempId ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => handleRemoveDraft(draft.tempId)}
                          title="Xóa"
                          className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-3 p-4 text-center bg-slate-50/50 border border-dashed border-slate-200 rounded-xl">
            <p className="text-xs font-bold text-slate-400">
              Chụp hoặc chọn ảnh để tự động nhận diện sách.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
