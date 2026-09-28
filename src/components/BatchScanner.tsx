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
} from 'lucide-react';
import { BookRecord, DraftBookItem } from '../types';
import { flagDuplicateDrafts } from '../utils/fuzzyMatcher';
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

export const BatchScanner: React.FC<BatchScannerProps> = ({
  existingBooks,
  categories,
  onSaveToLibrary,
  onSwitchToTable,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const [isScanning, setIsScanning] = useState(false);
  const [scanStatusText, setScanStatusText] = useState('');

  // Bảng sách đã trích xuất & kiểm trùng
  const [draftItems, setDraftItems] = useState<DraftBookItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [enrichingId, setEnrichingId] = useState<string | null>(null);

  // TỰ ĐỘNG OCR TỰ ĐỘNG THEO TRÌNH TỰ NGAY KHI CHỌN HOẶC CHỤP ẢNH
  const handleAddAndScanFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList = Array.from(files);
    e.target.value = ''; // Reset input để có thể chụp tiếp

    setIsScanning(true);
    setScanStatusText(`Đang xử lý ${fileList.length} ảnh...`);

    try {
      // 1. Nén ảnh siêu tốc
      const compressedImages = await Promise.all(
        fileList.map((file) => compressImage(file))
      );
      const validImages = compressedImages.filter((img) => img.length > 0);

      if (validImages.length === 0) {
        setIsScanning(false);
        return;
      }

      setScanStatusText(`Đang trích xuất dữ liệu (${validImages.length} ảnh)...`);

      // 2. Tự động gửi thẳng lên Gemini AI OCR
      const data = await scanImages(validImages);
      const rawExtractedBooks = data.books || [];

      if (rawExtractedBooks.length === 0) {
        setIsScanning(false);
        return;
      }

      // 3. Tự động làm sạch & đóng gói Draft items
      const newDrafts: DraftBookItem[] = rawExtractedBooks.map((item: any, idx: number) => ({
        tempId: `draft_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 5)}`,
        title: (item.title || 'Sách chưa đặt tên').trim(),
        author: (item.author || 'Khuyết danh').trim(),
        publisher: (item.publisher || '').trim(),
        category: (item.category || 'Chung').trim(),
        enriched: false,
      }));

      // 4. Tự động kiểm tra trùng lặp với CSDL hiện có
      setDraftItems((prev) => {
        const combined = flagDuplicateDrafts([...prev, ...newDrafts], existingBooks);
        return combined;
      });
    } catch (err: any) {
      console.error('Error during automatic OCR:', err);
    } finally {
      setIsScanning(false);
      setScanStatusText('');
    }
  };

  // Cập nhật giá trị một dòng trong Bảng chờ
  const handleUpdateDraft = (draftId: string, updates: Partial<DraftBookItem>) => {
    setDraftItems((prev) => {
      const updated = prev.map((item) => {
        if (item.tempId !== draftId) return item;
        return { ...item, ...updates };
      });
      // Tự động kiểm trùng lại khi sửa tên
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

  // Bấm Lưu sách mới -> Tự động lưu các cuốn không trùng vào kho (Không bật thông báo)
  const handleSaveAllDrafts = async () => {
    if (draftItems.length === 0) return;

    const newItems = draftItems.filter((d) => !d.isDuplicate);
    if (newItems.length === 0) return;

    setIsSaving(true);
    try {
      const booksToSave: BookRecord[] = newItems.map((draft, idx) => ({
        id: `book_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
        title: draft.title.trim(),
        author: draft.author.trim() || 'Khuyết danh',
        publisher: draft.publisher?.trim() || '',
        category: draft.category?.trim() || 'Chung',
        created_at: Date.now(),
        updated_at: Date.now(),
      }));

      await onSaveToLibrary(booksToSave);
      setDraftItems([]);
      onSwitchToTable();
    } catch (err: any) {
      console.error('Lỗi khi lưu sách:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const newBooksCount = draftItems.filter((d) => !d.isDuplicate).length;

  return (
    <div className="space-y-3">
      {/* 1. Nút Chụp Ảnh / Thư Viện (Kích hoạt OCR Tự Động) */}
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

        {/* Trạng thái đang OCR tự động */}
        {isScanning && (
          <div className="mt-3 p-3 bg-purple-50 border border-purple-200 rounded-xl flex items-center justify-center gap-2 text-purple-900 text-xs font-bold animate-pulse">
            <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
            <span>{scanStatusText || 'Đang trích xuất dữ liệu...'}</span>
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
              disabled={newBooksCount === 0 || isSaving}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-40"
            >
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              <span>Lưu sách mới ({newBooksCount})</span>
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
                        ? 'bg-amber-50/60 hover:bg-amber-100/60'
                        : 'bg-emerald-50/80 hover:bg-emerald-100/80 border-l-3 border-l-emerald-500'
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
                        className="w-full px-2 py-1 bg-white/90 hover:bg-white focus:bg-white border border-slate-200/80 rounded-lg font-bold text-slate-900 focus:outline-none transition text-xs shadow-2xs"
                      />
                    </td>

                    {/* Tác giả */}
                    <td className="py-1.5 px-2 min-w-[130px]">
                      <input
                        type="text"
                        value={draft.author}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { author: e.target.value })}
                        className="w-full px-2 py-1 bg-white/90 hover:bg-white focus:bg-white border border-slate-200/80 rounded-lg text-slate-800 focus:outline-none transition text-xs shadow-2xs"
                      />
                    </td>

                    {/* Thể loại */}
                    <td className="py-1.5 px-2 min-w-[110px]">
                      <input
                        type="text"
                        list="cat-suggestions"
                        value={draft.category || 'Chung'}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { category: e.target.value })}
                        className="w-full px-2 py-1 bg-white/90 hover:bg-white focus:bg-white border border-slate-200/80 rounded-lg text-slate-800 focus:outline-none transition text-xs shadow-2xs"
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
                        className="w-full px-2 py-1 bg-white/90 hover:bg-white focus:bg-white border border-slate-200/80 rounded-lg text-slate-800 focus:outline-none transition text-xs shadow-2xs"
                        placeholder="NXB..."
                      />
                    </td>

                    {/* Trạng thái kiểm trùng */}
                    <td className="py-1.5 px-2 whitespace-nowrap">
                      {draft.isDuplicate ? (
                        <div
                          className="inline-flex items-center gap-1 text-amber-900 bg-amber-100 px-2 py-0.5 rounded-md text-[10px] font-bold border border-amber-300/80 max-w-[160px] truncate shadow-2xs"
                          title={`Trùng với: "${draft.duplicateMatchTitle}"`}
                        >
                          <AlertTriangle className="w-3 h-3 text-amber-700 shrink-0" />
                          <span>Trùng kho</span>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1 text-emerald-900 bg-emerald-100 px-2 py-0.5 rounded-md text-[10px] font-bold border border-emerald-300/80 shadow-2xs">
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
