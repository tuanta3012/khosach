import React, { useState, useRef } from 'react';
import { 
  X, Upload, FileText, FileSpreadsheet, HardDrive, Download, CheckCircle, 
  Loader2, Link2, Sparkles, RefreshCw, ShieldCheck
} from 'lucide-react';
import { BookRecord } from '../types';
import {
  exportBooksToJson,
  importBooksFromJson,
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
  smartDriveFetch,
} from '../utils/driveSyncService';
import {
  getStoredOrConfiguredSheetUrl,
  getStoredOrConfiguredScriptUrl,
} from '../config/syncConfig';
import {
  saveCustomGeminiApiKey,
  getCustomGeminiApiKey,
  clearCustomGeminiApiKey,
  testGeminiApiKey,
  getGeminiApiKey,
} from '../utils/geminiService';

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

  // URL & API Key States
  const [storedScriptUrl, setStoredScriptUrl] = useState(() => driveSyncUrl || getStoredOrConfiguredScriptUrl());
  const [storedSheetUrl, setStoredSheetUrl] = useState(() => driveTargetFileUrl || getStoredOrConfiguredSheetUrl());
  const [storedApiKey, setStoredApiKey] = useState(() => getCustomGeminiApiKey());

  const [scriptUrlInput, setScriptUrlInput] = useState('');
  const [targetFileUrl, setTargetFileUrl] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');

  const [isSyncingDrive, setIsSyncingDrive] = useState(false);
  const [isTestingApiKey, setIsTestingApiKey] = useState(false);

  React.useEffect(() => {
    const sheet = driveTargetFileUrl || getStoredOrConfiguredSheetUrl();
    const script = driveSyncUrl || getStoredOrConfiguredScriptUrl();
    setStoredSheetUrl(sheet);
    setStoredScriptUrl(script);
    setStoredApiKey(getCustomGeminiApiKey());
  }, [driveSyncUrl, driveTargetFileUrl, isOpen]);

  // 1. Kiểm tra & Lưu Gemini API Key
  const handleSaveApiKey = async () => {
    const keyToTest = apiKeyInput.trim();
    if (!keyToTest) {
      showToast('Vui lòng nhập API Key để kiểm tra!', 'warning');
      return;
    }

    setIsTestingApiKey(true);
    try {
      const res = await testGeminiApiKey(keyToTest);
      if (res.success) {
        saveCustomGeminiApiKey(keyToTest);
        setStoredApiKey(keyToTest);
        setApiKeyInput('');
        showToast('✅ Đã lưu Google Gemini API Key thành công!', 'success');
      } else {
        showToast(res.message, 'error');
      }
    } catch (err: any) {
      showToast(`Lỗi kiểm tra key: ${err.message || String(err)}`, 'error');
    } finally {
      setIsTestingApiKey(false);
    }
  };

  const handleTestExistingApiKey = async () => {
    const keyToTest = getGeminiApiKey();
    if (!keyToTest) {
      showToast('Chưa có API Key nào được khai báo!', 'warning');
      return;
    }
    setIsTestingApiKey(true);
    try {
      const res = await testGeminiApiKey(keyToTest);
      if (res.success) {
        showToast('✅ Google Gemini API Key đang hoạt động rất tốt!', 'success');
      } else {
        showToast(res.message, 'error');
      }
    } catch (err: any) {
      showToast(`Lỗi kiểm tra key: ${err.message || String(err)}`, 'error');
    } finally {
      setIsTestingApiKey(false);
    }
  };

  // 2. Lưu Link Google Sheet
  const handleSaveSheetUrl = async () => {
    const finalSheet = targetFileUrl.trim();
    if (!finalSheet) {
      showToast('Vui lòng dán link file Google Sheet!', 'warning');
      return;
    }

    setIsSyncingDrive(true);
    try {
      const match = finalSheet.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (!match || !match[1]) {
        throw new Error('Link Google Sheet không đúng định dạng (/d/SHEET_ID/edit)');
      }

      // Đọc Google Sheet qua smartDriveFetch
      const csvUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/gviz/tq?tqx=out:csv`;
      const csvResp = await smartDriveFetch(csvUrl);
      if (!csvResp.ok) {
        throw new Error(`Không tải được Google Sheet (HTTP ${csvResp.status})`);
      }
      const text = await csvResp.text();
      if (text.includes('<!DOCTYPE html>') || text.includes('<html>')) {
        throw new Error('Chưa thể đọc sheet: Vui lòng mở quyền Chia sẻ của Sheet sang "Bất kỳ ai có liên kết (Viewer)"');
      }

      const parsed = parseGoogleSheetCsvText(text);

      setStoredSheetUrl(finalSheet);
      setTargetFileUrl('');
      localStorage.setItem('drive_target_file_url_v1', finalSheet);

      if (onSaveConfig) {
        onSaveConfig(finalSheet, storedScriptUrl);
      }
      showToast(`✅ Đã lưu link Google Sheet (${parsed.length} cuốn)!`, 'success');
    } catch (err: any) {
      showToast(`❌ Lỗi: ${err.message || String(err)}`, 'error');
    } finally {
      setIsSyncingDrive(false);
    }
  };

  // 3. Lưu URL Apps Script Endpoint
  const handleSaveScriptUrl = async () => {
    const raw = scriptUrlInput.trim();
    if (!raw) {
      showToast('Vui lòng dán URL Apps Script Web App!', 'warning');
      return;
    }

    const cleanScript = sanitizeAppsScriptUrl(raw);
    if (!cleanScript.includes('script.google.com/macros/')) {
      showToast('URL Apps Script không đúng định dạng (/macros/s/.../exec)', 'warning');
      return;
    }

    setIsSyncingDrive(true);
    try {
      let testUrl = cleanScript;
      if (storedSheetUrl.trim()) {
        testUrl += (testUrl.includes('?') ? '&' : '?') + `fileUrl=${encodeURIComponent(storedSheetUrl.trim())}`;
      }
      const res = await smartDriveFetch(testUrl);
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.status === 'success') {
        setStoredScriptUrl(cleanScript);
        setScriptUrlInput('');
        localStorage.setItem('drive_sync_url_v1', cleanScript);

        if (onSaveConfig) {
          onSaveConfig(storedSheetUrl, cleanScript);
        }
        showToast(`✅ Kết nối 2 chiều Apps Script thành công (${data.count || 0} cuốn)!`, 'success');
      } else {
        throw new Error(data.message || `Lỗi từ Apps Script (HTTP ${res.status})`);
      }
    } catch (err: any) {
      showToast(`❌ Lỗi kết nối Apps Script: ${err.message || String(err)}`, 'error');
    } finally {
      setIsSyncingDrive(false);
    }
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
      const match = effectiveSheet.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        try {
          const csvUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/gviz/tq?tqx=out:csv`;
          const csvResp = await smartDriveFetch(csvUrl);
          if (csvResp.ok) {
            const text = await csvResp.text();
            if (text && !text.includes('<!DOCTYPE html>') && !text.includes('<html>')) {
              const parsed = parseGoogleSheetCsvText(text);
              successMessages.push(`✅ Đọc Google Sheet OK (${parsed.length} cuốn)`);
            }
          }
        } catch (e) {}
      }
    }

    // 2. Kiểm tra Google Apps Script Endpoint (nếu có cấu hình)
    if (effectiveScript.trim()) {
      const cleanUrl = sanitizeAppsScriptUrl(effectiveScript);
      
      if (cleanUrl.includes('docs.google.com/spreadsheets')) {
        successMessages.push(`❌ Lỗi: Bạn đang dán nhầm Link Google Sheet vào ô URL Apps Script!`);
      } else if (!cleanUrl.includes('script.google.com/macros/')) {
        successMessages.push(`❌ Lỗi: Link Apps Script không đúng định dạng Web App`);
      } else {
        try {
          let testUrl = cleanUrl;
          if (effectiveSheet.trim()) {
            testUrl += (testUrl.includes('?') ? '&' : '?') + `fileUrl=${encodeURIComponent(effectiveSheet.trim())}`;
          }
          const res = await smartDriveFetch(testUrl);
          if (!res.ok) {
            throw new Error(`Google Apps Script trả về HTTP ${res.status}`);
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

    if (!effectiveScript.trim() || effectiveScript.includes('AKfyczt126a5BfMe-0o8')) {
      showToast('Để đẩy ngược dữ liệu lên Sheet, vui lòng cấu hình URL Apps Script Web App riêng của bạn.', 'warning');
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
        `Đã kéo ${res.books.length} cuốn từ Sheet về. Thêm mới ${addedCount} cuốn (Bỏ qua ${skippedCount} cuốn trùng)!`,
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

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-3.5 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div 
        className="bg-white rounded-3xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
              <HardDrive className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 leading-tight">Đồng Bộ &amp; Sao Lưu</h3>
              <p className="text-[10px] text-slate-500">Quản lý kho sách &amp; Cloud</p>
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

        {/* Tabs */}
        <div className="flex border-b border-slate-100 px-4 pt-2 gap-4 text-xs font-semibold">
          <button
            onClick={() => setActiveTab('export')}
            className={`pb-2 border-b-2 transition ${
              activeTab === 'export'
                ? 'border-emerald-600 text-emerald-700 font-bold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Sao Lưu
          </button>
          <button
            onClick={() => setActiveTab('import')}
            className={`pb-2 border-b-2 transition ${
              activeTab === 'import'
                ? 'border-emerald-600 text-emerald-700 font-bold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Khôi Phục
          </button>
          <button
            onClick={() => setActiveTab('drive')}
            className={`pb-2 border-b-2 transition ${
              activeTab === 'drive'
                ? 'border-emerald-600 text-emerald-700 font-bold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Đồng Bộ Cloud
          </button>
        </div>

        {/* Tab Body */}
        <div className="p-4 overflow-y-auto space-y-3 flex-1">
          {/* TAB 1: SAO LƯU */}
          {activeTab === 'export' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between px-3 py-2 bg-emerald-50 rounded-xl text-xs text-emerald-900 font-medium">
                <span>Bộ nhớ máy:</span>
                <span className="font-bold">{books.length} cuốn sách</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  onClick={handleDownloadJson}
                  className="flex items-center gap-3 p-3 bg-slate-50 hover:bg-emerald-50/50 active:scale-[0.99] border border-slate-200 hover:border-emerald-200 rounded-xl text-xs font-bold text-slate-800 transition text-left"
                >
                  <div className="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div>
                    <div>Xuất file JSON</div>
                    <div className="text-[10px] text-slate-400 font-normal">Sao lưu trọn vẹn</div>
                  </div>
                </button>

                <button
                  onClick={() => {
                    exportBooksToExcel(books);
                    showToast('Đã tải xuống file Excel!', 'success');
                  }}
                  className="flex items-center gap-3 p-3 bg-slate-50 hover:bg-emerald-50/50 active:scale-[0.99] border border-slate-200 hover:border-emerald-200 rounded-xl text-xs font-bold text-slate-800 transition text-left"
                >
                  <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                    <FileSpreadsheet className="w-4 h-4" />
                  </div>
                  <div>
                    <div>Xuất file Excel (.xlsx)</div>
                    <div className="text-[10px] text-slate-400 font-normal">Xem trên máy tính</div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: KHÔI PHỤC */}
          {activeTab === 'import' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                <span className="font-medium text-slate-700">Chế độ:</span>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="importMode"
                      checked={importMode === 'append'}
                      onChange={() => setImportMode('append')}
                      className="text-emerald-600"
                    />
                    <span className="font-semibold text-slate-800">Gộp thêm</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="importMode"
                      checked={importMode === 'replace'}
                      onChange={() => setImportMode('replace')}
                      className="text-emerald-600"
                    />
                    <span className="text-rose-600 font-bold">Ghi đè sạch</span>
                  </label>
                </div>
              </div>

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
                className="w-full py-4 border-2 border-dashed border-slate-200 hover:border-emerald-500 rounded-2xl flex flex-col items-center justify-center text-slate-600 hover:text-emerald-700 hover:bg-emerald-50/20 transition group"
              >
                {isProcessing ? (
                  <Loader2 className="w-5 h-5 animate-spin text-emerald-600" />
                ) : (
                  <>
                    <Upload className="w-5 h-5 text-slate-400 group-hover:text-emerald-600 transition mb-1" />
                    <span className="text-xs font-bold">Chọn file JSON / Excel / CSV</span>
                  </>
                )}
              </button>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-slate-700 block">Hoặc dán chuỗi JSON:</label>
                <div className="relative">
                  <textarea
                    rows={2}
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    placeholder='[ { "title": "Tên Sách", "author": "Tác Giả" } ]'
                    className="w-full p-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-slate-400"
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

          {/* TAB 3: ĐỒNG BỘ CLOUD */}
          {activeTab === 'drive' && (
            <div className="space-y-3">
              {/* 1. Google Sheet */}
              <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200/90 space-y-2">
                <div className="flex items-center justify-between text-xs font-bold text-slate-800">
                  <span className="flex items-center gap-1.5 text-slate-900">
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                    Google Sheet
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-semibold">
                    <CheckCircle className="w-3 h-3 text-emerald-600" />
                    Đã khai báo thông tin
                  </span>
                </div>

                <input
                  type="text"
                  value={targetFileUrl}
                  onChange={(e) => setTargetFileUrl(e.target.value)}
                  placeholder="Dán link Sheet mới nếu muốn đổi..."
                  className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-slate-400"
                />

                <div className="flex gap-2">
                  {targetFileUrl.trim() ? (
                    <>
                      <button
                        type="button"
                        onClick={handleSaveSheetUrl}
                        disabled={isSyncingDrive}
                        className="flex-1 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 disabled:opacity-40"
                      >
                        {isSyncingDrive ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                        <span>Cập nhật Link</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setTargetFileUrl('')}
                        className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-xs font-bold transition"
                      >
                        Hủy
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleTestConnection}
                      disabled={isSyncingDrive}
                      className="w-full py-1.5 bg-white hover:bg-slate-100 text-emerald-800 border border-slate-200 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 disabled:opacity-40"
                    >
                      {isSyncingDrive ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3 text-emerald-600" />}
                      <span>Kiểm tra kết nối Sheet</span>
                    </button>
                  )}
                </div>
              </div>

              {/* 2. Apps Script Endpoint */}
              <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200/90 space-y-2">
                <div className="flex items-center justify-between text-xs font-bold text-slate-800">
                  <span className="flex items-center gap-1.5 text-slate-900">
                    <Link2 className="w-3.5 h-3.5 text-indigo-600" />
                    Apps Script (Ghi 2 chiều)
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 text-[10px] font-semibold">
                    <CheckCircle className="w-3 h-3 text-indigo-600" />
                    Đã khai báo thông tin
                  </span>
                </div>

                <input
                  type="text"
                  value={scriptUrlInput}
                  onChange={(e) => setScriptUrlInput(e.target.value)}
                  placeholder="Dán endpoint mới nếu muốn đổi..."
                  className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-slate-400"
                />

                <div className="flex gap-2">
                  {scriptUrlInput.trim() ? (
                    <>
                      <button
                        type="button"
                        onClick={handleSaveScriptUrl}
                        disabled={isSyncingDrive}
                        className="flex-1 py-1.5 bg-indigo-700 hover:bg-indigo-800 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 disabled:opacity-40"
                      >
                        {isSyncingDrive ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                        <span>Cập nhật Endpoint</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleCopyScriptCode}
                        className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-semibold transition"
                      >
                        Mã Code
                      </button>
                      <button
                        type="button"
                        onClick={() => setScriptUrlInput('')}
                        className="px-2.5 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-xs font-bold transition"
                      >
                        Hủy
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={handleTestConnection}
                        disabled={isSyncingDrive}
                        className="flex-1 py-1.5 bg-white hover:bg-slate-100 text-indigo-800 border border-slate-200 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 disabled:opacity-40"
                      >
                        {isSyncingDrive ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3 text-indigo-600" />}
                        <span>Kiểm tra kết nối Endpoint</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleCopyScriptCode}
                        className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium transition"
                      >
                        Mã Code.gs
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* 3. Gemini AI API Key */}
              <div className="p-3 bg-purple-50/50 rounded-2xl border border-purple-200/70 space-y-2">
                <div className="flex items-center justify-between text-xs font-bold text-slate-800">
                  <span className="flex items-center gap-1.5 text-purple-950 font-bold">
                    <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                    Google Gemini API Key
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 text-[10px] font-semibold">
                    <CheckCircle className="w-3 h-3 text-purple-600" />
                    Đã khai báo thông tin
                  </span>
                </div>

                <input
                  type="text"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="Dán API Key mới nếu muốn đổi..."
                  className="w-full px-3 py-1.5 bg-white border border-purple-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-purple-500 placeholder:text-slate-400"
                />

                <div className="flex gap-2">
                  {apiKeyInput.trim() ? (
                    <>
                      <button
                        type="button"
                        onClick={handleSaveApiKey}
                        disabled={isTestingApiKey}
                        className="flex-1 py-1.5 bg-purple-700 hover:bg-purple-800 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 disabled:opacity-40"
                      >
                        {isTestingApiKey ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                        <span>Cập nhật Key</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setApiKeyInput('')}
                        className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-xs font-bold transition"
                      >
                        Hủy
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleTestExistingApiKey}
                      disabled={isTestingApiKey}
                      className="w-full py-1.5 bg-white hover:bg-purple-50 text-purple-900 border border-purple-200 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 disabled:opacity-40"
                    >
                      {isTestingApiKey ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 text-purple-600" />}
                      <span>Kiểm tra kết nối Gemini AI</span>
                    </button>
                  )}
                </div>
              </div>

              {/* 2 Nút thao tác Đồng bộ */}
              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  onClick={handlePullFromDrive}
                  disabled={isSyncingDrive || (!storedSheetUrl.trim() && !storedScriptUrl.trim())}
                  className="p-3 bg-sky-50 hover:bg-sky-100 active:scale-[0.99] border border-sky-200 rounded-2xl transition flex items-center gap-2.5 disabled:opacity-40 text-left shadow-2xs"
                >
                  {isSyncingDrive ? (
                    <Loader2 className="w-5 h-5 animate-spin text-sky-600 shrink-0" />
                  ) : (
                    <Download className="w-5 h-5 text-sky-600 shrink-0" />
                  )}
                  <div>
                    <div className="text-xs font-bold text-sky-950">Kéo Sách Về</div>
                    <div className="text-[10px] text-sky-700">Tải từ Google Sheet</div>
                  </div>
                </button>

                <button
                  onClick={handlePushToDrive}
                  disabled={isSyncingDrive || !storedScriptUrl.trim() || storedScriptUrl.includes('AKfyczt126a5BfMe-0o8')}
                  className="p-3 bg-emerald-50 hover:bg-emerald-100 active:scale-[0.99] border border-emerald-200 rounded-2xl transition flex items-center gap-2.5 disabled:opacity-40 text-left shadow-2xs"
                >
                  {isSyncingDrive ? (
                    <Loader2 className="w-5 h-5 animate-spin text-emerald-600 shrink-0" />
                  ) : (
                    <Upload className="w-5 h-5 text-emerald-600 shrink-0" />
                  )}
                  <div>
                    <div className="text-xs font-bold text-emerald-950">Đẩy Sách Lên</div>
                    <div className="text-[10px] text-emerald-700">Lưu lên Google Sheet</div>
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-6 py-2 bg-slate-200 hover:bg-slate-300 active:scale-95 text-slate-700 rounded-xl text-xs font-bold transition"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
