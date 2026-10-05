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
import { ImageCropModal } from './ImageCropModal';

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

  // States cho tính năng Cắt ảnh (Crop) trước khi OCR
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);

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

    let chunkIdx = 0;
    while (chunkIdx < chunks.length) {
      if (stopScanRef.current) {
        break; // Người dùng chủ động bấm Dừng
      }

      const chunkA = chunks[chunkIdx];
      const chunkB = chunkIdx + 1 < chunks.length ? chunks[chunkIdx + 1] : null;

      if (chunkB) {
        // Có từ 2 lô trở lên -> Quét song song cả 2 Engine: 3.1 Lite & 3.5 Lite
        const chunkAImgCount = chunkA.length;
        const chunkBImgCount = chunkB.length;
        const totalPairImages = chunkAImgCount + chunkBImgCount;

        setScanProgress((prev) => ({
          ...prev,
          currentChunk: chunkIdx + 2,
          processedImages: processedImagesCount,
          statusMessage: `Đang quét song song 2 Engine: Lô ${chunkIdx + 1} (3.1 Lite) & Lô ${chunkIdx + 2} (3.5 Lite)...`,
        }));

        const [resA, resB] = await Promise.allSettled([
          scanImages(chunkA, existingBooks, 'gemini-3.1-flash-lite'),
          scanImages(chunkB, existingBooks, 'gemini-3.5-flash-lite'),
        ]);

        const rawFound: any[] = [];

        if (resA.status === 'fulfilled' && resA.value?.success && Array.isArray(resA.value.books)) {
          rawFound.push(...resA.value.books);
        } else {
          // Tự động thử lại chunkA trên Engine B (3.5 Lite)
          try {
            console.log(`[BatchScanner] Lô ${chunkIdx + 1} gặp sự cố trên 3.1 Lite, tự động chuyển tải sang 3.5 Lite...`);
            const recoverA = await scanImages(chunkA, existingBooks, 'gemini-3.5-flash-lite');
            if (recoverA?.success && Array.isArray(recoverA.books)) {
              rawFound.push(...recoverA.books);
            } else {
              currentFailedImages.push(...chunkA);
            }
          } catch {
            currentFailedImages.push(...chunkA);
          }
        }

        if (resB.status === 'fulfilled' && resB.value?.success && Array.isArray(resB.value.books)) {
          rawFound.push(...resB.value.books);
        } else {
          // Tự động thử lại chunkB trên Engine A (3.1 Lite)
          try {
            console.log(`[BatchScanner] Lô ${chunkIdx + 2} gặp sự cố trên 3.5 Lite, tự động chuyển tải sang 3.1 Lite...`);
            const recoverB = await scanImages(chunkB, existingBooks, 'gemini-3.1-flash-lite');
            if (recoverB?.success && Array.isArray(recoverB.books)) {
              rawFound.push(...recoverB.books);
            } else {
              currentFailedImages.push(...chunkB);
            }
          } catch {
            currentFailedImages.push(...chunkB);
          }
        }

        if (rawFound.length > 0) {
          const newDrafts: DraftBookItem[] = rawFound.map((item: any, idx: number) => ({
            tempId: `draft_${Date.now()}_${chunkIdx}_${idx}_${Math.random().toString(36).substring(2, 5)}`,
            title: (item.title || 'Sách chưa đặt tên').trim(),
            author: (item.author || 'Khuyết danh').trim(),
            publisher: (item.publisher || '').trim(),
            category: (item.category || 'Chung').trim(),
            enriched: false,
          }));

          totalExtractedBooks += newDrafts.length;
          setDraftItems((prev) => flagDuplicateDrafts([...prev, ...newDrafts], existingBooks));
        }

        processedImagesCount += totalPairImages;
        setScanProgress((prev) => ({
          ...prev,
          processedImages: processedImagesCount,
          booksFound: totalExtractedBooks,
        }));

        chunkIdx += 2;
      } else {
        // Chỉ còn 1 lô lẻ -> Gửi đến Engine quay vòng tự động
        const chunkImageCount = chunkA.length;

        setScanProgress((prev) => ({
          ...prev,
          currentChunk: chunkIdx + 1,
          processedImages: processedImagesCount,
          statusMessage: `Đang trích xuất Lô ${chunkIdx + 1}/${totalChunks} (Ảnh ${processedImagesCount + 1}-${processedImagesCount + chunkImageCount}/${totalImages})...`,
        }));

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
              await new Promise((res) => setTimeout(res, 1200 * attempt));
            }

            const res = await scanImages(chunkA, existingBooks);
            if (res?.success && Array.isArray(res.books)) {
              rawBooks = res.books;
              success = true;
              break;
            }
          } catch (err: any) {
            console.warn(`Lô ${chunkIdx + 1} thử lần ${attempt} thất bại:`, err?.message || err);
          }
        }

        if (success && rawBooks.length > 0) {
          const newDrafts: DraftBookItem[] = rawBooks.map((item: any, idx: number) => ({
            tempId: `draft_${Date.now()}_${chunkIdx}_${idx}_${Math.random().toString(36).substring(2, 5)}`,
            title: (item.title || 'Sách chưa đặt tên').trim(),
            author: (item.author || 'Khuyết danh').trim(),
            publisher: (item.publisher || '').trim(),
            category: (item.category || 'Chung').trim(),
            enriched: false,
          }));

          totalExtractedBooks += newDrafts.length;
          setDraftItems((prev) => flagDuplicateDrafts([...prev, ...newDrafts], existingBooks));
        } else if (!success) {
          currentFailedImages.push(...chunkA);
        }

        processedImagesCount += chunkImageCount;
        setScanProgress((prev) => ({
          ...prev,
          processedImages: processedImagesCount,
          booksFound: totalExtractedBooks,
        }));

        chunkIdx += 1;
      }
    }

    // Cập nhật danh sách ảnh bị lỗi nếu có
    if (currentFailedImages.length > 0) {
      setFailedImagesQueue((prev) => [...prev, ...currentFailedImages]);
    }

    setIsScanning(false);
  };

  // Xử lý khi Chụp Ảnh bằng Camera: Mở Modal cho phép Cắt ảnh (Crop) đúng phần muốn OCR
  const handleCameraCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    e.target.value = ''; // Reset input để có thể chụp tiếp

    try {
      // Nén ảnh sơ bộ kích thước chuẩn (1600x1600) để hiển thị crop mượt mà, sắc nét
      const compressed = await compressImage(file, 1600, 1600, 0.9);
      if (compressed) {
        setCropImageSrc(compressed);
        setCropModalOpen(true);
      }
    } catch (err) {
      console.error('Lỗi khi đọc ảnh camera:', err);
    }
  };

  // Xử lý khi Chọn Ảnh từ Thư Viện
  const handleLibraryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList = Array.from(files);
    e.target.value = ''; // Reset input để có thể chọn tiếp

    // Nếu chọn đúng 1 ảnh -> Mở Modal Cắt ảnh (Crop) để tối ưu vùng OCR
    if (fileList.length === 1) {
      try {
        const compressed = await compressImage(fileList[0], 1600, 1600, 0.9);
        if (compressed) {
          setCropImageSrc(compressed);
          setCropModalOpen(true);
          return;
        }
      } catch (err) {
        console.error('Lỗi khi đọc ảnh:', err);
      }
    }

    // Nếu chọn nhiều ảnh cùng lúc (2 ảnh trở lên) -> Chạy trực tiếp bóc tách hàng loạt
    setIsScanning(true);
    setScanProgress((prev) => ({
      ...prev,
      statusMessage: `Đang nén ${fileList.length} ảnh...`,
    }));

    try {
      const compressedImages = await Promise.all(fileList.map((file) => compressImage(file)));
      const validImages = compressedImages.filter((img) => img.length > 0);

      if (validImages.length === 0) {
        setIsScanning(false);
        return;
      }

      await processImageArrayChunked(validImages);
    } catch (err: any) {
      console.error('Lỗi khi nén hoặc nhận diện ảnh:', err);
      setIsScanning(false);
    }
  };

  // Xác nhận cắt ảnh và tiến hành OCR
  const handleConfirmCrop = async (croppedSrc: string) => {
    setCropModalOpen(false);
    setCropImageSrc(null);
    if (!croppedSrc) return;
    await processImageArrayChunked([croppedSrc]);
  };

  // Bỏ qua cắt ảnh, dùng toàn bộ ảnh gốc để OCR
  const handleSkipCrop = async (originalSrc: string) => {
    setCropModalOpen(false);
    setCropImageSrc(null);
    if (!originalSrc) return;
    await processImageArrayChunked([originalSrc]);
  };

  // Hủy crop ảnh
  const handleCancelCrop = () => {
    setCropModalOpen(false);
    setCropImageSrc(null);
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
          <h2 className="text-base font-black text-slate-900 flex items-center gap-2.5">
            <span className="p-1.5 bg-purple-100 text-[#6b21a8] rounded-xl relative inline-flex items-center justify-center">
              <Camera className="w-4 h-4" />
              <span className="absolute -top-1.5 -right-1.5 bg-amber-400 text-slate-950 text-[6.5px] font-black px-0.5 rounded leading-tight shadow-xs">
                AI
              </span>
            </span>
            <span>Thêm sách bằng ảnh</span>
          </h2>

          <div className="flex items-center gap-2">
            {/* Input Camera */}
            <input
              type="file"
              ref={cameraInputRef}
              accept="image/*"
              capture="environment"
              onChange={handleCameraCapture}
              className="hidden"
            />
            {/* Input Thư viện */}
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              multiple
              onChange={handleLibraryUpload}
              className="hidden"
            />

            <button
              onClick={() => cameraInputRef.current?.click()}
              disabled={isScanning}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#9e5628] hover:bg-[#85451e] active:scale-95 text-white text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-50"
            >
              <Camera className="w-4 h-4" />
              <span>Chụp Ảnh</span>
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isScanning}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#1b6b5b] hover:bg-[#165b4c] active:scale-95 text-white text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-50"
            >
              <UploadCloud className="w-4 h-4" />
              <span>Thư Viện</span>
            </button>
          </div>
        </div>

        {/* Thanh Tiến Trình Bóc Tách Theo Lô */}
        {isScanning && (
          <div className="mt-3 p-3 bg-purple-50/90 border border-purple-200 rounded-xl space-y-2">
            <div className="flex items-center justify-between text-xs font-bold text-purple-950">
              <div className="flex items-center gap-1.5 truncate">
                <Loader2 className="w-4 h-4 animate-spin text-[#653f96] shrink-0" />
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
                className="bg-[#653f96] h-full rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[10.5px] font-semibold text-purple-800">
              <span>Đã xong: {scanProgress.processedImages}/{scanProgress.totalImages} ảnh ({progressPercent}%)</span>
              <span className="font-bold text-purple-950">Đã bóc tách được: {scanProgress.booksFound} cuốn</span>
            </div>
          </div>
        )}

        {/* Thẻ Cảnh báo & Nút THỬ LẠI các ảnh bị lỗi */}
        {!isScanning && failedImagesQueue.length > 0 && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-amber-950 text-xs font-bold">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>Có {failedImagesQueue.length} ảnh bị gián đoạn chưa bóc tách xong.</span>
            </div>
            <button
              type="button"
              onClick={handleRetryFailedImages}
              className="flex items-center gap-1 px-3 py-1.5 bg-[#9e5628] hover:bg-[#85451e] text-white rounded-lg text-xs font-bold shadow-2xs transition active:scale-95 shrink-0"
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
            <span className="p-1.5 bg-amber-100 text-[#9e5628] rounded-xl">
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
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#9e5628] hover:bg-[#85451e] text-white text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-40"
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
                        : 'bg-amber-50/70 hover:bg-amber-100/80 border-l-4 border-l-[#9e5628] text-slate-900'
                    }`}
                  >
                    <td className="py-1.5 px-2 text-center font-mono text-slate-500 font-bold text-[11px]">
                      {idx + 1}
                    </td>

                    {/* Tên sách */}
                    <td className="py-1.5 px-2 min-w-[170px]">
                      <input
                        type="text"
                        name="nomatch_batch_title"
                        autoComplete="new-password"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        data-lpignore="true"
                        data-1p-ignore="true"
                        data-form-type="other"
                        value={draft.title}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { title: e.target.value })}
                        className="w-full px-2 py-1 border border-slate-200 rounded-lg font-bold focus:outline-none transition text-xs shadow-2xs bg-white text-slate-900"
                      />
                    </td>

                    {/* Tác giả */}
                    <td className="py-1.5 px-2 min-w-[130px]">
                      <input
                        type="text"
                        name="nomatch_batch_author"
                        autoComplete="new-password"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        data-lpignore="true"
                        data-1p-ignore="true"
                        data-form-type="other"
                        value={draft.author}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { author: e.target.value })}
                        className="w-full px-2 py-1 border border-slate-200 rounded-lg focus:outline-none transition text-xs shadow-2xs bg-white text-slate-900"
                      />
                    </td>

                    {/* Thể loại */}
                    <td className="py-1.5 px-2 min-w-[110px]">
                      <input
                        type="text"
                        name="nomatch_batch_category"
                        autoComplete="new-password"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        data-lpignore="true"
                        data-1p-ignore="true"
                        data-form-type="other"
                        list="cat-suggestions"
                        value={draft.category || 'Chung'}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { category: e.target.value })}
                        className="w-full px-2 py-1 border border-slate-200 rounded-lg focus:outline-none transition text-xs shadow-2xs bg-white text-slate-900"
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
                        name="nomatch_batch_publisher"
                        autoComplete="new-password"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        data-lpignore="true"
                        data-1p-ignore="true"
                        data-form-type="other"
                        value={draft.publisher || ''}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { publisher: e.target.value })}
                        className="w-full px-2 py-1 border border-slate-200 rounded-lg focus:outline-none transition text-xs shadow-2xs bg-white text-slate-900"
                        placeholder="NXB..."
                      />
                    </td>

                    {/* Trạng thái kiểm trùng */}
                    <td className="py-1.5 px-2 whitespace-nowrap">
                      {draft.isDuplicate ? (
                        <div
                          className="inline-flex items-center gap-1 text-slate-700 bg-slate-200 px-2 py-0.5 rounded-md text-[10px] font-bold border border-slate-300"
                          title={`Trùng với: "${draft.duplicateMatchTitle}"`}
                        >
                          <AlertTriangle className="w-3 h-3 text-slate-600 shrink-0" />
                          <span>Trùng kho</span>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1 text-[#9e5628] bg-amber-100 px-2 py-0.5 rounded-md text-[10px] font-bold border border-amber-300">
                          <CheckCircle2 className="w-3 h-3 text-[#9e5628] shrink-0" />
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

      {/* Modal Cắt ảnh (Crop) trước khi OCR */}
      <ImageCropModal
        isOpen={cropModalOpen}
        imageSrc={cropImageSrc || ''}
        onConfirmCrop={handleConfirmCrop}
        onSkipCrop={handleSkipCrop}
        onCancel={handleCancelCrop}
      />
    </div>
  );
};
