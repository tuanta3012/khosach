import React, { useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { BookRecord, LibrarySettings, AuthUser } from './types';
import { USER_MASTER_BOOKS } from './data/sampleBooks';
import {
  fetchAllBooksFromFirestore,
  subscribeToBooksRealtime,
  saveBookToFirestore,
  batchSaveBooksToFirestore,
  deleteBookFromFirestore,
  clearAllBooksInFirestore,
  seedMasterBooksToFirestore,
  getLibrarySettingsFromFirestore,
  saveLibrarySettingsToFirestore,
  testFirestoreConnection,
} from './utils/firebaseFirestoreService';
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

// Unique categories list extracted from user master books
const DEFAULT_CATEGORIES = Array.from(
  new Set(USER_MASTER_BOOKS.map((b) => b.category || 'Chung').filter(Boolean))
);

const DEFAULT_SETTINGS: LibrarySettings = {
  autoEnrichEnabled: true,
  categoriesList: DEFAULT_CATEGORIES,
};

export default function App() {
  const { showToast } = useToast();
  const [currentTab, setCurrentTab] = useState<NavTabType>('table');
  const [books, setBooks] = useState<BookRecord[]>(USER_MASTER_BOOKS);
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<LibrarySettings>(() => {
    try {
      const saved = localStorage.getItem('library_settings_v2');
      if (saved) return JSON.parse(saved);
    } catch {}
    return DEFAULT_SETTINGS;
  });

  // Modals state
  const [isAddEditModalOpen, setIsAddEditModalOpen] = useState(false);
  const [editingBook, setEditingBook] = useState<BookRecord | null>(null);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  
  // App Auto Update (Sổ Tiết Kiệm Architecture)
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

  // Đồng bộ hai chiều tự động khi mở App hoặc khi thực hiện thay đổi
  const syncWithDrive = async (currentLocalBooks: BookRecord[], actionType: 'STARTUP' | 'MUTATION') => {
    const sheetUrl = getStoredOrConfiguredSheetUrl();
    const scriptUrl = getStoredOrConfiguredScriptUrl();

    if (!sheetUrl && !scriptUrl) {
      console.log('[Sync] Không cấu hình Google Sheet/Script URL, bỏ qua đồng bộ tự động.');
      return currentLocalBooks;
    }

    try {
      if (actionType === 'STARTUP') {
        console.log('[Sync] Bắt đầu đồng bộ 2 chiều tự động lúc khởi chạy...');
        // 1. Kéo dữ liệu từ Sheet về qua proxy
        const res = await pullDataFromDriveWebApp(scriptUrl, sheetUrl).catch((err) => {
          console.warn('[Sync] Không kéo được dữ liệu từ Sheet:', err.message);
          return { success: false, books: [] as BookRecord[] };
        });

        if (res.success && res.books && res.books.length > 0) {
          // 2. Trộn dữ liệu 2 chiều (Firestore + Sheet) dựa trên ID và updated_at
          const mergedMap = new Map<string, BookRecord>();
          
          // Nạp dữ liệu Firestore trước
          currentLocalBooks.forEach((b) => mergedMap.set(b.id, b));
          
          // Trộn dữ liệu từ Sheet
          let hasNewOrUpdatedFromSheet = false;
          res.books.forEach((sb) => {
            const existing = mergedMap.get(sb.id);
            if (!existing) {
              mergedMap.set(sb.id, sb);
              hasNewOrUpdatedFromSheet = true;
            } else {
              // So sánh ngày cập nhật
              if ((sb.updated_at || 0) > (existing.updated_at || 0)) {
                mergedMap.set(sb.id, sb);
                hasNewOrUpdatedFromSheet = true;
              }
            }
          });

          const finalBooks = Array.from(mergedMap.values());

          // 3. Nếu có dữ liệu mới/cập nhật từ Sheet, lưu hàng loạt vào Firestore
          if (hasNewOrUpdatedFromSheet) {
            console.log('[Sync] Phát hiện sách mới hoặc mới hơn từ Google Sheet, cập nhật vào Firestore...');
            await batchSaveBooksToFirestore(finalBooks);
          }

          // 4. Đẩy lại danh sách đã trộn đầy đủ & sạch sẽ lên Google Sheet
          console.log('[Sync] Đang đồng nhất dữ liệu sạch lên Google Sheet...');
          await pushCleanDataToDriveWebApp(scriptUrl, finalBooks, sheetUrl).catch((err) => {
            console.warn('[Sync] Không đẩy được dữ liệu lên Sheet:', err.message);
            showToast(`⚠️ Lỗi cập nhật Sheet khi khởi động: ${err.message || String(err)}`, 'warning');
          });

          showToast(`🚀 Đồng bộ tự động 2 chiều thành công! Kho sách có ${finalBooks.length} cuốn.`, 'success');
          return finalBooks;
        } else {
          // Nếu kéo rỗng hoặc thất bại, nhưng trên local/Firestore đang có dữ liệu, hãy đẩy dữ liệu Firestore lên Sheet
          if (currentLocalBooks.length > 0) {
            console.log('[Sync] Sheet trống, đang tự động khởi tạo dữ liệu của Firestore lên Google Sheet...');
            await pushCleanDataToDriveWebApp(scriptUrl, currentLocalBooks, sheetUrl).catch((err) => {
              console.warn('[Sync] Khởi tạo dữ liệu lên Sheet thất bại:', err.message);
              showToast(`⚠️ Không thể khởi tạo dữ liệu gốc lên Sheet: ${err.message || String(err)}`, 'warning');
            });
          }
        }
      } else if (actionType === 'MUTATION') {
        // Với MUTATION (thêm, sửa, xóa), ta đẩy luôn danh sách sách hiện tại lên Google Sheet
        console.log('[Sync] Tự động đồng nhất thay đổi lên Google Sheet...');
        await pushCleanDataToDriveWebApp(scriptUrl, currentLocalBooks, sheetUrl).catch((err) => {
          console.warn('[Sync] Lỗi tự động đồng nhất lên Google Sheet:', err.message);
          showToast(`⚠️ Không thể đồng bộ thay đổi lên Google Sheet: ${err.message || String(err)}`, 'warning');
        });
      }
    } catch (err: any) {
      console.error('[Sync] Lỗi trong quá trình đồng bộ tự động:', err);
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

  // 2. Nạp dữ liệu ban đầu từ Firestore & kết nối realtime listener
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const initData = async () => {
      setIsLoading(true);
      try {
        await testFirestoreConnection();
        const firestoreBooks = await fetchAllBooksFromFirestore();
        let baseBooks = firestoreBooks;

        if (firestoreBooks.length > 0) {
          setBooks(firestoreBooks);
        } else {
          // Nếu Firestore trống, nạp toàn bộ 591 cuốn sách gốc của người dùng
          setBooks(USER_MASTER_BOOKS);
          await seedMasterBooksToFirestore(false).catch(() => {});
          baseBooks = USER_MASTER_BOOKS;
        }

        const firestoreSettings = await getLibrarySettingsFromFirestore();
        if (firestoreSettings) {
          setSettings(firestoreSettings);
          localStorage.setItem('library_settings_v2', JSON.stringify(firestoreSettings));
          if (firestoreSettings.driveSyncUrl) {
            localStorage.setItem('drive_sync_url_v1', firestoreSettings.driveSyncUrl);
          }
          if (firestoreSettings.driveTargetFileUrl) {
            localStorage.setItem('drive_target_file_url_v1', firestoreSettings.driveTargetFileUrl);
          }
        }

        // Chạy đồng bộ 2 chiều tự động với Google Sheet lúc khởi chạy app!
        const syncedBooks = await syncWithDrive(baseBooks, 'STARTUP').catch((err) => {
          console.warn('[Sync] Khởi chạy đồng bộ 2 chiều tự động thất bại, tiếp tục với dữ liệu local:', err);
          return baseBooks;
        });
        setBooks(syncedBooks);

        // Lắng nghe thay đổi thời gian thực từ Firestore
        unsubscribe = subscribeToBooksRealtime((realtimeBooks) => {
          if (realtimeBooks && realtimeBooks.length > 0) {
            setBooks(realtimeBooks);
          }
        });
      } catch (err) {
        console.warn('Fallback to local master books cache:', err);
        setBooks(USER_MASTER_BOOKS);
      } finally {
        setIsLoading(false);
      }
    };

    initData();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // 3. Tự động kiểm tra bản cập nhật mới (bằng useAutoUpdate hook)
  useEffect(() => {
    const timer = setTimeout(() => {
      checkForUpdate().catch((err) => {
        console.log('Update check skipped:', err);
      });
    }, 2500);

    return () => clearTimeout(timer);
  }, [checkForUpdate]);

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

  // Lưu 1 cuốn sách
  const handleSaveBook = async (book: BookRecord) => {
    let updatedBooks: BookRecord[] = [];
    setBooks((prev) => {
      const exists = prev.some((b) => b.id === book.id);
      updatedBooks = exists
        ? prev.map((b) => (b.id === book.id ? book : b))
        : [book, ...prev];
      return updatedBooks;
    });

    try {
      await saveBookToFirestore(book);
      // Đồng bộ tức thì lên Google Sheet
      await syncWithDrive(updatedBooks, 'MUTATION');
    } catch (err) {
      console.error('Error saving book to Firestore:', err);
    }
  };

  // Lưu hàng loạt sách (từ Bảng chờ AI Vision Scanner)
  const handleSaveBatchBooks = async (newBooks: BookRecord[]) => {
    let updatedBooks: BookRecord[] = [];
    setBooks((prev) => {
      updatedBooks = [...newBooks, ...prev];
      return updatedBooks;
    });
    try {
      await batchSaveBooksToFirestore(newBooks);
      // Đồng bộ tức thì lên Google Sheet
      await syncWithDrive(updatedBooks, 'MUTATION');
    } catch (err) {
      console.error('Error batch saving books:', err);
    }
  };

  // Xóa 1 cuốn sách
  const handleDeleteBook = async (id: string) => {
    const originalBooks = [...books];
    let updatedBooks: BookRecord[] = [];
    setBooks((prev) => {
      updatedBooks = prev.filter((b) => b.id !== id);
      return updatedBooks;
    });
    try {
      await deleteBookFromFirestore(id);
      showToast('Đã xóa cuốn sách khỏi kho!', 'info');
      // Đồng bộ tức thì lên Google Sheet
      await syncWithDrive(updatedBooks, 'MUTATION');
    } catch (err: any) {
      console.error('Error deleting book from Firestore:', err);
      let errorMsg = 'Lỗi kết nối hoặc không đủ quyền xóa sách.';
      try {
        const parsed = JSON.parse(err.message);
        if (parsed && parsed.error) {
          errorMsg = `Lỗi: ${parsed.error}`;
        }
      } catch {
        if (err.message) {
          errorMsg = err.message;
        }
      }
      showToast(errorMsg, 'error');
      setBooks(originalBooks);
    }
  };

  // Nạp lại dữ liệu gốc (591 cuốn)
  const handleResetMasterData = async () => {
    try {
      await seedMasterBooksToFirestore(true);
      setBooks(USER_MASTER_BOOKS);
      // Đồng bộ tức thì lên Google Sheet
      await syncWithDrive(USER_MASTER_BOOKS, 'MUTATION');
    } catch (err) {
      console.error('Error resetting master data:', err);
    }
  };

  // Nhập kho từ file JSON/Excel/CSV
  const handleImportBooks = async (
    imported: BookRecord[],
    replace: boolean
  ): Promise<{ addedCount: number; skippedCount: number }> => {
    if (replace) {
      await clearAllBooksInFirestore();
      setBooks(imported);
      await batchSaveBooksToFirestore(imported);
      // Đồng bộ tức thì lên Google Sheet
      await syncWithDrive(imported, 'MUTATION');
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
        let updatedBooks: BookRecord[] = [];
        setBooks((prev) => {
          updatedBooks = [...uniqueToImport, ...prev];
          return updatedBooks;
        });
        await batchSaveBooksToFirestore(uniqueToImport);
        // Đồng bộ tức thì lên Google Sheet
        await syncWithDrive(updatedBooks, 'MUTATION');
      }
      return { addedCount: uniqueToImport.length, skippedCount };
    }
  };

  // Lưu cài đặt
  const handleSaveSettings = async (newSettings: LibrarySettings) => {
    setSettings(newSettings);
    localStorage.setItem('library_settings_v2', JSON.stringify(newSettings));
    await saveLibrarySettingsToFirestore(newSettings).catch(() => {});
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
      />

      {/* Main Content Area optimized for mobile viewports & safe area insets */}
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
