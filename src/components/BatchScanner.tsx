import React, { useState, useRef } from 'react';
import {
  Camera,
  UploadCloud,
  Sparkles,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Layers,
  Tag,
  Loader2,
  X,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { BookRecord, DraftBookItem } from '../types';
import { flagDuplicateDrafts } from '../utils/fuzzyMatcher';
import { useToast } from '../context/ToastContext';

interface BatchScannerProps {
  existingBooks: BookRecord[];
  categories: string[];
  onSaveToLibrary: (books: BookRecord[]) => Promise<void>;
  onSwitchToTable: () => void;
}

export const BatchScanner: React.FC<BatchScannerProps> = ({
  existingBooks,
  categories,
  onSaveToLibrary,
  onSwitchToTable,
}) => {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Mảng ảnh tạm lưu trong RAM (Base64)
  const [tempImages, setTempImages] = useState<string[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatusMessage, setScanStatusMessage] = useState('');

  // Bảng chờ duyệt (Draft / Staging Table)
  const [draftItems, setDraftItems] = useState<DraftBookItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [enrichingId, setEnrichingId] = useState<string | null>(null);

  // 1. Nhận file ảnh từ máy ảnh hoặc thư viện
  const handleAddFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newImages: string[] = [];
    let processed = 0;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          newImages.push(reader.result);
        }
        processed++;
        if (processed === files.length) {
          setTempImages((prev) => [...prev, ...newImages]);
          showToast(`Đã thêm ${newImages.length} ảnh vào hàng đợi AI Vision.`, 'info');
        }
      };
      reader.readAsDataURL(file);
    });

    e.target.value = '';
  };

  const handleRemoveImage = (index: number) => {
    setTempImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleClearImages = () => {
    setTempImages([]);
  };

  // 2. Kích hoạt AI Vision lọc sách (Gemini 2.5 Flash API)
  const handleStartAIScan = async () => {
    if (tempImages.length === 0) {
      showToast('Vui lòng chụp hoặc chọn ít nhất 1 ảnh gáy sách!', 'warning');
      return;
    }

    setIsScanning(true);
    setScanStatusMessage(`Đang gửi ${tempImages.length} ảnh lên Gemini 2.5 Flash để bóc tách văn bản...`);

    try {
      const res = await fetch('/api/books/scan-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: tempImages }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || 'Lỗi xử lý AI Vision');
      }

      const data = await res.json();
      const rawExtractedBooks = data.books || [];

      // BƯỚC 3: Giải phóng ngay lập tức mảng ảnh Base64 khỏi RAM để tránh rác bộ nhớ di động
      setTempImages([]);

      if (rawExtractedBooks.length === 0) {
        showToast('AI không nhận diện được gáy sách nào trong ảnh. Hãy chụp rõ nét hơn.', 'warning');
        setIsScanning(false);
        return;
      }

      // Tạo Draft items ban đầu
      const newDrafts: DraftBookItem[] = rawExtractedBooks.map((item: any, idx: number) => ({
        tempId: `draft_${Date.now()}_${idx}`,
        title: item.title || 'Sách chưa đặt tên',
        author: item.author || 'Khuyết danh',
        publisher: item.publisher || '',
        category: item.category || 'Chung',
        enriched: false,
      }));

      // BƯỚC 4: Kiểm tra trùng lặp (Fuzzy Matching) với CSDL hiện có
      const verifiedDrafts = flagDuplicateDrafts(newDrafts, existingBooks);
      setDraftItems((prev) => [...prev, ...verifiedDrafts]);

      const dupCount = verifiedDrafts.filter((d) => d.isDuplicate).length;
      if (dupCount > 0) {
        showToast(
          `AI đã lọc được ${verifiedDrafts.length} cuốn sách (${dupCount} cuốn có dấu hiệu trùng tên).`,
          'warning'
        );
      } else {
        showToast(`AI đã trích xuất thành công ${verifiedDrafts.length} cuốn sách vào Bảng chờ duyệt!`, 'success');
      }
    } catch (err: any) {
      console.error('Error during AI Vision scan:', err);
      showToast(`Lỗi quét AI: ${err?.message || 'Không thể kết nối dịch vụ'}`, 'error');
    } finally {
      setIsScanning(false);
      setScanStatusMessage('');
    }
  };

  // 3. Làm giàu dữ liệu cho 1 cuốn trong Bảng chờ (Data Enrichment)
  const handleEnrichDraft = async (draftId: string) => {
    const draft = draftItems.find((d) => d.tempId === draftId);
    if (!draft || !draft.title) return;

    setEnrichingId(draftId);
    try {
      const res = await fetch('/api/books/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          author: draft.author,
          publisher: draft.publisher,
        }),
      });

      if (!res.ok) throw new Error('Không thể tra cứu thông tin làm giàu');
      const data = await res.json();
      const enriched = data.enriched;

      if (enriched) {
        setDraftItems((prev) =>
          prev.map((item) => {
            if (item.tempId !== draftId) return item;
            return {
              ...item,
              title: enriched.title || item.title,
              author: enriched.author || item.author,
              publisher: enriched.publisher || item.publisher,
              category: enriched.category || item.category,
              enriched: true,
            };
          })
        );
        showToast(`Đã làm giàu thông tin cho cuốn "${draft.title}"!`, 'success');
      }
    } catch (err: any) {
      showToast(`Lỗi làm giàu dữ liệu: ${err.message}`, 'error');
    } finally {
      setEnrichingId(null);
    }
  };

  // Cập nhật giá trị một dòng trong Bảng chờ
  const handleUpdateDraft = (draftId: string, updates: Partial<DraftBookItem>) => {
    setDraftItems((prev) =>
      prev.map((item) => {
        if (item.tempId !== draftId) return item;
        const updated = { ...item, ...updates };
        return updated;
      })
    );
  };

  // Xóa 1 dòng khỏi bảng chờ
  const handleRemoveDraft = (draftId: string) => {
    setDraftItems((prev) => prev.filter((d) => d.tempId !== draftId));
  };

  // 4. Xác nhận và Lưu toàn bộ Bảng chờ vào CSDL Firestore
  const handleSaveAllDrafts = async () => {
    if (draftItems.length === 0) {
      showToast('Bảng chờ đang trống!', 'warning');
      return;
    }

    setIsSaving(true);
    try {
      const booksToSave: BookRecord[] = draftItems.map((draft, idx) => ({
        id: `book_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
        title: draft.title.trim(),
        author: draft.author.trim() || 'Khuyết danh',
        publisher: draft.publisher?.trim() || '',
        category: draft.category?.trim() || 'Chung',
        created_at: Date.now(),
        updated_at: Date.now(),
      }));

      await onSaveToLibrary(booksToSave);
      showToast(`Đã lưu thành công ${booksToSave.length} cuốn sách vào Firestore!`, 'success');
      setDraftItems([]);
      onSwitchToTable();
    } catch (err: any) {
      showToast(`Lỗi khi lưu vào Firestore: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Khu vực Thu thập Ảnh (Camera & Gallery Input) */}
      <div className="bg-white rounded-3xl border border-slate-200/80 shadow-xs p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">
              <span className="p-1.5 bg-purple-100 text-purple-700 rounded-xl">
                <Sparkles className="w-5 h-5" />
              </span>
              <span>Nhập Liệu AI Vision (Bóc tách gáy sách)</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Chụp liên tục nhiều gáy sách hoặc chọn ảnh từ thư viện thiết bị. Gemini 2.5 Flash xử lý tức thì.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={cameraInputRef}
              accept="image/*"
              capture="environment"
              multiple
              onChange={handleAddFiles}
              className="hidden"
            />
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              multiple
              onChange={handleAddFiles}
              className="hidden"
            />

            <button
              onClick={() => cameraInputRef.current?.click()}
              disabled={isScanning}
              className="flex items-center gap-1.5 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-50"
            >
              <Camera className="w-4 h-4" />
              <span>Chụp Ảnh Liên Tục</span>
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isScanning}
              className="flex items-center gap-1.5 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition disabled:opacity-50"
            >
              <UploadCloud className="w-4 h-4 text-slate-600" />
              <span>Chọn Từ Thư Viện</span>
            </button>
          </div>
        </div>

        {/* Danh sách ảnh tạm trong RAM */}
        {tempImages.length > 0 ? (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-700">
                Đang có <span className="text-purple-600">{tempImages.length}</span> ảnh trong hàng đợi RAM:
              </span>
              <button
                onClick={handleClearImages}
                className="text-xs font-semibold text-rose-600 hover:underline flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Xóa sạch ảnh tạm</span>
              </button>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-6 md:grid-cols-8 gap-3 max-h-48 overflow-y-auto p-2 bg-slate-50 rounded-2xl border border-slate-200">
              {tempImages.map((img, idx) => (
                <div key={idx} className="relative group aspect-square rounded-xl overflow-hidden border border-slate-300 bg-white shadow-xs">
                  <img src={img} alt={`Ảnh ${idx + 1}`} className="w-full h-full object-cover" />
                  <button
                    onClick={() => handleRemoveImage(idx)}
                    className="absolute top-1 right-1 p-1 bg-black/60 text-white rounded-full hover:bg-rose-600 transition"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>

            {/* Nút Kích hoạt Lọc sách AI */}
            <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 p-4 bg-purple-50/80 border border-purple-200 rounded-2xl">
              <div className="text-xs text-purple-900">
                <span className="font-bold block">💡 Cơ chế an toàn bộ nhớ:</span>
                Toàn bộ ảnh Base64 sẽ được xóa sạch khỏi RAM ngay khi nhận danh sách bóc tách từ Gemini API.
              </div>

              <button
                onClick={handleStartAIScan}
                disabled={isScanning}
                className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold rounded-xl shadow-md transition disabled:opacity-50"
              >
                {isScanning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{scanStatusMessage || 'Đang bóc tách văn bản...'}</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>Lọc Sách (AI Parsing)</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 p-8 border-2 border-dashed border-slate-200 rounded-2xl text-center bg-slate-50/50">
            <Camera className="w-10 h-10 mx-auto text-slate-300 mb-2" />
            <p className="text-sm font-bold text-slate-700">Chưa có ảnh nào trong hàng đợi</p>
            <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
              Bấm &quot;Chụp Ảnh Liên Tục&quot; hoặc &quot;Chọn Từ Thư Viện&quot; để thêm ảnh gáy sách hoặc trang phụ sách cần bóc tách.
            </p>
          </div>
        )}
      </div>

      {/* 2. Bảng Chờ Duyệt (Draft / Staging Table) */}
      <div className="bg-white rounded-3xl border border-slate-200/80 shadow-xs p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 bg-amber-100 text-amber-700 rounded-xl">
                <Layers className="w-5 h-5" />
              </span>
              <h2 className="text-lg font-black text-slate-900">
                Bảng Chờ Duyệt ({draftItems.length} cuốn)
              </h2>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Kiểm tra thông tin, cảnh báo trùng lặp (Fuzzy Matching) trước khi lưu chính thức vào Firestore.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {draftItems.length > 0 && (
              <button
                onClick={() => setDraftItems([])}
                className="px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 rounded-xl transition"
              >
                Xóa hết bảng chờ
              </button>
            )}

            <button
              onClick={handleSaveAllDrafts}
              disabled={draftItems.length === 0 || isSaving}
              className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-40"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>Xác Nhận Lưu Vào Kho ({draftItems.length})</span>
            </button>
          </div>
        </div>

        {/* Table Draft Items */}
        {draftItems.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200 uppercase">
                  <th className="py-2.5 px-3">#</th>
                  <th className="py-2.5 px-3">Tên Sách</th>
                  <th className="py-2.5 px-3">Tác Giả</th>
                  <th className="py-2.5 px-3">Thể Loại</th>
                  <th className="py-2.5 px-3">NXB</th>
                  <th className="py-2.5 px-3">Trạng Thái Trùng</th>
                  <th className="py-2.5 px-3 text-right">Thao Tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {draftItems.map((draft, idx) => (
                  <tr
                    key={draft.tempId}
                    className={`hover:bg-slate-50/80 transition ${
                      draft.isDuplicate ? 'bg-amber-50/50' : ''
                    }`}
                  >
                    <td className="py-2 px-3 font-mono text-slate-400 font-bold">{idx + 1}</td>
                    
                    {/* Title */}
                    <td className="py-2 px-3 min-w-[200px]">
                      <input
                        type="text"
                        value={draft.title}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { title: e.target.value })}
                        className="w-full px-2 py-1 bg-white border border-slate-200 rounded font-semibold text-slate-900 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                      />
                    </td>

                    {/* Author */}
                    <td className="py-2 px-3 min-w-[150px]">
                      <input
                        type="text"
                        value={draft.author}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { author: e.target.value })}
                        className="w-full px-2 py-1 bg-white border border-slate-200 rounded text-slate-800 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                      />
                    </td>

                    {/* Category */}
                    <td className="py-2 px-3 min-w-[120px]">
                      <input
                        type="text"
                        list="categories-list"
                        value={draft.category || 'Chung'}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { category: e.target.value })}
                        className="w-full px-2 py-1 bg-white border border-slate-200 rounded text-slate-800 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                      />
                    </td>

                    {/* Publisher */}
                    <td className="py-2 px-3 min-w-[120px]">
                      <input
                        type="text"
                        value={draft.publisher || ''}
                        onChange={(e) => handleUpdateDraft(draft.tempId, { publisher: e.target.value })}
                        className="w-full px-2 py-1 bg-white border border-slate-200 rounded text-slate-800 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                        placeholder="NXB..."
                      />
                    </td>

                    {/* Duplicate Status */}
                    <td className="py-2 px-3">
                      {draft.isDuplicate ? (
                        <div className="flex items-center gap-1 text-amber-700 bg-amber-100 px-2 py-0.5 rounded text-[11px] font-bold">
                          <AlertTriangle className="w-3 h-3 text-amber-600" />
                          <span>Trùng: &quot;{draft.duplicateMatchTitle}&quot;</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded text-[11px] font-semibold">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          <span>Hợp lệ</span>
                        </div>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="py-2 px-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleEnrichDraft(draft.tempId)}
                          disabled={enrichingId === draft.tempId}
                          title="Làm giàu dữ liệu với AI"
                          className="p-1.5 text-purple-600 hover:bg-purple-50 rounded transition disabled:opacity-40"
                        >
                          {enrichingId === draft.tempId ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => handleRemoveDraft(draft.tempId)}
                          title="Xóa cuốn này khỏi bảng chờ"
                          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition"
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
          <div className="mt-4 p-8 text-center bg-slate-50/50 border border-slate-200 rounded-2xl">
            <Layers className="w-8 h-8 mx-auto text-slate-300 mb-2" />
            <p className="text-sm font-semibold text-slate-600">Bảng chờ duyệt đang trống</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Sau khi chụp và chạy &quot;Lọc Sách (AI Parsing)&quot;, kết quả bóc tách sẽ xuất hiện tại đây.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
