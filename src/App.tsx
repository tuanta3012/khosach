import React, { useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { BookRecord, LibrarySettings, AuthUser } from './types';
import { USER_MASTER_BOOKS } from './data/sampleBooks';
import {
  loadLocalBooks,
  saveAllLocalBooks,
  upsertLocalBook,
  deleteLocalBook,
  batchDeleteLocalBooks,
  batchUpsertLocalBooks,
  resetLocalToMasterBooks,
  loadLocalSettings,
  saveLocalSettings,
  setLastDriveSyncTimestamp,
  getLastDriveSyncTimestamp,
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
} from './utils/localBooksStorage';
import { Navbar, NavTabType } from './components/Navbar';
import { BookTableView } from './components/BookTableView';
import { BatchScanner } from './components/BatchScanner';
import { AddEditBookModal } from './components/AddEditBookModal';
import { DataSyncModal } from './components/DataSyncModal';
import { SettingsModal } from './components/SettingsModal';
import { AppUpdateModal } from './components/AppUpdateModal';
import { useToast } from './context/ToastContext';
import { checkDuplicateBook } from './utils/fuzzyMatcher';
import { useAutoUpdate } from './hooks/useAutoUpdate';
import { CURRENT_APP_VERSION } from './version';
import {
  pullDataFromDriveWebApp,
  pushCleanDataToDriveWebApp,
} from './utils/driveSyncService';
import {
  getStoredOrConfiguredSheetUrl,
  getStoredOrConfiguredScriptUrl,
} from './config/syncConfig';
import { batchNormalize } from './utils/geminiService';

export default function App() {
  const { showToast } = useToast();
  const [currentTab, setCurrentTab] = useState<NavTabType>('table');
  const [books, setBooks] = useState<BookRecord[]>(() => loadLocalBooks());
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncingDrive, setIsSyncingDrive] = useState(false);
  const [settings, setSettings] = useState<LibrarySettings>(() => loadLocalSettings());

  // Lưu cache sách vào localStorage khi books thay đổi
  useEffect(() => {
    if (books && books.length > 0) {
      saveAllLocalBooks(books);
    }
  }, [books]);

  // Modals state
  const [isAddEditModalOpen, setIsAddEditModalOpen] = useState(false);
  const [editingBook, setEditingBook] = useState<BookRecord | null>(null);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isAutoNormalizing, setIsAutoNormalizing] = useState(false);
  
  // App Auto Update
  const {
    updateInfo,
    isModalOpen: isUpdateModalOpen,
    checkForUpdate,
    closeModal: closeUpdateModal
  } = useAutoUpdate();

  // User auth state
  const [currentUser] = useState<AuthUser | null>(() => {
    try {
      const saved = localStorage.getItem('library_user_v2');
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      email: 'tuanta3012@gmail.com',
      name: 'Chủ Kho Sách',
      userRole: 'ADMIN',
    };
  });

  // Đồng bộ hai chiều với Google Drive qua Google Apps Script (Thêm/Sửa/Xóa từ cả 2 phía)
  const syncWithDrive = async (currentLocalBooks: BookRecord[], actionType: 'STARTUP' | 'MUTATION') => {
    const sheetUrl = getStoredOrConfiguredSheetUrl();
    const scriptUrl = getStoredOrConfiguredScriptUrl();

    if (!sheetUrl && !scriptUrl) {
      return currentLocalBooks;
    }

    const isPlaceholderScript = !scriptUrl || scriptUrl.includes('AKfyczt126a5BfMe-0o8');
    const isPlaceholderSheet = !sheetUrl || sheetUrl.includes('1WmvnebrW2NwMAc5r');

    if (isPlaceholderScript && isPlaceholderSheet) {
      console.log('[Sync] Đang dùng liên kết mẫu, bỏ qua đồng bộ mạng. Ứng dụng hoạt động trên bộ nhớ máy.');
      return currentLocalBooks;
    }

    setIsSyncingDrive(true);
    try {
      if (actionType === 'STARTUP') {
        console.log('[Sync] Khởi động: Tải toàn bộ dữ liệu master từ Google Drive Sheet về...');
        const res = await pullDataFromDriveWebApp(scriptUrl, sheetUrl);

        if (res.success && res.books) {
          if (res.books.length > 0) {
            console.log(`[Sync] Đã tải về ${res.books.length} cuốn sách master từ Google Drive, tiến hành thay thế dữ liệu trên máy.`);
            saveAllLocalBooks(res.books);
            setBooks(res.books);
            setLastDriveSyncTimestamp();
            showToast(`🚀 Đã cập nhật ${res.books.length} sách từ Drive thay thế dữ liệu máy!`, 'success');
            return res.books;
          } else if (res.books.length === 0 && currentLocalBooks.length > 0) {
            // Google Drive trống hoàn toàn (vừa liên kết Sheet mới trống), đẩy dữ liệu cục bộ lên làm mốc ban đầu
            if (scriptUrl && !isPlaceholderScript) {
              console.log('[Sync] Phát hiện Google Sheet trống, đang tự động đồng bộ đẩy dữ liệu máy lên...');
              await pushCleanDataToDriveWebApp(scriptUrl, currentLocalBooks, sheetUrl).catch((err) => {
                console.warn('[Sync] Khởi tạo dữ liệu lên Sheet thất bại:', err.message);
              });
              setLastDriveSyncTimestamp();
              showToast(`🚀 Đã khởi tạo thành công ${currentLocalBooks.length} sách lên Google Sheet trống!`, 'success');
            }
          }
        }
      } else if (actionType === 'MUTATION') {
        // Với MUTATION (thêm, sửa, xóa, chuẩn hóa), đẩy lên Google Sheet nếu có cấu hình Apps Script thật
        if (scriptUrl && !isPlaceholderScript) {
          console.log('[Sync] Tự động đồng nhất thay đổi lên Google Sheet...');
          await pushCleanDataToDriveWebApp(scriptUrl, currentLocalBooks, sheetUrl).catch((err) => {
            console.warn('[Sync] Lỗi tự động đồng nhất lên Google Sheet:', err.message);
          });
          setLastDriveSyncTimestamp();
        }
      }
    } catch (err: any) {
      console.warn('[Sync] Thông tin quá trình đồng bộ tự động:', err.message || err);
    } finally {
      setIsSyncingDrive(false);
    }
    return currentLocalBooks;
  };

  // 1. Khởi tạo Native Status Bar trên Android Capacitor
  useEffect(() => {
    const initStatusBar = async () => {
      try {
        if (Capacitor.isNativePlatform() || (typeof window !== 'undefined' && 'Capacitor' in window)) {
          await StatusBar.setOverlaysWebView({ overlay: false });
          await StatusBar.setBackgroundColor({ color: '#0f172a' });
          await StatusBar.setStyle({ style: Style.Dark });
        }
      } catch {}
    };
    initStatusBar();
  }, []);

  // 2. Nạp dữ liệu ban đầu từ bộ nhớ máy & chạy đồng bộ 2 chiều tự động với Google Drive
  useEffect(() => {
    const initData = async () => {
      setIsLoading(true);
      try {
        const localBooks = loadLocalBooks();
        setBooks(localBooks);

        const localSettings = loadLocalSettings();
        setSettings(localSettings);

        // Chạy đồng bộ 2 chiều tự động với Google Sheet lúc khởi chạy app
        const syncedBooks = await syncWithDrive(localBooks, 'STARTUP').catch((err) => {
          console.warn('[Sync] Khởi chạy đồng bộ 2 chiều tự động thất bại, tiếp tục với dữ liệu local:', err);
          return localBooks;
        });
        setBooks(syncedBooks);
      } catch (err: any) {
        console.warn('Fallback to local master books cache:', err);
        setBooks(USER_MASTER_BOOKS);
      } finally {
        setIsLoading(false);
      }
    };

    initData();
  }, []);

  // 3. Tự động kiểm tra bản cập nhật mới khi mở ứng dụng (sau 1.5 giây)
  useEffect(() => {
    const isAiStudioPreview = typeof window !== 'undefined' && window.location.hostname.includes('run.app');

    // Không tự động hiển thị popup khi đang xem thử trong iframe preview dev AI Studio
    if (isAiStudioPreview) return;

    const timer = setTimeout(() => {
      checkForUpdate(false).catch((err) => {
        console.log('[AutoUpdate] Bỏ qua kiểm tra ngầm:', err);
      });
    }, 1500);

    return () => clearTimeout(timer);
  }, [checkForUpdate]);

  // 4. Tự động chuẩn hóa dữ liệu ngầm khi bật công tắc gạt và có sách chưa chuẩn hóa
  useEffect(() => {
    if (!settings.autoNormalizeEnabled || isAutoNormalizing || isLoading) return;

    const pending = books.filter((b) => !b.is_ai_normalized);
    if (pending.length === 0) return;

    const runAutoNormalize = async () => {
      setIsAutoNormalizing(true);
      const batch = pending.slice(0, 8);
      console.log(`[AutoNormalize] Bắt đầu chuẩn hóa ngầm ${batch.length} cuốn sách chưa chuẩn hóa...`);

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

          await handleBatchUpdateBooks(updatedList);
          console.log(`[AutoNormalize] Đã tự động chuẩn hóa thành công ${updatedList.length} cuốn sách ngầm!`);
        }
      } catch (err) {
        console.error('[AutoNormalize] Lỗi chuẩn hóa tự động ngầm:', err);
      } finally {
        setTimeout(() => {
          setIsAutoNormalizing(false);
        }, 4000);
      }
    };

    const timer = setTimeout(runAutoNormalize, 2000);
    return () => clearTimeout(timer);
  }, [books, settings.autoNormalizeEnabled, isAutoNormalizing, isLoading]);

  // Kiểm tra cập nhật thủ công khi người dùng bấm nút
  const handleManualCheckUpdates = async () => {
    try {
      const res = await checkForUpdate(true);
      if (!res.hasUpdate) {
        showToast(`Bạn đang sử dụng phiên bản mới nhất (v${res.currentVersion})!`, 'success');
      }
    } catch {
      showToast('Không thể kết nối đến máy chủ kiểm tra cập nhật.', 'warning');
    }
  };

  // Lưu 1 cuốn sách (Lưu ngay vào bộ nhớ máy và đồng bộ lên Google Drive)
  const handleSaveBook = async (book: BookRecord) => {
    const updatedBooks = upsertLocalBook(book);
    setBooks(updatedBooks);
    showToast('Đã lưu sách vào bộ nhớ máy thành công!', 'success');
    syncWithDrive(updatedBooks, 'MUTATION').catch(() => {});
  };

  // Lưu hàng loạt sách (từ Bảng chờ AI Vision Scanner)
  const handleSaveBatchBooks = async (newBooks: BookRecord[]) => {
    const updatedBooks = batchUpsertLocalBooks(newBooks);
    setBooks(updatedBooks);
    showToast(`Đã thêm ${newBooks.length} cuốn sách vào kho!`, 'success');
    syncWithDrive(updatedBooks, 'MUTATION').catch(() => {});
  };

  // Cập nhật và chuẩn hóa hàng loạt sách bằng AI
  const handleBatchUpdateBooks = async (updatedBooksList: BookRecord[]) => {
    const updatedBooks = batchUpsertLocalBooks(updatedBooksList);
    setBooks(updatedBooks);
    syncWithDrive(updatedBooks, 'MUTATION').catch(() => {});
  };

  // Xóa hàng loạt cuốn sách theo danh sách ID (dùng khi lọc dọn dẹp sách trùng lặp)
  const handleBatchDeleteBooks = async (idsToDelete: string[]) => {
    const updatedBooks = batchDeleteLocalBooks(idsToDelete);
    setBooks(updatedBooks);
    syncWithDrive(updatedBooks, 'MUTATION').catch(() => {});
  };

  // Xóa 1 cuốn sách
  const handleDeleteBook = async (id: string) => {
    const updatedBooks = deleteLocalBook(id);
    setBooks(updatedBooks);
    showToast('Đã xóa cuốn sách khỏi kho!', 'info');
    syncWithDrive(updatedBooks, 'MUTATION').catch(() => {});
  };

  // Nạp lại dữ liệu gốc (591 cuốn)
  const handleResetMasterData = async () => {
    const resetBooks = resetLocalToMasterBooks();
    setBooks(resetBooks);
    showToast('Đã khôi phục 591 cuốn sách gốc!', 'success');
    syncWithDrive(resetBooks, 'MUTATION').catch(() => {});
  };

  // Nhập kho từ file JSON/Excel/CSV
  const handleImportBooks = async (
    imported: BookRecord[],
    replace: boolean
  ): Promise<{ addedCount: number; skippedCount: number }> => {
    if (replace) {
      saveAllLocalBooks(imported);
      setBooks(imported);
      syncWithDrive(imported, 'MUTATION').catch(() => {});
      return { addedCount: imported.length, skippedCount: 0 };
    } else {
      // Chế độ Gộp: Tự động lọc trùng lặp với kho sách hiện tại
      const uniqueToImport: BookRecord[] = [];
      let skippedCount = 0;

      for (const item of imported) {
        const { isDuplicate } = checkDuplicateBook(
          { title: item.title, author: item.author },
          books
        );
        if (isDuplicate) {
          skippedCount++;
        } else {
          uniqueToImport.push(item);
        }
      }

      if (uniqueToImport.length > 0) {
        const updatedBooks = batchUpsertLocalBooks(uniqueToImport);
        setBooks(updatedBooks);
        syncWithDrive(updatedBooks, 'MUTATION').catch(() => {});
      }
      return { addedCount: uniqueToImport.length, skippedCount };
    }
  };

  // Lưu cài đặt
  const handleSaveSettings = async (newSettings: LibrarySettings) => {
    setSettings(newSettings);
    saveLocalSettings(newSettings);
  };

  // Danh mục thể loại tổng hợp
  const currentCategories = Array.from(
    new Set([
      ...DEFAULT_CATEGORIES,
      ...(settings.categoriesList || []),
      ...books.map((b) => b.category || 'Chung').filter(Boolean),
    ])
  );

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col antialiased">
      {/* Navbar Header */}
      <Navbar
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        totalBooksCount={books.length}
        currentUser={currentUser}
        onOpenSyncModal={() => setIsSyncModalOpen(true)}
        onOpenAddModal={() => {
          setEditingBook(null);
          setIsAddEditModalOpen(true);
        }}
        onOpenSettingsModal={() => setIsSettingsModalOpen(true)}
        isSyncingDrive={isSyncingDrive}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3.5 sm:px-6 py-3 pb-24 md:pb-8 app-content-container">
        {currentTab === 'table' && (
          <BookTableView
            books={books}
            categories={currentCategories}
            onSaveBook={handleSaveBook}
            onDeleteBook={handleDeleteBook}
            onOpenAddModal={() => {
              setEditingBook(null);
              setIsAddEditModalOpen(true);
            }}
            onOpenImportModal={() => setIsSyncModalOpen(true)}
            onResetMasterData={handleResetMasterData}
          />
        )}

        {currentTab === 'scanner' && (
          <BatchScanner
            existingBooks={books}
            categories={currentCategories}
            onSaveToLibrary={handleSaveBatchBooks}
            onSwitchToTable={() => setCurrentTab('table')}
          />
        )}
      </main>

      {/* Modals */}
      <AddEditBookModal
        isOpen={isAddEditModalOpen}
        onClose={() => {
          setIsAddEditModalOpen(false);
          setEditingBook(null);
        }}
        onSave={handleSaveBook}
        initialBook={editingBook}
        categories={currentCategories}
        books={books}
      />

      <DataSyncModal
        isOpen={isSyncModalOpen}
        onClose={() => setIsSyncModalOpen(false)}
        books={books}
        onImportBooks={handleImportBooks}
        userEmail={currentUser?.email}
        driveSyncUrl={settings.driveSyncUrl}
        driveTargetFileUrl={settings.driveTargetFileUrl}
        onSaveConfig={(sheetUrl, scriptUrl) => handleSaveSettings({ ...settings, driveTargetFileUrl: sheetUrl, driveSyncUrl: scriptUrl })}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        settings={settings}
        onSaveSettings={handleSaveSettings}
        onResetMasterData={handleResetMasterData}
        onCheckUpdates={handleManualCheckUpdates}
        books={books}
        onBatchUpdateBooks={handleBatchUpdateBooks}
        onBatchDeleteBooks={handleBatchDeleteBooks}
        isAutoNormalizing={isAutoNormalizing}
      />

      <AppUpdateModal
        isOpen={isUpdateModalOpen}
        currentVersion={CURRENT_APP_VERSION}
        updateInfo={updateInfo}
        onClose={closeUpdateModal}
      />
    </div>
  );
}
