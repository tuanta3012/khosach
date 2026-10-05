import React, { useState, useRef, useEffect } from 'react';
import { 
  X, Upload, FileSpreadsheet, Download, 
  Loader2, Sparkles, RefreshCw, AlertTriangle, 
  Trash2, Edit3, Check, CheckSquare, Square,
  Cloud, Plus, ExternalLink, Table, Eye, CheckCircle2, Link as LinkIcon,
  FolderOpen
} from 'lucide-react';
import { BookRecord } from '../types';
import { exportBooksToJson, exportBooksToExcel } from '../utils/backupService';
import { useToast } from '../context/ToastContext';
import { 
  importFromExcelBuffer, 
  importFromPdfBuffer,
  importFromGoogleSheetUrl,
  ImportScanResult, 
  ImportedBookItem,
  StagingBadgeType
} from '../utils/smartImporter';
import { getAccessToken, googleSignIn } from '../services/googleAuthService';
import { 
  fetchUserSpreadsheetsFromDrive,
  fetchAllUserSpreadsheets,
  fetchBooksFromGoogleSheet,
  deleteDriveSpreadsheet, 
  SpreadsheetInfo,
  checkSpreadsheetStatusOnDrive,
  removeKnownSpreadsheet,
  saveKnownSpreadsheet,
  tagSpreadsheetAsAppCreated
} from '../services/driveSyncService';

interface DataSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  books: BookRecord[];
  onImportBooks: (
    importedBooks: BookRecord[],
    replace: boolean
  ) => Promise<{ addedCount: number; skippedCount: number }>;
  userEmail?: string;
  appMode?: 'offline' | 'online';
  onSyncDriveNow?: () => Promise<void>;
  isSyncingDrive?: boolean;
  spreadsheetInfo?: SpreadsheetInfo | null;
  onSelectSpreadsheet?: (sheet: SpreadsheetInfo) => Promise<void>;
  onCreateSpreadsheet?: (customTitle: string) => Promise<SpreadsheetInfo>;
}

