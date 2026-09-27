import React, { useState, useRef } from 'react';
import { X, Upload, FileText, FileSpreadsheet, HardDrive, Download, AlertCircle, CheckCircle, Loader2, ChevronDown, ChevronUp, Link2 } from 'lucide-react';
import { BookRecord } from '../types';
import {
  exportBooksToJson,
  importBooksFromJson,
  exportBooksToCsv,
  exportBooksToExcel,
  parseBooksFromExcelBuffer,
} from '../utils/backupService';
import { useToast } from '../context/ToastContext';

import {
  GOOGLE_APPS_SCRIPT_CODE,
  pushCleanDataToDriveWebApp,
  pullDataFromDriveWebApp,
  sanitizeAppsScriptUrl,
  parseGoogleSheetCsvText,
  getProxyUrl,
  getSyncLogs,
  clearSyncLogs,
  SyncLogEntry,
} from '../utils/driveSyncService';
import {
  getStoredOrConfiguredSheetUrl,
  getStoredOrConfiguredScriptUrl,
} from '../config/syncConfig';

interface DataSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  books: BookRecord[];
  onImportBooks: (
    importedBooks: BookRecord[],
    replace: boolean
  ) => Promise<{ addedCount: number; skippedCount: number }>;
  userEmail?: string;
  driveSyncUrl?: string;
  driveTargetFileUrl?: string;
  onSaveConfig?: (sheetUrl: string, scriptUrl: string) => void;
}

