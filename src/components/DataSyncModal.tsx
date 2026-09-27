import React, { useState, useRef } from 'react';
import { X, Upload, FileText, FileSpreadsheet, HardDrive, Download, AlertCircle, CheckCircle, Loader2, ChevronDown, ChevronUp, Link2, Eye, EyeOff } from 'lucide-react';
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

  const [storedScriptUrl, setStoredScriptUrl] = useState(() => driveSyncUrl || getStoredOrConfiguredScriptUrl());
  const [storedSheetUrl, setStoredSheetUrl] = useState(() => driveTargetFileUrl || getStoredOrConfiguredSheetUrl());

  const [scriptUrlInput, setScriptUrlInput] = useState('');
  const [targetFileUrl, setTargetFileUrl] = useState('');
  const [isSyncingDrive, setIsSyncingDrive] = useState(false);
  const [showAdvancedScript, setShowAdvancedScript] = useState(() => {
    const url = driveSyncUrl || getStoredOrConfiguredScriptUrl();
    return url.includes('AKfyczt126a5BfMe-0o8') || !url.trim();
  });

  const isUsingDummyScript = (scriptUrlInput.trim() || storedScriptUrl).includes('AKfyczt126a5BfMe-0o8') || !(scriptUrlInput.trim() || storedScriptUrl).trim();

  const [showSheetUrl, setShowSheetUrl] = useState(false);
  const [showScriptUrl, setShowScriptUrl] = useState(false);

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

  // Sync stored URLs with configuration/props, keeping inputs blank
  React.useEffect(() => {
    const sheet = driveTargetFileUrl || getStoredOrConfiguredSheetUrl();
    const script = driveSyncUrl || getStoredOrConfiguredScriptUrl();
    setStoredSheetUrl(sheet);
    setStoredScriptUrl(script);
    setTargetFileUrl('');
    setScriptUrlInput('');
  }, [driveSyncUrl, driveTargetFileUrl, isOpen]);

  if (!isOpen) return null;

  const handleSaveConfig = () => {
    const finalSheet = targetFileUrl.trim() ? targetFileUrl.trim() : storedSheetUrl;
    const finalScript = scriptUrlInput.trim() ? sanitizeAppsScriptUrl(scriptUrlInput) : storedScriptUrl;

    setStoredSheetUrl(finalSheet);
    setStoredScriptUrl(finalScript);
    setTargetFileUrl('');
    setScriptUrlInput('');

    localStorage.setItem('drive_sync_url_v1', finalScript);
    localStorage.setItem('drive_target_file_url_v1', finalSheet);

    if (onSaveConfig) {
      onSaveConfig(finalSheet, finalScript);
    }
    showToast('Đã lưu cấu hình Google Sheet & Apps Script thành công!', 'success');
  };

  const handleTestConnection = async () => {
    const effectiveSheet = targetFileUrl.trim() || storedSheetUrl;
    const effectiveScript = scriptUrlInput.trim() || storedScriptUrl;

    if (!effectiveSheet.trim() && !effectiveScript.trim()) {
      showToast('Vui lòng dán link file Google Sheet trước!', 'warning');
      return;
    }

    setIsSyncingDrive(true);
    let successMessages: string[] = [];
    
    // 1. Kiểm tra đọc trực tiếp Google Sheet Link
    if (effectiveSheet.trim()) {
      const match = effectiveSheet.trim().match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        try {
          const proxyUrl = getProxyUrl(`https://docs.google.com/spreadsheets/d/${match[1]}/gviz/tq?tqx=out:csv`);
          const csvResp = await fetch(proxyUrl);
          if (csvResp.ok) {
            const text = await csvResp.text();
            if (text && !text.includes('<!DOCTYPE html>') && !text.includes('<html>')) {
              const parsed = parseGoogleSheetCsvText(text);
              successMessages.push(`✅ Đọc Google Sheet thành công (${parsed.length} cuốn sách)`);
            }
          }
        } catch (e) {}
      }
    }

    // 2. Kiểm tra Google Apps Script Endpoint (nếu có cấu hình)
    if (effectiveScript.trim()) {
      const cleanUrl = sanitizeAppsScriptUrl(effectiveScript);
      
      if (cleanUrl.includes('docs.google.com/spreadsheets')) {
        successMessages.push(`❌ Lỗi Apps Script: Bạn đang dán NHẦM Link Google Sheet vào ô URL Apps Script!`);
      } else if (!cleanUrl.includes('script.google.com/macros/')) {
        successMessages.push(`❌ Lỗi Apps Script: Link không đúng định dạng Web App (thiếu script.google.com)`);
      } else {
        try {
          let testUrl = cleanUrl;
          if (effectiveSheet.trim()) {
            testUrl += (testUrl.includes('?') ? '&' : '?') + `fileUrl=${encodeURIComponent(effectiveSheet.trim())}`;
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
    const effectiveSheet = targetFileUrl.trim() || storedSheetUrl;
    const effectiveScript = scriptUrlInput.trim() || storedScriptUrl;

    if (!effectiveScript.trim()) {
      showToast('Để đẩy ngược dữ liệu lên Sheet, vui lòng cấu hình thêm URL Apps Script ở phần Tùy chọn nâng cao.', 'warning');
      setShowAdvancedScript(true);
      return;
    }
    setIsSyncingDrive(true);
    try {
      const res = await pushCleanDataToDriveWebApp(
        effectiveScript.trim(),
        books,
        effectiveSheet.trim()
      );
      showToast(res.message, 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsSyncingDrive(false);
    }
  };

  const handlePullFromDrive = async () => {
    const effectiveSheet = targetFileUrl.trim() || storedSheetUrl;
    const effectiveScript = scriptUrlInput.trim() || storedScriptUrl;

    if (!effectiveSheet.trim() && !effectiveScript.trim()) {
      showToast('Vui lòng dán Link Google Sheet vào ô nhập!', 'warning');
      return;
    }
    setIsSyncingDrive(true);
    try {
      const res = await pullDataFromDriveWebApp(
        effectiveScript.trim(),
        effectiveSheet.trim()
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
      <div className="bg-white rounded-3xl max-w-lg w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
              <HardDrive className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-900 leading-tight">Đồng Bộ &amp; Sao Lưu</h3>
              <p className="text-[10px] text-slate-500">Google Drive &amp; CSDL Đám Mây</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs - Compact & single-line on mobile */}
        <div className="flex border-b border-slate-100 px-4 pt-2 gap-3 text-[11px] font-bold overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab('export')}
            className={`pb-2 border-b-2 transition whitespace-nowrap ${
              activeTab === 'export'
                ? 'border-emerald-600 text-emerald-700 font-extrabold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Sao Lưu (Export)
          </button>
          <button
            onClick={() => setActiveTab('import')}
            className={`pb-2 border-b-2 transition whitespace-nowrap ${
              activeTab === 'import'
                ? 'border-emerald-600 text-emerald-700 font-extrabold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Khôi Phục (Import)
          </button>
          <button
            onClick={() => setActiveTab('drive')}
            className={`pb-2 border-b-2 transition whitespace-nowrap ${
              activeTab === 'drive'
                ? 'border-emerald-600 text-emerald-700 font-extrabold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Đồng Bộ Cloud
          </button>
        </div>

        {/* Tab Body - Compact Padding */}
        <div className="p-4 overflow-y-auto space-y-3.5 flex-1">
          {activeTab === 'export' && (
            <div className="space-y-3">
              <div className="p-3 bg-emerald-50/60 rounded-2xl border border-emerald-100 text-[11px] text-emerald-950">
                <span className="font-extrabold block mb-0.5 text-emerald-900">Hiện đang có {books.length} cuốn sách trong bộ nhớ máy (Local Storage).</span>
                <p className="text-emerald-800 leading-normal">
                  Dữ liệu text cực nhẹ, bạn có thể sao lưu ra file để lưu trữ ngoại tuyến an toàn.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  onClick={handleDownloadJson}
                  className="flex items-center gap-3 p-3 bg-slate-50 hover:bg-slate-100 active:scale-[0.99] border border-slate-200 rounded-2xl text-[11px] font-bold text-slate-800 transition text-left h-14"
                >
                  <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600 shrink-0">
                    <FileText className="w-4 h-4 shrink-0" />
                  </div>
                  <div>
                    <div className="font-extrabold">Xuất file JSON</div>
                    <div className="text-[9px] text-slate-400 font-normal">Sao lưu chuẩn CSDL</div>
                  </div>
                </button>

                <button
                  onClick={() => {
                    exportBooksToExcel(books);
                    showToast('Đã tải xuống file Excel!', 'success');
                  }}
                  className="flex items-center gap-3 p-3 bg-slate-50 hover:bg-slate-100 active:scale-[0.99] border border-slate-200 rounded-2xl text-[11px] font-bold text-slate-800 transition text-left h-14"
                >
                  <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600 shrink-0">
                    <FileSpreadsheet className="w-4 h-4 shrink-0" />
                  </div>
                  <div>
                    <div className="font-extrabold">Xuất file Excel (.xlsx)</div>
                    <div className="text-[9px] text-slate-400 font-normal">Mở dễ dàng trên máy tính</div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'import' && (
            <div className="space-y-3">
              {/* Chế độ nhập */}
              <div className="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-200 text-[11px]">
                <span className="font-bold text-slate-700">Chế độ ghi đè:</span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="importMode"
                      checked={importMode === 'append'}
                      onChange={() => setImportMode('append')}
                      className="text-emerald-600"
                    />
                    <span className="font-bold">Gộp thêm</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="importMode"
                      checked={importMode === 'replace'}
                      onChange={() => setImportMode('replace')}
                      className="text-emerald-600"
                    />
                    <span className="text-rose-600 font-extrabold">Ghi đè sạch</span>
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
                className="w-full py-5 border-2 border-dashed border-slate-200 hover:border-emerald-500 rounded-2xl flex flex-col items-center justify-center text-slate-600 hover:text-emerald-700 hover:bg-emerald-50/20 transition group h-24"
              >
                {isProcessing ? (
                  <Loader2 className="w-6 h-6 animate-spin text-emerald-600" />
                ) : (
                  <>
                    <Upload className="w-6 h-6 text-slate-400 group-hover:text-emerald-600 transition mb-1" />
                    <span className="text-[11px] font-bold">Chọn file JSON / Excel / CSV</span>
                    <span className="text-[9px] text-slate-400 mt-0.5">Tự động nhận diện cấu trúc</span>
                  </>
                )}
              </button>

              {/* Paste JSON text */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-slate-700 block">Hoặc dán chuỗi JSON:</label>
                <div className="relative">
                  <textarea
                    rows={2}
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    placeholder='[ { "title": "Tên Sách", "author": "Tác Giả" } ]'
                    className="w-full p-2 bg-slate-50 border border-slate-200 rounded-xl text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-slate-400"
                  />
                </div>
                <button
                  onClick={handleImportJsonText}
                  disabled={isProcessing || !jsonText.trim()}
                  className="w-full py-2 bg-slate-800 hover:bg-slate-900 active:scale-[0.99] text-white rounded-xl text-xs font-bold transition disabled:opacity-40"
                >
                  Nạp Dữ Liệu JSON
                </button>
              </div>
            </div>
          )}

          {activeTab === 'drive' && (
            <div className="space-y-3.5">
              {/* Card Giới thiệu gọn */}
              <div className="p-3 bg-emerald-50/50 rounded-2xl border border-emerald-100 text-[11px] text-emerald-950 flex items-start gap-3">
                <div className="w-7 h-7 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0 mt-0.5">
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                </div>
                <div className="space-y-0.5">
                  <div className="font-extrabold text-emerald-950">Đồng Bộ Cloud 2 Chiều</div>
                  <p className="text-[10px] text-emerald-800 leading-relaxed">
                    Dữ liệu được lưu trữ trực tiếp trên thiết bị và đồng bộ 2 chiều với Google Drive qua Apps Script.
                  </p>
                </div>
              </div>

              {isUsingDummyScript && (
                <div className="p-3 bg-amber-50/80 rounded-2xl border border-amber-100 text-[10px] text-amber-950 space-y-1">
                  <div className="font-extrabold flex items-center gap-1 text-amber-900">
                    <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                    Đang dùng Apps Script mẫu!
                  </div>
                  <p className="text-[9.5px] text-amber-800 leading-relaxed">
                    Bạn đang dùng URL mẫu nên <strong>chỉ có thể đọc sách về</strong>, không thể đồng bộ 2 chiều (ghi đè lên Sheet). Hãy cấu hình Apps Script riêng bên dưới.
                  </p>
                </div>
              )}

              {/* Ô nhập Link File Google Sheet */}
              <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 space-y-2.5">
                <div>
                  <label className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] font-bold text-slate-800 mb-1">
                    <span className="flex items-center gap-1">
                      <Link2 className="w-3.5 h-3.5 text-emerald-600" />
                      Link File Google Sheet:
                    </span>
                    {storedSheetUrl && storedSheetUrl.trim().length > 0 && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200 text-[9px] font-extrabold">
                        <CheckCircle className="w-2.5 h-2.5 text-emerald-600 shrink-0" />
                        Đã lưu bảo mật trên Cloud
                      </span>
                    )}
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showSheetUrl ? "text" : "password"}
                      value={targetFileUrl}
                      onChange={(e) => setTargetFileUrl(e.target.value)}
                      placeholder={
                        storedSheetUrl && storedSheetUrl.trim().length > 0
                          ? "🔒 Đã cấu hình trên đám mây. Nhập link mới để thay đổi..."
                          : "https://docs.google.com/spreadsheets/d/1WmvnebrW2NwMAc5r.../edit"
                      }
                      className="w-full pl-3 pr-8 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-slate-400 placeholder:font-sans"
                    />
                    {targetFileUrl.trim().length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowSheetUrl(!showSheetUrl)}
                        className="absolute right-2 text-slate-400 hover:text-slate-600 focus:outline-none p-1"
                      >
                        {showSheetUrl ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex gap-2 pt-0.5">
                  <button
                    onClick={handleSaveConfig}
                    disabled={!targetFileUrl.trim()}
                    className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-[10px] font-bold transition disabled:opacity-40"
                  >
                    Lưu Link Sheet
                  </button>
                  <button
                    onClick={handleTestConnection}
                    disabled={isSyncingDrive || (!targetFileUrl.trim() && !storedSheetUrl.trim())}
                    className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-lg text-[10px] font-bold transition flex items-center gap-1 disabled:opacity-40 shrink-0"
                  >
                    {isSyncingDrive ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3 text-emerald-600" />}
                    <span>Kiểm tra</span>
                  </button>
                </div>
              </div>

              {/* 2 Nút Đẩy & Kéo Dữ Liệu */}
              <div className="grid grid-cols-2 gap-2 pt-0.5">
                <button
                  onClick={handlePullFromDrive}
                  disabled={isSyncingDrive || (!(targetFileUrl.trim() || storedSheetUrl).trim() && !(scriptUrlInput.trim() || storedScriptUrl).trim())}
                  className="p-3 bg-sky-50/60 hover:bg-sky-100 border border-sky-100 rounded-2xl transition flex items-center gap-2.5 disabled:opacity-40 text-left h-16"
                >
                  {isSyncingDrive ? (
                    <Loader2 className="w-5 h-5 animate-spin text-sky-600 shrink-0" />
                  ) : (
                    <Download className="w-5 h-5 text-sky-600 shrink-0" />
                  )}
                  <div>
                    <div className="text-[11px] font-extrabold text-sky-950 leading-tight">Kéo Sách Về</div>
                    <div className="text-[9px] text-sky-700 font-normal mt-0.5 leading-normal">Tải từ Google Sheet về</div>
                  </div>
                </button>

                <button
                  onClick={handlePushToDrive}
                  disabled={isSyncingDrive || !(scriptUrlInput.trim() || storedScriptUrl).trim()}
                  className="p-3 bg-emerald-50/60 hover:bg-emerald-100 border border-emerald-100 rounded-2xl transition flex items-center gap-2.5 disabled:opacity-40 text-left h-16"
                >
                  {isSyncingDrive ? (
                    <Loader2 className="w-5 h-5 animate-spin text-emerald-600 shrink-0" />
                  ) : (
                    <Upload className="w-5 h-5 text-emerald-600 shrink-0" />
                  )}
                  <div>
                    <div className="text-[11px] font-extrabold text-emerald-950 leading-tight">Đẩy Sách Lên</div>
                    <div className="text-[9px] text-emerald-700 font-normal mt-0.5 leading-normal">Ghi đè {books.length} cuốn lên Sheet</div>
                  </div>
                </button>
              </div>

              {/* Tùy chọn nâng cao Apps Script thu gọn */}
              <div className="pt-0.5">
                <button
                  type="button"
                  onClick={() => setShowAdvancedScript(!showAdvancedScript)}
                  className="w-full flex items-center justify-between px-2.5 py-1.5 text-[10px] font-bold text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition"
                >
                  <span>⚙️ Tùy chọn nâng cao (Ghi 2 chiều)</span>
                  {showAdvancedScript ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>

                {showAdvancedScript && (
                  <div className="mt-1.5 p-3 bg-slate-50 border border-slate-200 rounded-2xl space-y-2.5 animate-in fade-in duration-150">
                    <label className="flex flex-wrap items-center justify-between gap-1 text-[10px] font-bold text-slate-700">
                      <span>URL Apps Script (Web App):</span>
                      {storedScriptUrl && storedScriptUrl.trim().length > 0 && !storedScriptUrl.includes('AKfyczt126a5BfMe-0o8') && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 border border-indigo-200 text-[8px] font-extrabold">
                          <CheckCircle className="w-2 h-2 text-indigo-600 shrink-0" />
                          Đã lưu trên Cloud
                        </span>
                      )}
                    </label>
                    <div className="relative flex items-center">
                      <input
                        type={showScriptUrl ? "text" : "password"}
                        value={scriptUrlInput}
                        onChange={(e) => setScriptUrlInput(e.target.value)}
                        placeholder={
                          storedScriptUrl && storedScriptUrl.trim().length > 0 && !storedScriptUrl.includes('AKfyczt126a5BfMe-0o8')
                            ? "🔒 Đã có endpoint bảo mật trên Cloud. Nhập API mới..."
                            : "https://script.google.com/macros/s/.../exec"
                        }
                        className="w-full pl-3 pr-8 py-1.5 bg-white border border-slate-200 rounded-xl text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-slate-400 placeholder:font-sans"
                      />
                      {scriptUrlInput.trim().length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowScriptUrl(!showScriptUrl)}
                          className="absolute right-2 text-slate-400 hover:text-slate-600 focus:outline-none p-1"
                        >
                          {showScriptUrl ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={handleSaveConfig}
                        disabled={!scriptUrlInput.trim()}
                        className="flex-1 py-1.5 bg-slate-700 hover:bg-slate-800 text-white rounded-lg text-[10px] font-bold transition disabled:opacity-40"
                      >
                        Lưu Endpoint
                      </button>
                      <button
                        onClick={handleCopyScriptCode}
                        className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-[10px] font-bold transition whitespace-nowrap"
                      >
                        Sao Chép Code
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* PANEL DEBUG TẠM THỜI (TEMPORARY SYNC LOGS MONITOR) */}
              <div className="border-t border-slate-200 pt-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-slate-800 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping shrink-0" />
                    Bảng Giám Sát (Realtime Logs)
                  </span>
                  {logs.length > 0 && (
                    <button
                      onClick={() => {
                        clearSyncLogs();
                        setLogs([]);
                      }}
                      className="text-[9px] text-slate-400 hover:text-slate-600 underline font-medium"
                    >
                      Xóa logs
                    </button>
                  )}
                </div>

                {logs.length === 0 ? (
                  <div className="p-2.5 bg-slate-50 border border-slate-100 rounded-xl text-center text-[10px] text-slate-400 leading-normal">
                    Chưa phát sinh log đồng bộ nào.
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {logs.map((log, index) => {
                      const dateStr = new Date(log.timestamp).toLocaleTimeString('vi-VN');
                      return (
                        <div key={index} className={`p-2 rounded-xl border text-[9.5px] ${log.success ? 'bg-slate-50/50 border-slate-150' : 'bg-rose-50/20 border-rose-100'}`}>
                          <div className="flex items-center justify-between font-mono font-bold text-[9px] mb-1">
                            <span className="flex items-center gap-1">
                              <span className={`px-1 py-0.2 rounded ${
                                log.type === 'PUSH' ? 'bg-emerald-100 text-emerald-800' : 
                                log.type === 'PULL' ? 'bg-sky-100 text-sky-800' : 'bg-indigo-100 text-indigo-800'
                              }`}>
                                {log.type}
                              </span>
                              <span className="text-slate-400">{dateStr}</span>
                            </span>
                            <span className={`px-1 py-0.2 rounded ${log.success ? 'bg-green-100 text-green-800' : 'bg-rose-100 text-rose-800'}`}>
                              {log.status !== undefined ? `HTTP ${log.status}` : 'No Status'}
                            </span>
                          </div>

                          <div className="space-y-0.5 font-mono text-[9px] text-slate-500 break-all leading-normal">
                            <div><span className="font-bold text-slate-700">URL:</span> {log.url}</div>
                            {log.error && (
                              <div className="text-rose-600 font-bold bg-rose-50/50 p-1 rounded border border-rose-100/60 mt-0.5">
                                {log.error}
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