export const DataSyncModal: React.FC<DataSyncModalProps> = ({
  isOpen,
  onClose,
  books,
  onImportBooks,
  userEmail,
  appMode = 'offline',
  onSyncDriveNow,
  isSyncingDrive = false,
  spreadsheetInfo,
  onSelectSpreadsheet,
  onCreateSpreadsheet,
}) => {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [showSheetSelector, setShowSheetSelector] = useState(false);
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<string>(() => {
    return localStorage.getItem('last_drive_sync_time') || '';
  });

  // States danh sách Google Sheet từ Drive
  const [driveSheets, setDriveSheets] = useState<SpreadsheetInfo[]>([]);
  const [isLoadingSheets, setIsLoadingLoadingSheets] = useState(false);
  const [hasLoadedSheets, setHasLoadedSheets] = useState(false);
  const [newSheetTitle, setNewSheetTitle] = useState('Kho sach');
  const [isCreatingSheet, setIsCreatingSheet] = useState(false);
  const [deletingSheetId, setDeletingSheetId] = useState<string | null>(null);

  // States cho tính năng Nhập từ Drive (tách biệt hoàn toàn với danh sách liên kết)
  const [showDriveImportPicker, setShowDriveImportPicker] = useState(false);
  const [driveImportSheets, setDriveImportSheets] = useState<SpreadsheetInfo[]>([]);
  const [isLoadingImportSheets, setIsLoadingImportSheets] = useState(false);
  const [isImportingFromDrive, setIsImportingFromDrive] = useState<string | null>(null);

  const [sheetPendingDelete, setSheetPendingDelete] = useState<SpreadsheetInfo | null>(null);

  // Trạng thái Bảng Nháp (Staging Area)
  const [scanResult, setScanResult] = useState<ImportScanResult | null>(null);
  const [stagingItems, setStagingItems] = useState<ImportedBookItem[]>([]);
  const [stagingFilter, setStagingFilter] = useState<'all' | 'new' | 'duplicate' | 'alert'>('all');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ title: string; author: string; category: string; publisher: string }>({
    title: '',
    author: '',
    category: '',
    publisher: '',
  });

  // Tự động tải danh sách file Google Sheet khi mở modal
  useEffect(() => {
    if (isOpen && appMode === 'online' && !hasLoadedSheets) {
      handleLoadDriveSheets();
    }
  }, [isOpen, appMode]);

  // Khi mở modal, tự động kiểm tra tệp đang liên kết xem có còn tồn tại trên Drive không
  useEffect(() => {
    if (!isOpen || !spreadsheetInfo?.id || appMode !== 'online') return;

    let isCancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const status = await checkSpreadsheetStatusOnDrive(token, spreadsheetInfo.id);
        if (isCancelled) return;
        if (status.trashed || status.error === 'FILE_NOT_FOUND') {
          showToast(`⚠️ File "${spreadsheetInfo.name}" đã bị xóa trên Google Drive. Đã hủy liên kết!`, 'warning');
          setLastSyncTime('');
          localStorage.removeItem('last_drive_sync_time');
          localStorage.removeItem('library_spreadsheet_info_v2');
          removeKnownSpreadsheet(spreadsheetInfo.id);
          if (onSelectSpreadsheet) {
            await onSelectSpreadsheet(null as any);
          }
        }
      } catch (err) {
        console.warn('[DataSyncModal] verify current sheet error:', err);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [isOpen, spreadsheetInfo?.id, appMode]);

  // Đóng bảng nháp khi đóng modal (tự động xóa sạch danh sách nháp nếu thoát ra mà chưa lưu)
  const handleCloseModal = () => {
    setScanResult(null);
    setStagingItems([]);
    setShowSheetSelector(false);
    setSheetPendingDelete(null);
    onClose();
  };

  useEffect(() => {
    if (!isOpen) {
      setScanResult(null);
      setStagingItems([]);
      setShowSheetSelector(false);
      setSheetPendingDelete(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // 1. Quét danh sách file Google Sheet từ Drive
  const handleLoadDriveSheets = async () => {
    setIsLoadingLoadingSheets(true);
    try {
      let token = await getAccessToken();
      if (!token) {
        const res = await googleSignIn().catch(() => null);
        token = res?.accessToken || null;
      }
      const sheets = await fetchUserSpreadsheetsFromDrive(token || '');
      setDriveSheets(sheets);
      setHasLoadedSheets(true);
    } catch (err: any) {
      showToast(`Lỗi quét file Drive: ${err.message || String(err)}`, 'error');
    } finally {
      setIsLoadingLoadingSheets(false);
    }
  };

  // 1b. Mở xác nhận xóa file trên Google Drive
  const handleDeleteDriveSheet = (sheet: SpreadsheetInfo) => {
    setSheetPendingDelete(sheet);
  };

  // 1c. Thực hiện xóa file sau khi người dùng xác nhận trong UI
  const executeDeleteSheet = async (sheet: SpreadsheetInfo) => {
    const isLinked = spreadsheetInfo?.id === sheet.id;
    setDeletingSheetId(sheet.id);
    try {
      const token = await getAccessToken();
      if (!token) {
        showToast('Vui lòng đăng nhập tài khoản Google để xóa file.', 'warning');
        return;
      }
      await deleteDriveSpreadsheet(token, sheet.id);
      setDriveSheets((prev) => prev.filter((s) => s.id !== sheet.id));
      if (isLinked && onSelectSpreadsheet) {
        await onSelectSpreadsheet(null as any);
        setLastSyncTime('');
        localStorage.removeItem('last_drive_sync_time');
      }
      showToast(`Đã xóa file "${sheet.name}" khỏi Google Drive thành công!`, 'success');
      setSheetPendingDelete(null);
    } catch (err: any) {
      showToast(`Lỗi xóa file: ${err.message || String(err)}`, 'error');
    } finally {
      setDeletingSheetId(null);
    }
  };

  // 1d. Tải danh sách TẤT CẢ Google Sheet của user (cho picker Nhập từ Drive)
  const handleLoadDriveImportSheets = async () => {
    setIsLoadingImportSheets(true);
    try {
      let token = await getAccessToken();
      if (!token) {
        const res = await googleSignIn().catch(() => null);
        token = res?.accessToken || null;
      }
      // Dùng hàm riêng — không lọc appProperties, lấy mọi Spreadsheet user có quyền
      const sheets = await fetchAllUserSpreadsheets(token || '');
      setDriveImportSheets(sheets);
    } catch (err: any) {
      showToast(`Lỗi tải danh sách Drive: ${err.message || String(err)}`, 'error');
    } finally {
      setIsLoadingImportSheets(false);
    }
  };

  // 1e. Nhập từ Drive: user chọn 1 sheet → import vào staging area
  const handleImportFromDriveSheet = async (sheet: SpreadsheetInfo) => {
    setIsImportingFromDrive(sheet.id);
    setScanResult(null);
    try {
      let token = await getAccessToken();
      if (!token) {
        const res = await googleSignIn().catch(() => null);
        token = res?.accessToken || null;
      }
      const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheet.id}`;
      const result = await importFromGoogleSheetUrl(sheetUrl, token, books);
      setScanResult(result);
      setStagingItems(result.items);
      setShowDriveImportPicker(false);
      showToast(`Đã tải ${result.totalCount} dòng từ "${sheet.name}" vào bảng nháp!`, 'success');
    } catch (err: any) {
      showToast(`Lỗi nhập từ Drive: ${err.message || String(err)}`, 'error');
    } finally {
      setIsImportingFromDrive(null);
    }
  };

  // 2. Xử lý tải file Excel / CSV / PDF từ thiết bị
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setScanResult(null);
    try {
      const buffer = await file.arrayBuffer();
      const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
      const result = isPdf 
        ? await importFromPdfBuffer(buffer, books) 
        : await importFromExcelBuffer(buffer, books, file.name);
      setScanResult(result);
      setStagingItems(result.items);
    } catch (err: any) {
      showToast(`Lỗi đọc file: ${err.message || String(err)}`, 'error');
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // 3. Đồng bộ hai chiều với Google Drive
  const handleSyncNow = async () => {
    if (!onSyncDriveNow) return;
    if (!spreadsheetInfo || !spreadsheetInfo.id) {
      showToast('Chưa có file Google Sheet nào được liên kết. Vui lòng chọn hoặc tạo file trước!', 'warning');
      return;
    }
    setIsProcessing(true);
    try {
      // 1. Kiểm tra xác thực trạng thái thực tế của tệp trên Drive trước khi đồng bộ
      const token = await getAccessToken();
      if (token) {
        const status = await checkSpreadsheetStatusOnDrive(token, spreadsheetInfo.id);
        if (status.trashed || status.error === 'FILE_NOT_FOUND') {
          setLastSyncTime('');
          localStorage.removeItem('last_drive_sync_time');
          localStorage.removeItem('library_spreadsheet_info_v2');
          removeKnownSpreadsheet(spreadsheetInfo.id);
          if (onSelectSpreadsheet) {
            await onSelectSpreadsheet(null as any);
          }
          showToast(`⚠️ File "${spreadsheetInfo.name}" đã bị xóa trên Google Drive. Đã hủy liên kết!`, 'error');
          return;
        }
      }

      await onSyncDriveNow();
      const timeStr = new Date().toLocaleTimeString('vi-VN') + ' ' + new Date().toLocaleDateString('vi-VN');
      setLastSyncTime(timeStr);
      localStorage.setItem('last_drive_sync_time', timeStr);
      showToast('Đồng bộ dữ liệu thành công!', 'success');
    } catch (err: any) {
      showToast(`Đồng bộ thất bại: ${err.message || String(err)}`, 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // 4. Tạo file Google Sheet mới và tự động liên kết
  const handleCreateNewSheetForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = newSheetTitle.trim() || 'Kho Sách Cá Nhân';
    if (!onCreateSpreadsheet) return;
    setIsCreatingSheet(true);
    try {
      const newSheet = await onCreateSpreadsheet(cleanTitle);
      setNewSheetTitle('Kho Sách Cá Nhân');
      setShowCreateInput(false);
      await handleLoadDriveSheets();
      if (onSelectSpreadsheet) {
        await onSelectSpreadsheet(newSheet);
      }
      showToast(`Đã tạo và liên kết thành công bảng tính: ${newSheet.name}`, 'success');
    } catch (err: any) {
      showToast(`Lỗi tạo file mới: ${err.message || String(err)}`, 'error');
    } finally {
      setIsCreatingSheet(false);
    }
  };

  // Xóa / Chọn item trong Bảng Nháp
  const handleToggleSelectItem = (tempId: string) => {
    setStagingItems(prev =>
      prev.map(item => (item.tempId === tempId ? { ...item, selected: !item.selected } : item))
    );
  };

  const handleToggleSelectAll = () => {
    const allSelected = filteredItems.every(i => i.selected);
    const targetTempIds = new Set(filteredItems.map(i => i.tempId));
    setStagingItems(prev =>
      prev.map(item => (targetTempIds.has(item.tempId) ? { ...item, selected: !allSelected } : item))
    );
  };

  const handleDeleteStagingItem = (tempId: string) => {
    setStagingItems(prev => prev.filter(item => item.tempId !== tempId));
  };

  const handleStartEdit = (item: ImportedBookItem) => {
    setEditingItemId(item.tempId);
    setEditForm({
      title: item.title,
      author: item.author,
      category: item.category,
      publisher: item.publisher || '',
    });
  };

  const handleSaveEdit = (tempId: string) => {
    setStagingItems(prev =>
      prev.map(item =>
        item.tempId === tempId
          ? {
              ...item,
              title: editForm.title.trim() || item.title,
              author: editForm.author.trim() || item.author,
              category: editForm.category.trim() || item.category,
              publisher: editForm.publisher.trim(),
            }
          : item
      )
    );
    setEditingItemId(null);
  };

  const handleConfirmImport = async () => {
    const selectedItems = stagingItems.filter(i => i.selected);
    if (selectedItems.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 cuốn sách để lưu!', 'warning');
      return;
    }

    setIsProcessing(true);
    try {
      const recordsToSave: BookRecord[] = selectedItems.map((item, idx) => ({
        id: `imp_${Date.now()}_${idx}`,
        title: item.title,
        author: item.author,
        category: item.category,
        publisher: item.publisher,
        is_ai_normalized: item.is_ai_normalized || false,
        created_at: Date.now(),
        updated_at: Date.now(),
      }));

      const res = await onImportBooks(recordsToSave, false);
      showToast(`Thành công! Đã lưu ${res.addedCount} cuốn sách vào kho chính.`, 'success');
      setScanResult(null);
      setStagingItems([]);
      onClose();
    } catch (err: any) {
      showToast(`Lỗi lưu vào kho chính: ${err.message || String(err)}`, 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const filteredItems = stagingItems.filter(item => {
    if (stagingFilter === 'new') return item.badgeType === 'NEW';
    if (stagingFilter === 'duplicate') return item.badgeType === 'DUP';
    if (stagingFilter === 'alert') return item.badgeType === '!X' || item.badgeType === 'SUSPICIOUS';
    return true;
  });

  const selectedCount = stagingItems.filter(i => i.selected).length;
  const newCount = stagingItems.filter(i => i.badgeType === 'NEW').length;
  const duplicateCount = stagingItems.filter(i => i.badgeType === 'DUP').length;
  const alertCount = stagingItems.filter(i => i.badgeType === '!X' || i.badgeType === 'SUSPICIOUS').length;

  const renderBadge = (badgeType: StagingBadgeType, item: ImportedBookItem) => {
    switch (badgeType) {
      case '!X':
        return (
          <span 
            title={item.alertReason || 'Cảnh báo dữ liệu cần duyệt'}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-100 text-rose-800 border border-rose-300 shrink-0"
          >
            !X Cần duyệt
          </span>
        );
      case 'DUP':
        return (
          <span 
            title={item.alertReason || 'Trùng lặp với sách trong kho'}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 shrink-0"
          >
            Trùng ({item.confidence || 80}%)
          </span>
        );
      case 'SUSPICIOUS':
        return (
          <span 
            title={item.alertReason || 'Nghi vấn tương đồng'}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-300 shrink-0"
          >
            Gần giống
          </span>
        );
      case 'NEW':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-100 text-teal-800 border border-teal-300 shrink-0">
            Mới
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity"
        onClick={handleCloseModal}
      />

      <div className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[85vh]">
        
        {/* --- HEADER CHUẨN (Khớp ứng dụng mẫu - giữ tông màu Sienna chủ đạo) --- */}
        <div className="px-4 py-2.5 bg-[#2b170e] text-white flex items-center justify-between shrink-0 border-b border-[#452215]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#9e5628] text-white flex items-center justify-center shrink-0 shadow-sm">
              <Cloud className="w-4.5 h-4.5" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h2 className="text-xs sm:text-sm font-extrabold text-white leading-tight">
                  {showSheetSelector ? 'Chọn File Google Drive' : 'Đồng Bộ Google Drive'}
                </h2>
                <span className={`px-1.5 py-0.2 rounded text-[9px] font-black uppercase shrink-0 ${appMode === 'online' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'}`}>
                  {appMode === 'online' ? 'Online' : 'Offline'}
                </span>
              </div>
              <p className="text-[10px] text-amber-200/80 leading-tight">
                {appMode === 'online' ? (userEmail || 'Chưa liên kết email') : 'Lưu trữ cục bộ trên máy'}
              </p>
            </div>
          </div>
          <button
            onClick={handleCloseModal}
            className="p-1.5 rounded-full text-amber-200/80 hover:text-white hover:bg-[#381c12] active:scale-95 transition cursor-pointer"
            aria-label="Đóng"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-3 space-y-2.5 overflow-y-auto flex-1 bg-slate-50/50">
          
          {scanResult ? (
            /* --- BẢNG NHÁP (STAGING AREA) VIEW --- */
            <div className="space-y-2.5 animate-in fade-in duration-200">
              {/* Thanh lọc loại sách trong bảng nháp */}
              <div className="bg-white border border-slate-200/80 rounded-2xl p-2.5 shadow-2xs">
                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-xs scrollbar-none">
                  <button
                    onClick={() => setStagingFilter('all')}
                    className={`px-2.5 py-1 rounded-lg font-bold transition shrink-0 cursor-pointer ${
                      stagingFilter === 'all'
                        ? 'bg-[#9e5628] text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    Tất cả ({stagingItems.length})
                  </button>
                  <button
                    onClick={() => setStagingFilter('new')}
                    className={`px-2.5 py-1 rounded-lg font-bold transition shrink-0 cursor-pointer ${
                      stagingFilter === 'new'
                        ? 'bg-[#1b6b5b] text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    Sách mới ({newCount})
                  </button>
                  <button
                    onClick={() => setStagingFilter('duplicate')}
                    className={`px-2.5 py-1 rounded-lg font-bold transition shrink-0 cursor-pointer ${
                      stagingFilter === 'duplicate'
                        ? 'bg-amber-600 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    Sách trùng ({duplicateCount})
                  </button>
                  {alertCount > 0 && (
                    <button
                      onClick={() => setStagingFilter('alert')}
                      className={`px-2.5 py-1 rounded-lg font-bold transition shrink-0 cursor-pointer ${
                        stagingFilter === 'alert'
                          ? 'bg-rose-600 text-white'
                          : 'bg-rose-50 text-rose-700 hover:bg-rose-100'
                      }`}
                    >
                      ! Cần duyệt ({alertCount})
                    </button>
                  )}
                </div>
              </div>

              {/* Items List */}
              <div className="space-y-1.5 max-h-[44vh] overflow-y-auto pr-0.5">
                <div className="flex items-center justify-between px-1.5 text-[10px] text-slate-400 font-bold">
                  <button
                    onClick={handleToggleSelectAll}
                    className="flex items-center gap-1.5 hover:text-slate-600 transition cursor-pointer"
                  >
                    {filteredItems.every(i => i.selected) ? (
                      <CheckSquare className="w-3.5 h-3.5 text-[#9e5628]" />
                    ) : (
                      <Square className="w-3.5 h-3.5 text-slate-300" />
                    )}
                    <span>Chọn tất cả ({selectedCount})</span>
                  </button>
                  <span>Chạm bút chì để sửa nhanh</span>
                </div>

                {filteredItems.map(item => {
                  const isEditing = editingItemId === item.tempId;

                  if (isEditing) {
                    return (
                      <div key={item.tempId} className="bg-amber-50/50 border border-amber-200 rounded-2xl p-2.5 space-y-2">
                        <input
                          type="text"
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          data-lpignore="true"
                          value={editForm.title}
                          onChange={e => setEditForm({ ...editForm, title: e.target.value })}
                          placeholder="Tên sách"
                          className="w-full px-2 py-1.5 text-xs font-bold text-slate-900 bg-white border border-amber-300 rounded-xl focus:outline-none focus:ring-1 focus:ring-amber-500"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="text"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            data-lpignore="true"
                            value={editForm.author}
                            onChange={e => setEditForm({ ...editForm, author: e.target.value })}
                            placeholder="Tác giả"
                            className="px-2 py-1.5 text-xs text-slate-800 bg-white border border-amber-300 rounded-xl focus:outline-none"
                          />
                          <input
                            type="text"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            data-lpignore="true"
                            value={editForm.category}
                            onChange={e => setEditForm({ ...editForm, category: e.target.value })}
                            placeholder="Thể loại"
                            className="px-2 py-1.5 text-xs text-slate-800 bg-white border border-amber-300 rounded-xl focus:outline-none"
                          />
                        </div>
                        <div className="flex justify-end gap-1.5 pt-0.5">
                          <button
                            onClick={() => setEditingItemId(null)}
                            className="px-2.5 py-1 text-[10.5px] font-bold bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 cursor-pointer"
                          >
                            Hủy
                          </button>
                          <button
                            onClick={() => handleSaveEdit(item.tempId)}
                            className="px-2.5 py-1 text-[10.5px] font-bold bg-[#9e5628] text-white rounded-lg hover:bg-[#854720] cursor-pointer"
                          >
                            Lưu
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={item.tempId}
                      className={`p-2.5 rounded-xl border transition flex items-center justify-between gap-2 shadow-3xs ${
                        item.selected
                          ? 'bg-white border-slate-200'
                          : 'bg-slate-100/50 border-slate-200/60 opacity-60 hover:opacity-100'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <button
                          onClick={() => handleToggleSelectItem(item.tempId)}
                          className="shrink-0 cursor-pointer"
                        >
                          {item.selected ? (
                            <CheckSquare className="w-4 h-4 text-[#9e5628]" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-300" />
                          )}
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="font-bold text-xs text-slate-900 truncate">{item.title}</div>
                          <div className="text-[10px] text-slate-400 truncate">
                            {item.author || 'Chưa rõ'} • {item.category || 'Chung'}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {renderBadge(item.badgeType, item)}
                        <button
                          onClick={() => handleStartEdit(item)}
                          className="p-1 text-slate-400 hover:text-amber-600 transition cursor-pointer"
                        >
                          <Edit3 className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleDeleteStagingItem(item.tempId)}
                          className="p-1 text-slate-400 hover:text-rose-600 transition cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : showSheetSelector ? (
            /* ===================================================================
               MÀN HÌNH SUB-POPUP: CHỌN FILE GOOGLE DRIVE (Khớp 100% Ảnh số 3)
               =================================================================== */
            <div className="space-y-4 animate-in fade-in duration-200">
              
              {/* Nút Tạo bảng tính mới */}
              <div className="p-3.5 bg-white border border-slate-200/80 rounded-2xl shadow-2xs space-y-2.5">
                {showCreateInput ? (
                  <form onSubmit={handleCreateNewSheetForm} className="flex gap-2">
                    <input
                      type="text"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      data-lpignore="true"
                      value={newSheetTitle}
                      onChange={e => setNewSheetTitle(e.target.value)}
                      placeholder="Nhập tên bảng tính..."
                      className="flex-1 px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:border-[#9e5628]"
                    />
                    <button
                      type="submit"
                      disabled={isCreatingSheet || !newSheetTitle.trim()}
                      className="px-3.5 py-1.5 bg-[#1b6b5b] hover:bg-[#165b4c] text-white font-bold text-xs rounded-xl shadow-xs transition flex items-center gap-1 disabled:opacity-50 shrink-0 cursor-pointer"
                    >
                      {isCreatingSheet ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                      <span>Tạo</span>
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowCreateInput(true)}
                    className="w-full py-2 bg-[#1b6b5b] hover:bg-[#145d4b] text-white font-bold text-xs rounded-xl shadow-xs transition flex items-center justify-center gap-2 active:scale-95 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Tạo bảng tính mới trên Drive</span>
                  </button>
                )}
              </div>

              {/* Danh sách File Google Sheet khả dụng */}
              <div className="bg-white border border-slate-200/80 rounded-2xl p-3.5 shadow-2xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <span className="text-xs font-black text-slate-800">
                    File khả dụng ({driveSheets.length}):
                  </span>
                  <button
                    type="button"
                    onClick={handleLoadDriveSheets}
                    disabled={isLoadingSheets}
                    className="text-[10.5px] font-bold text-[#1b6b5b] hover:underline flex items-center gap-1"
                  >
                    <RefreshCw className={`w-2.5 h-2.5 ${isLoadingSheets ? 'animate-spin' : ''}`} />
                    <span>Làm mới</span>
                  </button>
                </div>

                {isLoadingSheets ? (
                  <div className="p-6 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-[#1b6b5b]" />
                    <span>Đang duyệt tìm tệp...</span>
                  </div>
                ) : driveSheets.length > 0 ? (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                    {driveSheets.map(sheet => {
                      const isLinked = spreadsheetInfo?.id === sheet.id;
                      return (
                        <div
                          key={sheet.id}
                          className={`p-2.5 rounded-xl border flex items-center justify-between gap-3 text-xs transition ${
                            isLinked
                              ? 'bg-emerald-50/70 border-emerald-200 shadow-3xs'
                              : 'bg-slate-50/70 border-slate-100 hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className="p-1 bg-[#1b6b5b]/10 text-[#1b6b5b] rounded-lg">
                              <FileSpreadsheet className="w-3.5 h-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <span className="font-bold text-slate-800 block truncate text-xs">{sheet.name}</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {isLinked ? (
                              <span className="px-2 py-1 bg-emerald-600 text-white text-[10px] font-bold rounded-lg shrink-0 flex items-center gap-1 shadow-3xs">
                                <Check className="w-3 h-3 stroke-[3]" />
                                <span>Liên kết</span>
                              </span>
                            ) : (
                              onSelectSpreadsheet && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    await onSelectSpreadsheet(sheet);
                                    setShowSheetSelector(false);
                                  }}
                                  className="px-2.5 py-1.5 bg-[#9e5628] hover:bg-[#85451e] text-white font-bold text-[10.5px] rounded-lg transition shrink-0 cursor-pointer shadow-3xs active:scale-95"
                                >
                                  Liên kết
                                </button>
                              )
                            )}

                            <button
                              type="button"
                              onClick={() => handleDeleteDriveSheet(sheet)}
                              disabled={deletingSheetId === sheet.id}
                              title={`Xóa file "${sheet.name}" khỏi Google Drive`}
                              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition active:scale-95 cursor-pointer disabled:opacity-50"
                            >
                              {deletingSheetId === sheet.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-600" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-4 text-center text-xs text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                    Chưa có tệp Google Sheet phù hợp. Hãy tạo mới một bảng tính!
                  </div>
                )}

                {/* Hộp thoại xác nhận xóa file Google Sheet */}
                {sheetPendingDelete && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl space-y-2 animate-in fade-in duration-150">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-bold text-rose-950 leading-tight">
                          Xóa file "{sheetPendingDelete.name}" khỏi Google Drive?
                        </p>
                        <p className="text-[10px] text-rose-700 leading-normal mt-0.5">
                          {spreadsheetInfo?.id === sheetPendingDelete.id
                            ? 'Đây là file đang liên kết! Xóa file sẽ đồng thời hủy liên kết khỏi ứng dụng.'
                            : 'Tệp tin này sẽ bị xóa vĩnh viễn khỏi tài khoản Google Drive của bạn.'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 pt-0.5">
                      <button
                        type="button"
                        onClick={() => executeDeleteSheet(sheetPendingDelete)}
                        disabled={deletingSheetId === sheetPendingDelete.id}
                        className="flex-1 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-lg transition active:scale-95 cursor-pointer shadow-3xs flex items-center justify-center gap-1.5"
                      >
                        {deletingSheetId === sheetPendingDelete.id ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Đang xóa...</span>
                          </>
                        ) : (
                          <>
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Xác nhận xóa</span>
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSheetPendingDelete(null)}
                        disabled={!!deletingSheetId}
                        className="flex-1 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold rounded-lg transition active:scale-95 cursor-pointer"
                      >
                        Hủy bỏ
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Nút Quay lại */}
              <button
                type="button"
                onClick={() => {
                  setSheetPendingDelete(null);
                  setShowSheetSelector(false);
                }}
                className="w-full py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold rounded-xl transition cursor-pointer"
              >
                Quay lại bảng đồng bộ
              </button>
            </div>
          ) : (
            /* ===================================================================
               MÀN HÌNH CHÍNH CHUẨN (Khớp 100% Ảnh số 2 - Tự động thích ứng màu Sienna)
               =================================================================== */
            <div className="space-y-2.5 animate-in fade-in duration-200">
              
              {/* PHÂN KHU 1: ĐỒNG BỘ GOOGLE SHEET (Chỉ hiển thị khi Online) */}
              {appMode === 'online' ? (
                <div className="bg-white border border-slate-200/80 rounded-2xl p-3 shadow-2xs space-y-2.5">
                  
                  {/* Top Row: Icon + Sheet Name + Đồng bộ button */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className="p-1.5 bg-teal-50 border border-teal-100 rounded-xl text-[#1b6b5b] shrink-0">
                        <FileSpreadsheet className="w-4.5 h-4.5" />
                      </div>
                      <span className="text-xs sm:text-sm font-black text-slate-900 truncate">
                        {spreadsheetInfo ? spreadsheetInfo.name : 'Chưa liên kết'}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {onSyncDriveNow && (
                        <button
                          type="button"
                          onClick={handleSyncNow}
                          disabled={isSyncingDrive || isProcessing}
                          className="px-2.5 py-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 font-bold text-xs rounded-xl shadow-3xs transition flex items-center gap-1 active:scale-95 cursor-pointer"
                        >
                          {isSyncingDrive || isProcessing ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
                          )}
                          <span>Đồng bộ</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Middle Row: Sync status & Last update timestamp */}
                  <div className="flex items-center justify-between text-[11px] pt-0.5">
                    {spreadsheetInfo ? (
                      <div className="flex items-center gap-1 text-[#1b6b5b] font-bold">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        <span>Đồng bộ 2 chiều</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 text-amber-600 font-semibold">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                        <span>Chưa liên kết file</span>
                      </div>
                    )}

                    <span className="text-[10px] text-slate-500 font-mono">
                      {spreadsheetInfo && lastSyncTime ? `Cập nhật: ${lastSyncTime}` : 'Chưa đồng bộ'}
                    </span>
                  </div>

                  {/* Bottom Row: Đổi file / Hủy liên kết buttons */}
                  <div className="pt-2 border-t border-slate-100 space-y-2">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          handleLoadDriveSheets();
                          setShowSheetSelector(true);
                        }}
                        className="flex-1 py-1.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-bold rounded-xl transition flex items-center justify-center gap-1.5 cursor-pointer active:scale-95"
                      >
                        <ExternalLink className="w-3.5 h-3.5 text-slate-500 rotate-45" />
                        <span className="truncate">Tạo, đổi file liên kết</span>
                      </button>
                      {spreadsheetInfo && onSelectSpreadsheet && (
                        <button
                          type="button"
                          onClick={() => setShowUnlinkConfirm(true)}
                          className="flex-1 py-1.5 bg-white hover:bg-rose-50 border border-rose-200 text-rose-600 text-xs font-bold rounded-xl transition flex items-center justify-center gap-1.5 cursor-pointer active:scale-95"
                        >
                          <RefreshCw className="w-3.5 h-3.5 text-rose-500 rotate-45" />
                          <span>Hủy liên kết</span>
                        </button>
                      )}
                    </div>

                    {showUnlinkConfirm && (
                      <div className="p-2.5 bg-rose-50/80 border border-rose-100 rounded-xl space-y-2 animate-in fade-in duration-150">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-xs font-bold text-rose-950 leading-tight">
                              Xác nhận hủy liên kết với file Sheet?
                            </p>
                            <p className="text-[9.5px] text-rose-700 leading-normal mt-0.5">
                              Tệp tin trên Google Drive vẫn được giữ an toàn tuyệt đối.
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={async () => {
                              setShowUnlinkConfirm(false);
                              setLastSyncTime('');
                              localStorage.removeItem('last_drive_sync_time');
                              if (onSelectSpreadsheet) {
                                await onSelectSpreadsheet(null as any);
                              }
                              showToast('Đã hủy liên kết Google Sheet thành công.', 'info');
                            }}
                            className="flex-1 py-1 bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-extrabold rounded-lg transition active:scale-95 cursor-pointer shadow-3xs"
                          >
                            Xác nhận hủy
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowUnlinkConfirm(false)}
                            className="flex-1 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 text-[11px] font-bold rounded-lg transition active:scale-95 cursor-pointer"
                          >
                            Hủy bỏ
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* GỢI Ý ĐỒNG BỘ CHO CHẾ ĐỘ OFFLINE */
                <div className="bg-amber-50/50 border border-amber-200/60 rounded-2xl p-3 text-center space-y-1.5">
                  <p className="text-[11px] text-amber-900 leading-normal">
                    Bạn đang ở <strong>Chế độ Ngoại tuyến (Bộ nhớ máy)</strong>. Hãy bật Trực tuyến trong Cấu hình để liên kết Google Sheet.
                  </p>
                </div>
              )}

              {/* PHÂN KHU 2: NHẬP / XUẤT FILE TỪ THIẾT BỊ */}
              <div className="bg-white border border-slate-200/80 rounded-2xl p-2 shadow-2xs space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  {/* Nhập sách từ file */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx, .xls, .csv, .pdf"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isProcessing}
                    className="h-10 px-2.5 bg-[#1b6b5b] hover:bg-[#145d4b] text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-1.5 active:scale-95 shadow-3xs cursor-pointer disabled:opacity-40"
                  >
                    <Upload className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">Nhập từ file</span>
                  </button>

                  {/* Xuất file Excel */}
                  <button
                    type="button"
                    onClick={() => {
                      if (books.length === 0) {
                        showToast('Không có dữ liệu sách để xuất file Excel!', 'warning');
                        return;
                      }
                      exportBooksToExcel(books);
                    }}
                    className="h-10 px-2.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-bold rounded-xl transition flex items-center justify-center gap-1.5 active:scale-95 shadow-3xs cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                    <span className="truncate">Xuất file Excel</span>
                  </button>
                </div>

                {/* Nhập từ Drive (chỉ hiện khi Online) — dùng scope spreadsheets.readonly, liệt kê MỌI sheet của user */}
                {appMode === 'online' && (
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        if (!showDriveImportPicker) {
                          handleLoadDriveImportSheets();
                        }
                        setShowDriveImportPicker(prev => !prev);
                      }}
                      disabled={isProcessing || !!isImportingFromDrive}
                      className={`w-full h-10 px-2.5 border text-xs font-bold rounded-xl transition flex items-center justify-center gap-1.5 active:scale-95 shadow-3xs cursor-pointer disabled:opacity-40 ${
                        showDriveImportPicker
                          ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700'
                      }`}
                    >
                      <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">Nhập từ Drive</span>
                      {isLoadingImportSheets && <Loader2 className="w-3 h-3 animate-spin ml-1 shrink-0" />}
                    </button>

                    {/* Drive Import Picker — hiển thị MỌI Google Sheet của user */}
                    {showDriveImportPicker && (
                      <div className="mt-2 bg-blue-50/70 border border-blue-200/80 rounded-xl p-2.5 space-y-2 animate-in fade-in duration-150">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="text-[11px] font-black text-blue-900">Chọn file để nhập dữ liệu:</span>
                            <p className="text-[9.5px] text-blue-600 mt-0.5">Tất cả Google Sheet bạn có quyền truy cập</p>
                          </div>
                          <button
                            type="button"
                            onClick={handleLoadDriveImportSheets}
                            disabled={isLoadingImportSheets}
                            className="text-[10px] font-bold text-blue-700 hover:underline flex items-center gap-0.5 shrink-0"
                          >
                            <RefreshCw className={`w-2.5 h-2.5 ${isLoadingImportSheets ? 'animate-spin' : ''}`} />
                            Làm mới
                          </button>
                        </div>

                        {isLoadingImportSheets ? (
                          <div className="py-4 text-center text-xs text-blue-600 flex items-center justify-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Đang tìm file...</span>
                          </div>
                        ) : driveImportSheets.length > 0 ? (
                          <div className="space-y-1.5 max-h-40 overflow-y-auto pr-0.5">
                            {driveImportSheets.map(sheet => (
                              <div
                                key={sheet.id}
                                className="p-2 rounded-lg border border-blue-100 bg-white flex items-center justify-between gap-2 hover:border-blue-300 hover:bg-blue-50 transition"
                              >
                                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                  <FileSpreadsheet className="w-3.5 h-3.5 text-[#1b6b5b] shrink-0" />
                                  <span className="text-[11px] font-semibold text-slate-800 truncate">{sheet.name}</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleImportFromDriveSheet(sheet)}
                                  disabled={!!isImportingFromDrive}
                                  className="shrink-0 px-2.5 py-1 bg-[#1b6b5b] hover:bg-[#145d4b] text-white text-[10px] font-bold rounded-lg transition active:scale-95 cursor-pointer disabled:opacity-50 flex items-center gap-1"
                                >
                                  {isImportingFromDrive === sheet.id ? (
                                    <><Loader2 className="w-3 h-3 animate-spin" /><span>Đang tải...</span></>
                                  ) : (
                                    <><Download className="w-3 h-3" /><span>Nhập</span></>
                                  )}
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="py-3 text-center text-[11px] text-blue-700 bg-white rounded-lg border border-dashed border-blue-200">
                            Không tìm thấy file Google Sheet nào trên Drive.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* PHÂN KHU 3: STATUS BANNER GỌN GÀNG (1 dòng duy nhất) */}
              {appMode === 'online' && spreadsheetInfo && lastSyncTime && (
                <div className="py-2 px-3 bg-emerald-50 border border-emerald-200/80 rounded-xl flex items-center justify-between gap-1.5 text-xs text-emerald-950 font-bold animate-in fade-in duration-150">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1 truncate">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span className="truncate text-[11px]">Đã đồng bộ 2 chiều thành công</span>
                  </div>
                  <span className="text-[10px] text-emerald-700 font-mono font-medium shrink-0">
                    {lastSyncTime}
                  </span>
                </div>
              )}

            </div>
          )}

        </div>

        {/* Footer Actions (Luôn cố định ở chân modal để người dùng thao tác tức thì) */}
        <div className="p-3 bg-white border-t border-slate-200 flex items-center justify-between gap-2.5 shrink-0">
          {scanResult ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setScanResult(null);
                  setStagingItems([]);
                }}
                disabled={isProcessing}
                className="px-3.5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition active:scale-95 cursor-pointer disabled:opacity-50 shrink-0"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={handleConfirmImport}
                disabled={isProcessing || selectedCount === 0}
                className="flex-1 py-2.5 px-4 bg-[#1b6b5b] hover:bg-[#145d4b] active:scale-95 text-white font-extrabold text-xs rounded-xl shadow-md transition flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Đang lưu vào kho...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4 stroke-[3]" />
                    <span>Lưu {selectedCount} cuốn vào Thư Viện</span>
                  </>
                )}
              </button>
            </>
          ) : (
            <div className="flex w-full justify-end">
              <button
                type="button"
                onClick={handleCloseModal}
                className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold rounded-xl transition active:scale-95 cursor-pointer"
              >
                Đóng
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
