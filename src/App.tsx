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

        if (firestoreBooks.length > 0) {
          setBooks(firestoreBooks);
        } else {
          // Nếu Firestore trống, nạp toàn bộ 591 cuốn sách gốc của người dùng
          setBooks(USER_MASTER_BOOKS);
          await seedMasterBooksToFirestore(false).catch(() => {});
        }

        const firestoreSettings = await getLibrarySettingsFromFirestore();
        if (firestoreSettings) {
          setSettings(firestoreSettings);
          localStorage.setItem('library_settings_v2', JSON.stringify(firestoreSettings));
        }

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
    setBooks((prev) => {
      const exists = prev.some((b) => b.id === book.id);
      if (exists) {
        return prev.map((b) => (b.id === book.id ? book : b));
      }
      return [book, ...prev];
    });

    try {
      await saveBookToFirestore(book);
    } catch (err) {
      console.error('Error saving book to Firestore:', err);
    }
  };

  // Lưu hàng loạt sách (từ Bảng chờ AI Vision Scanner)
  const handleSaveBatchBooks = async (newBooks: BookRecord[]) => {
    setBooks((prev) => [...newBooks, ...prev]);
    await batchSaveBooksToFirestore(newBooks);
  };

  // Xóa 1 cuốn sách
  const handleDeleteBook = async (id: string) => {
    setBooks((prev) => prev.filter((b) => b.id !== id));
    try {
      await deleteBookFromFirestore(id);
      showToast('Đã xóa cuốn sách khỏi kho!', 'info');
    } catch (err) {
      console.error('Error deleting book from Firestore:', err);
    }
  };

  // Nạp lại dữ liệu gốc (591 cuốn)
  const handleResetMasterData = async () => {
    await seedMasterBooksToFirestore(true);
    setBooks(USER_MASTER_BOOKS);
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
        setBooks((prev) => [...uniqueToImport, ...prev]);
        await batchSaveBooksToFirestore(uniqueToImport);
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
        onSaveDriveSyncUrl={(url) => handleSaveSettings({ ...settings, driveSyncUrl: url })}
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