export const DataSyncModal: React.FC<DataSyncModalProps> = ({
  isOpen,
  onClose,
  books,
  onImportBooks,
  userEmail,
  driveSyncUrl = '',
  driveTargetFileUrl = '',
  onSaveConfig,
}) => {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importMode, setImportMode] = useState<'append' | 'replace'>('append');
  const [isProcessing, setIsProcessing] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [activeTab, setActiveTab] = useState<'export' | 'import' | 'drive'>('export');

  const [scriptUrlInput, setScriptUrlInput] = useState(() => getStoredOrConfiguredScriptUrl());
  const [targetFileUrl, setTargetFileUrl] = useState(() => getStoredOrConfiguredSheetUrl());
  const [isSyncingDrive, setIsSyncingDrive] = useState(false);
  const [showAdvancedScript, setShowAdvancedScript] = useState(() => {
    const url = getStoredOrConfiguredScriptUrl();
    return url.includes('AKfyczt126a5BfMe-0o8') || !url.trim();
  });

  const isUsingDummyScript = scriptUrlInput.includes('AKfyczt126a5BfMe-0o8') || !scriptUrlInput.trim();

  const [logs, setLogs] = useState<SyncLogEntry[]>([]);

  React.useEffect(() => {
    if (isOpen) {
      setLogs(getSyncLogs());
      const interval = setInterval(() => {
        setLogs(getSyncLogs());
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [isOpen]);

  // Sync scriptUrlInput & targetFileUrl with localStorage / config / props
  React.useEffect(() => {
    setScriptUrlInput(driveSyncUrl || getStoredOrConfiguredScriptUrl());
    setTargetFileUrl(driveTargetFileUrl || getStoredOrConfiguredSheetUrl());
  }, [driveSyncUrl, driveTargetFileUrl, isOpen]);

  if (!isOpen) return null;

  const handleSaveConfig = () => {
    const sanitized = sanitizeAppsScriptUrl(scriptUrlInput);
    setScriptUrlInput(sanitized);
    const trimmedSheet = targetFileUrl.trim();
    setTargetFileUrl(trimmedSheet);

    localStorage.setItem('drive_sync_url_v1', sanitized);
    localStorage.setItem('drive_target_file_url_v1', trimmedSheet);

    if (onSaveConfig) {
      onSaveConfig(trimmedSheet, sanitized);
    }
    showToast('Đã đồng bộ cấu hình thành công lên đám mây Firestore!', 'success');
  };

  const handleTestConnection = async () => {
    if (!targetFileUrl.trim() && !scriptUrlInput.trim()) {
      showToast('Vui lòng dán link file Google Sheet trước!', 'warning');
      return;
    }

    setIsSyncingDrive(true);
    let successMessages: string[] = [];
    let detectedBookCount = 0;
    
    // 1. Kiểm tra đọc trực tiếp Google Sheet Link
    if (targetFileUrl.trim()) {
      const match = targetFileUrl.trim().match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        try {
          const proxyUrl = getProxyUrl(`https://docs.google.com/spreadsheets/d/${match[1]}/gviz/tq?tqx=out:csv`);
          const csvResp = await fetch(proxyUrl);
          if (csvResp.ok) {
            const text = await csvResp.text();
            if (text && !text.includes('<!DOCTYPE html>') && !text.includes('<html>')) {
              const parsed = parseGoogleSheetCsvText(text);
              detectedBookCount = parsed.length;
              successMessages.push(`✅ Đọc Google Sheet thành công (${parsed.length} cuốn sách)`);
            }
          }
        } catch (e) {}
      }
    }

    // 2. Kiểm tra Google Apps Script Endpoint (nếu có cấu hình)
    if (scriptUrlInput.trim()) {
      const cleanUrl = sanitizeAppsScriptUrl(scriptUrlInput);
      setScriptUrlInput(cleanUrl);
      
      if (cleanUrl.includes('docs.google.com/spreadsheets')) {
        successMessages.push(`❌ Lỗi Apps Script: Bạn đang dán NHẦM Link Google Sheet vào ô URL Apps Script!`);
      } else if (!cleanUrl.includes('script.google.com/macros/')) {
        successMessages.push(`❌ Lỗi Apps Script: Link không đúng định dạng Web App (thiếu script.google.com)`);
      } else {
        try {
          let testUrl = cleanUrl;
          if (targetFileUrl.trim()) {
            testUrl += (testUrl.includes('?') ? '&' : '?') + `fileUrl=${encodeURIComponent(targetFileUrl.trim())}`;
          }
          const proxyAppScriptUrl = getProxyUrl(testUrl);
          const res = await fetch(proxyAppScriptUrl);
          if (!res.ok) {
            throw new Error(`Server proxy trả về HTTP ${res.status}`);
          }
          const data = await res.json();
          if (data.status === 'success') {
            successMessages.push(`✅ Apps Script 2 chiều OK (${data.count || 0} cuốn)`);
          } else {
            successMessages.push(`❌ Lỗi từ Apps Script: ${data.message || 'Không xác định'}`);
          }
        } catch (err: any) {
          successMessages.push(`❌ Lỗi kết nối Apps Script: ${err.message || String(err)}`);
        }
      }
    }

    if (successMessages.length > 0) {
      showToast(successMessages.join(' | '), 'success');
    } else {
      showToast(
        '⚠️ Chưa đọc được file. Vui lòng mở Google Sheet -> Bấm Chia sẻ -> Chọn "Bất kỳ ai có liên kết (Viewer)"',
        'warning'
      );
    }
    setIsSyncingDrive(false);
  };

  const handleCopyScriptCode = () => {
    navigator.clipboard.writeText(GOOGLE_APPS_SCRIPT_CODE);
    showToast('Đã sao chép Mã Google Apps Script vào Clipboard!', 'success');
  };

  const handlePushToDrive = async () => {
    if (!scriptUrlInput.trim()) {
      showToast('Để đẩy ngược dữ liệu lên Sheet, vui lòng cấu hình thêm URL Apps Script ở phần Tùy chọn nâng cao.', 'warning');
      setShowAdvancedScript(true);
      return;
    }
    setIsSyncingDrive(true);
    try {
      const res = await pushCleanDataToDriveWebApp(
        scriptUrlInput.trim(),
        books,
        targetFileUrl.trim()
      );
      showToast(res.message, 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsSyncingDrive(false);
    }
  };

  const handlePullFromDrive = async () => {
    if (!targetFileUrl.trim() && !scriptUrlInput.trim()) {
      showToast('Vui lòng dán Link Google Sheet vào ô nhập!', 'warning');
      return;
    }
    setIsSyncingDrive(true);
    try {
      const res = await pullDataFromDriveWebApp(
        scriptUrlInput.trim(),
        targetFileUrl.trim()
      );
      if (res.books.length === 0) {
        showToast('Không tìm thấy sách nào trong Google Sheet!', 'info');
        return;
      }
      // Nạp sách vào App thông qua pipeline lọc trùng lặp tự động!
      const { addedCount, skippedCount } = await onImportBooks(res.books, false);
      showToast(
        `Đã kéo ${res.books.length} cuốn từ Google Sheet về. Thêm mới ${addedCount} cuốn (Bỏ qua ${skippedCount} cuốn trùng)!`,
        'success'
      );
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsSyncingDrive(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    try {
      let imported: BookRecord[] = [];
      const extension = file.name.split('.').pop()?.toLowerCase();

      if (extension === 'json') {
        const text = await file.text();
        imported = importBooksFromJson(text);
      } else if (extension === 'xlsx' || extension === 'xls' || extension === 'csv') {
        const buffer = await file.arrayBuffer();
        imported = parseBooksFromExcelBuffer(buffer);
      } else {
        throw new Error('Định dạng file không hỗ trợ. Vui lòng chọn file .json, .xlsx hoặc .csv');
      }

      if (imported.length === 0) {
        throw new Error('Không tìm thấy bản ghi sách hợp lệ nào trong file.');
      }

      const { addedCount, skippedCount } = await onImportBooks(imported, importMode === 'replace');
      if (skippedCount > 0) {
        showToast(
          `Đã nạp ${addedCount} cuốn mới vào kho (Đã tự động loại bỏ ${skippedCount} cuốn bị trùng)!`,
          'success'
        );
      } else {
        showToast(`Đã nạp thành công ${addedCount} cuốn sách vào kho!`, 'success');
      }
      onClose();
    } catch (err: any) {
      showToast(`Lỗi nhập file: ${err.message}`, 'error');
    } finally {
      setIsProcessing(false);
      e.target.value = '';
    }
  };

  const handleImportJsonText = async () => {
    if (!jsonText.trim()) {
      showToast('Vui lòng dán chuỗi JSON vào ô!', 'warning');
      return;
    }

    setIsProcessing(true);
    try {
      const imported = importBooksFromJson(jsonText);
      const { addedCount, skippedCount } = await onImportBooks(imported, importMode === 'replace');
      if (skippedCount > 0) {
        showToast(
          `Đã nạp ${addedCount} cuốn mới vào kho (Bỏ qua ${skippedCount} cuốn trùng)!`,
          'success'
        );
      } else {
        showToast(`Đã nạp thành công ${addedCount} cuốn sách từ JSON!`, 'success');
      }
      onClose();
    } catch (err: any) {
      showToast(`Lỗi parse JSON: ${err.message}`, 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownloadJson = () => {
    const json = exportBooksToJson(books);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kho_sach_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    showToast('Đã tải xuống file JSON sao lưu thành công!', 'success');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-lg w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">Sao Lưu &amp; Đồng Bộ Kho Sách</h3>
              <p className="text-xs text-slate-500">Google Drive REST API &amp; Xuất/Nhập Dữ Liệu</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-100 px-6 pt-3 gap-4 text-xs font-bold">
          <button
            onClick={() => setActiveTab('export')}
            className={`pb-3 border-b-2 transition ${
              activeTab === 'export'
                ? 'border-emerald-600 text-emerald-700'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Xuất Dữ Liệu (Backup)
          </button>
          <button
            onClick={() => setActiveTab('import')}
            className={`pb-3 border-b-2 transition ${
              activeTab === 'import'
                ? 'border-emerald-600 text-emerald-700'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Nhập File (Restore)
          </button>
          <button
            onClick={() => setActiveTab('drive')}
            className={`pb-3 border-b-2 transition ${
              activeTab === 'drive'
                ? 'border-emerald-600 text-emerald-700'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Google Sheet &amp; Drive
          </button>
        </div>

        {/* Tab Body */}
        <div className="p-6 overflow-y-auto space-y-4">
          {activeTab === 'export' && (
            <div className="space-y-4">
              <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100 text-xs text-emerald-900">
                <span className="font-bold">Hiện đang có {books.length} cuốn sách trong CSDL Firestore.</span>
                <p className="mt-1 text-emerald-700">
                  Dữ liệu 100% text/numeric siêu nhẹ, bạn có thể sao lưu ra nhiều định dạng khác nhau để lưu trữ an toàn.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={handleDownloadJson}
                  className="flex items-center justify-center gap-2 p-4 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-2xl text-xs font-bold text-slate-800 transition text-left"
                >
                  <FileText className="w-5 h-5 text-indigo-600 shrink-0" />
                  <div>
                    <div>Xuất file JSON</div>
                    <div className="text-[10px] text-slate-400 font-normal">Định dạng chuẩn REST API</div>
                  </div>
                </button>

                <button
                  onClick={() => {
                    exportBooksToExcel(books);
                    showToast('Đã tải xuống file Excel!', 'success');
                  }}
                  className="flex items-center justify-center gap-2 p-4 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-2xl text-xs font-bold text-slate-800 transition text-left"
                >
                  <FileSpreadsheet className="w-5 h-5 text-emerald-600 shrink-0" />
                  <div>
                    <div>Xuất file Excel (.xlsx)</div>
                    <div className="text-[10px] text-slate-400 font-normal">Mở dễ dàng trên máy tính</div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'import' && (
            <div className="space-y-4">
              {/* Chế độ nhập */}
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                <span className="font-bold text-slate-700">Chế độ ghi dữ liệu:</span>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="importMode"
                      checked={importMode === 'append'}
                      onChange={() => setImportMode('append')}
                      className="text-emerald-600"
                    />
                    <span>Thêm vào kho (Gộp)</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer ml-2">
                    <input
                      type="radio"
                      name="importMode"
                      checked={importMode === 'replace'}
                      onChange={() => setImportMode('replace')}
                      className="text-emerald-600"
                    />
                    <span className="text-rose-600 font-bold">Ghi đè toàn bộ</span>
                  </label>
                </div>
              </div>

              {/* Upload file */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.xlsx,.xls,.csv"
                className="hidden"
                onChange={handleFileUpload}
              />

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isProcessing}
                className="w-full py-8 border-2 border-dashed border-slate-300 hover:border-emerald-500 rounded-2xl flex flex-col items-center justify-center text-slate-600 hover:text-emerald-700 hover:bg-emerald-50/50 transition group"
              >
                {isProcessing ? (
                  <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
                ) : (
                  <>
                    <Upload className="w-8 h-8 text-slate-400 group-hover:text-emerald-600 transition mb-2" />
                    <span className="text-xs font-bold">Bấm để chọn file .JSON / .XLSX / .CSV</span>
                    <span className="text-[11px] text-slate-400 mt-1">Tự động nhận diện cấu trúc các cột dữ liệu</span>
                  </>
                )}
              </button>

              {/* Paste JSON text */}
              <div className="space-y-1.5 pt-2">
                <label className="text-xs font-bold text-slate-700">Hoặc dán trực tiếp chuỗi JSON:</label>
                <textarea
                  rows={3}
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder='[ { "title": "Mắt Biếc", "author": "Nguyễn Nhật Ánh", ... } ]'
                  className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <button
                  onClick={handleImportJsonText}
                  disabled={isProcessing || !jsonText.trim()}
                  className="w-full py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition disabled:opacity-40"
                >
                  Nạp Dữ Liệu Từ JSON Text
                </button>
              </div>
            </div>
          )}

          {activeTab === 'drive' && (
            <div className="space-y-4">
              {/* Card Giới thiệu gọn */}
              <div className="p-3.5 bg-emerald-50/80 rounded-2xl border border-emerald-100 text-xs text-emerald-900 flex items-start gap-3">
                <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0 mt-0.5">
                  <FileSpreadsheet className="w-4 h-4" />
                </div>
                <div className="space-y-1">
                  <div className="font-bold text-emerald-950">Đồng Bộ Trực Tiếp Từ Google Sheet</div>
                  <p className="text-[11px] text-emerald-800 leading-relaxed">
                    Chỉ cần dán link file Google Sheet của bạn vào ô dưới, hệ thống sẽ tự động đọc dữ liệu, lọc trùng và nạp trực tiếp vào kho sách!
                  </p>
                </div>
              </div>

              {isUsingDummyScript && (
                <div className="p-4 bg-amber-50 rounded-2xl border border-amber-200 text-xs text-amber-900 space-y-2 animate-pulse">
                  <div className="font-bold flex items-center gap-1.5 text-amber-950 text-sm">
                    <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                    Chưa cấu hình Apps Script cá nhân!
                  </div>
                  <p className="text-[11px] text-amber-800 leading-relaxed">
                    Bạn đang dùng <strong>URL Apps Script mẫu (mặc định)</strong>. Ở chế độ này, ứng dụng <strong>chỉ có thể đọc sách về</strong> chứ <strong>KHÔNG thể đồng bộ tự động 2 chiều (Thêm, Sửa, Xóa từ App ghi đè lên Sheet)</strong>.
                  </p>
                  <p className="text-[11px] text-amber-800 leading-relaxed font-semibold bg-white/60 p-2.5 rounded-xl border border-amber-100">
                    👉 <strong>Cách khắc phục:</strong> Bấm nút <strong>"⚙️ Tùy chọn nâng cao"</strong> bên dưới &rarr; copy mã Apps Script &rarr; dán vào <a href="https://script.google.com" target="_blank" rel="noopener noreferrer" className="underline text-indigo-700 hover:text-indigo-900">script.google.com</a> &rarr; <strong>Triển khai ứng dụng Web (Execute as: Tôi, Access: Bất kỳ ai)</strong> &rarr; dán link Web App thu được vào ô cấu hình!
                  </p>
                </div>
              )}

              {/* Ô nhập Link File Google Sheet */}
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
                <div>
                  <label className="flex items-center justify-between text-xs font-bold text-slate-800 mb-1.5">
                    <span className="flex items-center gap-1.5">
                      <Link2 className="w-4 h-4 text-emerald-600" />
                      Link File Google Sheet (Editor Link):
                    </span>
                  </label>
                  <input
                    type="text"
                    value={targetFileUrl}
                    onChange={(e) => setTargetFileUrl(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/1WmvnebrW2NwMAc5r.../edit"
                    className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 shadow-xs"
                  />
                  <div className="mt-2 text-[11px] text-slate-500 bg-white/60 p-2 rounded-lg border border-slate-100 flex items-center gap-1.5">
                    <span className="text-emerald-600 font-bold">💡 Lưu ý:</span>
                    <span>Trên Google Sheet, bấm <strong>Chia sẻ</strong> &rarr; Chọn <strong>"Bất kỳ ai có đường liên kết đều có thể xem"</strong>.</span>
                  </div>
                </div>

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleSaveConfig}
                    className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition shadow-xs"
                  >
                    Lưu Link File
                  </button>
                  <button
                    onClick={handleTestConnection}
                    disabled={isSyncingDrive || !targetFileUrl.trim()}
                    className="px-4 py-2.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-xl text-xs font-bold transition flex items-center gap-1.5 disabled:opacity-40"
                  >
                    {isSyncingDrive ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />}
                    <span>Kiểm tra kết nối</span>
                  </button>
                </div>
              </div>

              {/* 2 Nút Đẩy & Kéo Dữ Liệu */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <button
                  onClick={handlePullFromDrive}
                  disabled={isSyncingDrive || (!targetFileUrl.trim() && !scriptUrlInput.trim())}
                  className="p-4 bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-2xl text-xs font-bold text-sky-900 transition flex items-center gap-3 disabled:opacity-40 text-left shadow-xs"
                >
                  {isSyncingDrive ? (
                    <Loader2 className="w-6 h-6 animate-spin text-sky-600 shrink-0" />
                  ) : (
                    <Download className="w-6 h-6 text-sky-600 shrink-0" />
                  )}
                  <div>
                    <div className="text-sm font-bold text-sky-950">Kéo Dữ Liệu Từ Sheet Về</div>
                    <div className="text-[11px] text-sky-700 font-normal mt-0.5">Tự động lọc trùng &amp; nạp vào App</div>
                  </div>
                </button>

                <button
                  onClick={handlePushToDrive}
                  disabled={isSyncingDrive}
                  className="p-4 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-2xl text-xs font-bold text-emerald-900 transition flex items-center gap-3 disabled:opacity-40 text-left shadow-xs"
                >
                  {isSyncingDrive ? (
                    <Loader2 className="w-6 h-6 animate-spin text-emerald-600 shrink-0" />
                  ) : (
                    <Upload className="w-6 h-6 text-emerald-600 shrink-0" />
                  )}
                  <div>
                    <div className="text-sm font-bold text-emerald-950">Đẩy Dữ Liệu Sạch Lên Sheet</div>
                    <div className="text-[11px] text-emerald-700 font-normal mt-0.5">Lưu bản chuẩn hóa {books.length} cuốn</div>
                  </div>
                </button>
              </div>

              {/* Tùy chọn nâng cao Apps Script thu gọn */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setShowAdvancedScript(!showAdvancedScript)}
                  className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition"
                >
                  <span>⚙️ Tùy chọn nâng cao (Ghi 2 chiều qua Google Apps Script)</span>
                  {showAdvancedScript ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>

                {showAdvancedScript && (
                  <div className="mt-2 p-3.5 bg-slate-50 border border-slate-200 rounded-2xl space-y-2.5 animate-in fade-in duration-150">
                    <label className="block text-[11px] font-bold text-slate-700">
                      URL Google Apps Script Web App (API Endpoint):
                    </label>
                    <input
                      type="text"
                      value={scriptUrlInput}
                      onChange={(e) => setScriptUrlInput(e.target.value)}
                      placeholder="https://script.google.com/macros/s/.../exec"
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleSaveConfig}
                        className="flex-1 py-1.5 bg-slate-700 hover:bg-slate-800 text-white rounded-lg text-xs font-bold transition"
                      >
                        Lưu Endpoint
                      </button>
                      <button
                        onClick={handleCopyScriptCode}
                        className="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-bold transition"
                      >
                        Sao chép Mã Apps Script
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* PANEL DEBUG TẠM THỜI (TEMPORARY SYNC LOGS MONITOR) */}
              <div className="mt-4 border-t border-slate-200 pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping shrink-0" />
                    Bảng Giám Sát Đồng Bộ (Debug Logs Realtime)
                  </span>
                  {logs.length > 0 && (
                    <button
                      onClick={() => {
                        clearSyncLogs();
                        setLogs([]);
                      }}
                      className="text-[10px] text-slate-400 hover:text-slate-600 underline font-medium"
                    >
                      Xóa toàn bộ logs
                    </button>
                  )}
                </div>

                {logs.length === 0 ? (
                  <div className="p-3 bg-slate-50 border border-slate-100 rounded-xl text-center text-[11px] text-slate-400">
                    Chưa có logs yêu cầu đồng bộ nào được tạo ra. Hãy thử Thêm/Sửa/Xóa hoặc bấm Đồng bộ/Kiểm tra kết nối để xem log.
                  </div>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {logs.map((log, index) => {
                      const dateStr = new Date(log.timestamp).toLocaleTimeString('vi-VN');
                      return (
                        <div key={index} className={`p-3 rounded-xl border text-xs ${log.success ? 'bg-slate-50/50 border-slate-200' : 'bg-rose-50/30 border-rose-100'}`}>
                          <div className="flex items-center justify-between font-mono font-bold text-[10px] mb-1.5">
                            <span className="flex items-center gap-1.5">
                              <span className={`px-1.5 py-0.5 rounded-md ${
                                log.type === 'PUSH' ? 'bg-emerald-100 text-emerald-800' : 
                                log.type === 'PULL' ? 'bg-sky-100 text-sky-800' : 'bg-indigo-100 text-indigo-800'
                              }`}>
                                {log.type}
                              </span>
                              <span className="text-slate-400">{dateStr}</span>
                            </span>
                            <span className={`px-1.5 py-0.5 rounded-md ${log.success ? 'bg-green-100 text-green-800' : 'bg-rose-100 text-rose-800'}`}>
                              {log.status !== undefined ? `HTTP ${log.status}` : 'No Status'} {log.fallbackUsed ? '(no-cors)' : ''}
                            </span>
                          </div>

                          <div className="space-y-1 font-mono text-[10px] text-slate-600 break-all">
                            <div><span className="font-bold text-slate-800">URL:</span> {log.url}</div>
                            {log.error && (
                              <div className="text-rose-600 font-bold bg-rose-50 p-1.5 rounded-md border border-rose-100 mt-1">
                                <span className="underline">Error:</span> {log.error}
                              </div>
                            )}

                            {/* Request Payload */}
                            {log.payload && (
                              <div className="mt-1">
                                <details className="cursor-pointer">
                                  <summary className="text-indigo-600 hover:text-indigo-800 font-bold underline select-none">
                                    Xem Request Payload
                                  </summary>
                                  <pre className="mt-1 p-2 bg-slate-900 text-slate-200 text-[9px] rounded-lg overflow-x-auto max-h-28">
                                    {JSON.stringify(log.payload, null, 2)}
                                  </pre>
                                </details>
                              </div>
                            )}

                            {/* Response Body */}
                            {log.responseBody && (
                              <div className="mt-1">
                                <details className="cursor-pointer" open>
                                  <summary className="text-emerald-600 hover:text-emerald-800 font-bold underline select-none">
                                    Xem Response Body (Kết Quả Trả Về Từ Google)
                                  </summary>
                                  <pre className="mt-1 p-2 bg-slate-900 text-emerald-400 text-[9px] rounded-lg overflow-x-auto max-h-40 font-mono">
                                    {typeof log.responseBody === 'object' 
                                      ? JSON.stringify(log.responseBody, null, 2) 
                                      : String(log.responseBody)
                                    }
                                  </pre>
                                </details>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
