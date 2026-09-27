import React, { useState, useRef } from 'react';
import { 
  X, Upload, FileText, FileSpreadsheet, HardDrive, Download, AlertCircle, CheckCircle, 
  Loader2, ChevronDown, ChevronUp, Link2, Eye, EyeOff, Key, Copy, Check, Edit3, Trash2, 
  Sparkles, RefreshCw, Database, ShieldCheck, CheckCheck
} from 'lucide-react';
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

  // URL States
  const [storedScriptUrl, setStoredScriptUrl] = useState(() => driveSyncUrl || getStoredOrConfiguredScriptUrl());
  const [storedSheetUrl, setStoredSheetUrl] = useState(() => driveTargetFileUrl || getStoredOrConfiguredSheetUrl());
  const [scriptUrlInput, setScriptUrlInput] = useState('');
  const [targetFileUrl, setTargetFileUrl] = useState('');
  const [isSyncingDrive, setIsSyncingDrive] = useState(false);

  // Xem / Ẩn Link & Endpoint
  const [showSheetUrl, setShowSheetUrl] = useState(false);
  const [showScriptUrl, setShowScriptUrl] = useState(false);
  const [showStoredSheetUrl, setShowStoredSheetUrl] = useState(false);
  const [showStoredScriptUrl, setShowStoredScriptUrl] = useState(false);

  // Chế độ chỉnh sửa Sheet & Script
  const [isEditingSheetUrl, setIsEditingSheetUrl] = useState(() => {
    const url = driveTargetFileUrl || getStoredOrConfiguredSheetUrl();
    return !url || url.includes('1WmvnebrW2NwMAc5r');
  });
  const [isEditingScriptUrl, setIsEditingScriptUrl] = useState(() => {
    const url = driveSyncUrl || getStoredOrConfiguredScriptUrl();
    return !url || url.includes('AKfyczt126a5BfMe-0o8');
  });

  // Gemini API Key States
  const [storedApiKey, setStoredApiKey] = useState(() => getCustomGeminiApiKey());
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [showStoredApiKey, setShowStoredApiKey] = useState(false);
  const [isTestingApiKey, setIsTestingApiKey] = useState(false);
  const [isEditingApiKey, setIsEditingApiKey] = useState(() => !getCustomGeminiApiKey());

  // Copy feedback state
  const [copiedField, setCopiedField] = useState<'sheet' | 'script' | 'key' | null>(null);

  const isUsingDummyScript = (scriptUrlInput.trim() || storedScriptUrl).includes('AKfyczt126a5BfMe-0o8') || !(scriptUrlInput.trim() || storedScriptUrl).trim();
  const isCustomSheet = !!localStorage.getItem('drive_target_file_url_v1') && !storedSheetUrl.includes('1WmvnebrW2NwMAc5r');
  const isCustomScript = !!localStorage.getItem('drive_sync_url_v1') && !storedScriptUrl.includes('AKfyczt126a5BfMe-0o8');

  const [logs, setLogs] = useState<SyncLogEntry[]>([]);

  React.useEffect(() => {
    if (isOpen) {
      setLogs(getSyncLogs());
      setStoredApiKey(getCustomGeminiApiKey());
      const interval = setInterval(() => {
        setLogs(getSyncLogs());
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [isOpen]);

  // Sync stored URLs with configuration/props
  React.useEffect(() => {
    const sheet = driveTargetFileUrl || getStoredOrConfiguredSheetUrl();
    const script = driveSyncUrl || getStoredOrConfiguredScriptUrl();
    setStoredSheetUrl(sheet);
    setStoredScriptUrl(script);
    setIsEditingSheetUrl(!sheet || sheet.includes('1WmvnebrW2NwMAc5r'));
    setIsEditingScriptUrl(!script || script.includes('AKfyczt126a5BfMe-0o8'));
    setStoredApiKey(getCustomGeminiApiKey());
    setIsEditingApiKey(!getCustomGeminiApiKey());
  }, [driveSyncUrl, driveTargetFileUrl, isOpen]);

  const copyToClipboard = (text: string, field: 'sheet' | 'script' | 'key') => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    showToast('Đã sao chép vào bộ nhớ đệm!', 'success');
    setTimeout(() => {
      setCopiedField(null);
    }, 2000);
  };

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
        setIsEditingApiKey(false);
        setShowApiKey(false);
        setShowStoredApiKey(false);
        showToast('✅ Đã kiểm tra thành công! Gemini API Key đã được lưu an toàn vào bộ nhớ máy.', 'success');
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

  const handleClearApiKey = () => {
    clearCustomGeminiApiKey();
    setStoredApiKey('');
    setApiKeyInput('');
    setIsEditingApiKey(true);
    showToast('Đã xóa Gemini API Key khỏi thiết bị!', 'info');
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

      // Thử đọc qua proxy
      const proxyUrl = getProxyUrl(`https://docs.google.com/spreadsheets/d/${match[1]}/gviz/tq?tqx=out:csv`);
      const csvResp = await fetch(proxyUrl);
      if (!csvResp.ok) {
        throw new Error(`Server không tải được Google Sheet (HTTP ${csvResp.status})`);
      }
      const text = await csvResp.text();
      if (text.includes('<!DOCTYPE html>') || text.includes('<html>')) {
        throw new Error('Chưa thể đọc sheet: Vui lòng mở quyền Chia sẻ của Sheet sang "Bất kỳ ai có liên kết (Viewer)"');
      }

      const parsed = parseGoogleSheetCsvText(text);

      setStoredSheetUrl(finalSheet);
      setTargetFileUrl('');
      setIsEditingSheetUrl(false);
      setShowStoredSheetUrl(false);
      localStorage.setItem('drive_target_file_url_v1', finalSheet);

      if (onSaveConfig) {
        onSaveConfig(finalSheet, storedScriptUrl);
      }
      showToast(`✅ Kiểm tra thành công (${parsed.length} cuốn sách)! Đã lưu link Google Sheet an toàn trên máy.`, 'success');
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
      const proxyUrl = getProxyUrl(testUrl);
      const res = await fetch(proxyUrl);
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.status === 'success') {
        setStoredScriptUrl(cleanScript);
        setScriptUrlInput('');
        setIsEditingScriptUrl(false);
        setShowStoredScriptUrl(false);
        localStorage.setItem('drive_sync_url_v1', cleanScript);

        if (onSaveConfig) {
          onSaveConfig(storedSheetUrl, cleanScript);
        }
        showToast(`✅ Kết nối 2 chiều Apps Script thành công (${data.count || 0} cuốn)! Đã lưu endpoint an toàn trên máy.`, 'success');
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

    if (!effectiveScript.trim() || effectiveScript.includes('AKfyczt126a5BfMe-0o8')) {
      showToast('Để đẩy ngược dữ liệu lên Sheet, vui lòng cấu hình URL Apps Script Web App riêng của bạn.', 'warning');
      setIsEditingScriptUrl(true);
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
              {/* Card Giải Thích Vị Trí Lưu Trữ Minh Bạch & Bảo Mật */}
              <div className="p-3 bg-gradient-to-r from-sky-50 to-indigo-50/60 rounded-2xl border border-sky-100/80 text-[11px] text-slate-800 flex items-start gap-3 shadow-xs">
                <div className="w-8 h-8 rounded-xl bg-sky-500 text-white flex items-center justify-center shrink-0 mt-0.5 shadow-xs">
                  <Database className="w-4 h-4" />
                </div>
                <div className="space-y-1">
                  <div className="font-extrabold text-sky-950 flex items-center gap-1.5">
                    <span>Hệ Thống Đã Được Cấu Hình Sẵn &amp; Bảo Mật Tuyệt Đối</span>
                    <span className="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 text-[9px] font-bold">An Toàn</span>
                  </div>
                  <p className="text-[10px] text-slate-600 leading-relaxed">
                    Các thông tin (Link Sheet, Apps Script Endpoint, Gemini API Key) đã được mã hóa an toàn sẵn trong bộ cài ứng dụng. Để bảo mật tuyệt đối, các ô nhập đều được <strong>xóa trắng</strong> và gắn nhãn <strong>&ldquo;Đã khai báo thông tin&rdquo;</strong> (không hiển thị link gốc hay dãy chấm che). Bạn hoàn toàn có thể nhập đè thông tin mới bất kỳ lúc nào nếu muốn thay đổi.
                  </p>
                </div>
              </div>

              {/* 1. Ô CẤU HÌNH LINK FILE GOOGLE SHEET */}
              <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200/90 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] font-bold text-slate-800">
                  <span className="flex items-center gap-1.5 text-slate-900">
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                    Link File Google Sheet:
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 text-[9px] font-black">
                    <CheckCircle className="w-2.5 h-2.5 text-emerald-600" />
                    Đã khai báo thông tin
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="relative flex items-center">
                    <input
                      type="text"
                      value={targetFileUrl}
                      onChange={(e) => setTargetFileUrl(e.target.value)}
                      placeholder="🔒 Đã khai báo thông tin. Nhập link mới tại đây nếu muốn thay đổi..."
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10.5px] font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-emerald-800/60 placeholder:font-sans placeholder:font-medium shadow-2xs"
                    />
                  </div>

                  <div className="flex gap-2">
                    {targetFileUrl.trim() ? (
                      <>
                        <button
                          type="button"
                          onClick={handleSaveSheetUrl}
                          disabled={isSyncingDrive}
                          className="flex-1 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-[10px] font-bold transition flex items-center justify-center gap-1 disabled:opacity-40"
                        >
                          {isSyncingDrive ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                          <span>Kiểm tra &amp; Cập nhật Link Mới</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setTargetFileUrl('')}
                          className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-[10px] font-bold transition"
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
                          className="flex-1 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-lg text-[10px] font-bold transition flex items-center justify-center gap-1 disabled:opacity-40"
                        >
                          {isSyncingDrive ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3 text-emerald-600" />}
                          <span>Kiểm tra kết nối Sheet</span>
                        </button>
                        {isCustomSheet && (
                          <button
                            type="button"
                            onClick={() => {
                              localStorage.removeItem('drive_target_file_url_v1');
                              setStoredSheetUrl(getStoredOrConfiguredSheetUrl());
                              showToast('Đã khôi phục Link Sheet về mặc định của bộ cài APK!', 'info');
                            }}
                            className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-[9.5px] font-bold transition"
                          >
                            Khôi phục mặc định
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* 2. Ô CẤU HÌNH GOOGLE APPS SCRIPT ENDPOINT (ĐỒNG BỘ 2 CHIỀU) */}
              <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200/90 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] font-bold text-slate-800">
                  <span className="flex items-center gap-1.5 text-slate-900">
                    <Link2 className="w-3.5 h-3.5 text-indigo-600" />
                    URL Apps Script Endpoint (Ghi 2 chiều):
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 border border-indigo-200 text-[9px] font-black">
                    <CheckCircle className="w-2.5 h-2.5 text-indigo-600" />
                    Đã khai báo thông tin
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="relative flex items-center">
                    <input
                      type="text"
                      value={scriptUrlInput}
                      onChange={(e) => setScriptUrlInput(e.target.value)}
                      placeholder="🔒 Đã khai báo thông tin. Nhập endpoint mới tại đây nếu muốn thay đổi..."
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10.5px] font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-indigo-800/60 placeholder:font-sans placeholder:font-medium shadow-2xs"
                    />
                  </div>

                  <div className="flex gap-2">
                    {scriptUrlInput.trim() ? (
                      <>
                        <button
                          type="button"
                          onClick={handleSaveScriptUrl}
                          disabled={isSyncingDrive}
                          className="flex-1 py-1.5 bg-indigo-700 hover:bg-indigo-800 text-white rounded-lg text-[10px] font-bold transition flex items-center justify-center gap-1 disabled:opacity-40"
                        >
                          {isSyncingDrive ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                          <span>Kiểm tra &amp; Cập nhật Endpoint Mới</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleCopyScriptCode}
                          className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-[10px] font-bold transition whitespace-nowrap"
                        >
                          Mã Code
                        </button>
                        <button
                          type="button"
                          onClick={() => setScriptUrlInput('')}
                          className="px-2.5 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-[10px] font-bold transition"
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
                          className="flex-1 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 rounded-lg text-[10px] font-bold transition flex items-center justify-center gap-1 disabled:opacity-40"
                        >
                          {isSyncingDrive ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3 text-indigo-600" />}
                          <span>Kiểm tra kết nối Endpoint</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleCopyScriptCode}
                          className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[10px] font-bold transition"
                        >
                          Mã Code.gs
                        </button>
                        {isCustomScript && (
                          <button
                            type="button"
                            onClick={() => {
                              localStorage.removeItem('drive_sync_url_v1');
                              setStoredScriptUrl(getStoredOrConfiguredScriptUrl());
                              showToast('Đã khôi phục Endpoint về mặc định của bộ cài APK!', 'info');
                            }}
                            className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-[9.5px] font-bold transition"
                          >
                            Khôi phục mặc định
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* 3. Ô CẤU HÌNH GOOGLE GEMINI API KEY */}
              <div className="p-3.5 bg-purple-50/50 rounded-2xl border border-purple-200/80 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] font-bold text-slate-800">
                  <span className="flex items-center gap-1.5 text-purple-950 font-black">
                    <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                    Google Gemini API Key (Quét Bìa &amp; Chuẩn Hóa AI):
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 border border-purple-200 text-[9px] font-black">
                    <CheckCircle className="w-2.5 h-2.5 text-purple-600" />
                    Đã khai báo thông tin
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="relative flex items-center">
                    <input
                      type="text"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="🔒 Đã khai báo thông tin. Nhập API Key mới tại đây nếu muốn thay đổi..."
                      className="w-full px-3 py-2 bg-white border border-purple-200 rounded-xl text-[10.5px] font-mono focus:outline-none focus:ring-1 focus:ring-purple-500 placeholder:text-purple-800/60 placeholder:font-sans placeholder:font-medium shadow-2xs"
                    />
                  </div>

                  <div className="flex gap-2">
                    {apiKeyInput.trim() ? (
                      <>
                        <button
                          type="button"
                          onClick={handleSaveApiKey}
                          disabled={isTestingApiKey}
                          className="flex-1 py-1.5 bg-purple-700 hover:bg-purple-800 text-white rounded-lg text-[10px] font-bold transition flex items-center justify-center gap-1 disabled:opacity-40"
                        >
                          {isTestingApiKey ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                          <span>Kiểm tra &amp; Cập nhật Key Mới</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setApiKeyInput('')}
                          className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-[10px] font-bold transition"
                        >
                          Hủy
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={handleTestExistingApiKey}
                          disabled={isTestingApiKey}
                          className="flex-1 py-1.5 bg-purple-100 hover:bg-purple-200 text-purple-900 border border-purple-200 rounded-lg text-[10px] font-bold transition flex items-center justify-center gap-1 disabled:opacity-40"
                        >
                          {isTestingApiKey ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 text-purple-600" />}
                          <span>Kiểm tra kết nối Gemini AI</span>
                        </button>
                        {!!localStorage.getItem('custom_gemini_api_key') && (
                          <button
                            type="button"
                            onClick={() => {
                              clearCustomGeminiApiKey();
                              setStoredApiKey('');
                              showToast('Đã khôi phục API Key về mặc định của bộ cài APK!', 'info');
                            }}
                            className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-[9.5px] font-bold transition"
                          >
                            Khôi phục mặc định
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* 2 NÚT HÀNH ĐỘNG ĐẨY & KÉO DỮ LIỆU */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  onClick={handlePullFromDrive}
                  disabled={isSyncingDrive || (!storedSheetUrl.trim() && !storedScriptUrl.trim())}
                  className="p-3 bg-sky-50/70 hover:bg-sky-100 border border-sky-200 rounded-2xl transition flex items-center gap-2.5 disabled:opacity-40 text-left h-16 shadow-2xs"
                >
                  {isSyncingDrive ? (
                    <Loader2 className="w-5 h-5 animate-spin text-sky-600 shrink-0" />
                  ) : (
                    <Download className="w-5 h-5 text-sky-600 shrink-0" />
                  )}
                  <div>
                    <div className="text-[11px] font-extrabold text-sky-950 leading-tight">Kéo Sách Về</div>
                    <div className="text-[9px] text-sky-700 font-normal mt-0.5 leading-normal">Tải từ Google Sheet về máy</div>
                  </div>
                </button>

                <button
                  onClick={handlePushToDrive}
                  disabled={isSyncingDrive || !storedScriptUrl.trim() || storedScriptUrl.includes('AKfyczt126a5BfMe-0o8')}
                  className="p-3 bg-emerald-50/70 hover:bg-emerald-100 border border-emerald-200 rounded-2xl transition flex items-center gap-2.5 disabled:opacity-40 text-left h-16 shadow-2xs"
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

              {/* PANEL DEBUG TẠM THỜI (TEMPORARY SYNC LOGS MONITOR) */}
              <div className="border-t border-slate-200 pt-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-slate-800 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping shrink-0" />
                    Bảng Giám Sát Đồng Bộ (Realtime Logs)
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
