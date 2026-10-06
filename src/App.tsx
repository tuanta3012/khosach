import React, { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { BookRecord, LibrarySettings, AuthUser } from './types';
import {
  loadLocalBooks,
  saveAllLocalBooks,
  upsertLocalBook,
  deleteLocalBook,
  batchDeleteLocalBooks,
  batchUpsertLocalBooks,
  loadLocalSettings,
  saveLocalSettings,
  setLastDriveSyncTimestamp,
  DEFAULT_CATEGORIES,
} from './utils/localBooksStorage';
import { Navbar, NavTabType } from './components/Navbar';
import { BookTableView } from './components/BookTableView';
import { ModeSelectionModal } from './components/ModeSelectionModal';
const BatchScanner = lazy(() => import('./components/BatchScanner').then((module) => ({ default: module.BatchScanner })));
const AddEditBookModal = lazy(() => import('./components/AddEditBookModal').then((module) => ({ default: module.AddEditBookModal })));
const DataSyncModal = lazy(() => import('./components/DataSyncModal').then((module) => ({ default: module.DataSyncModal })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then((module) => ({ default: module.SettingsModal })));
const FamilyShareModal = lazy(() => import('./components/FamilyShareModal').then((module) => ({ default: module.FamilyShareModal })));
const AppUpdateModal = lazy(() => import('./components/AppUpdateModal').then((module) => ({ default: module.AppUpdateModal })));
import { useToast } from './context/ToastContext';
import { useAutoUpdate } from './hooks/useAutoUpdate';
import { CURRENT_APP_VERSION } from './version';
import { IS_BUILD_AAB } from './config/buildConfig';
import {
  googleSignIn,
  googleLogout,
  initAuth,
  getAccessToken,
  isGoogleTokenValid,
  clearExpiredGoogleSession,
} from './services/googleAuthService';
import {
  findOrCreateLibrarySpreadsheet,
  createNewLibrarySpreadsheet,
  syncBooksTwoWay,
  saveBooksToGoogleSheet,
  determineCurrentUserRole,
  synchronizeDrivePermissionsWithJsonMembers,
  autoDiscoverSharedSpreadsheets,
  updateSheetConfigStatus,
  SpreadsheetInfo,
  verifySpreadsheetWriteAccess,
  checkSpreadsheetStatusOnDrive,
  removeKnownSpreadsheet,
  saveKnownSpreadsheet,
} from './services/driveSyncService';
import { batchNormalize } from './utils/geminiService';
import { checkAndHandleFirstLaunch, deepClearAllApplicationData } from './utils/cleanSlateService';

export default function App() {
  const { showToast } = useToast();
  const [currentTab, setCurrentTab] = useState<NavTabType>('table');
  const [books, setBooks] = useState<BookRecord[]>(() => loadLocalBooks());
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncingDrive, setIsSyncingDrive] = useState(false);
  const [settings, setSettings] = useState<LibrarySettings>(() => loadLocalSettings());

  // Trạng thái Chế Độ (Offline Local-First vs Online Google Sync)
  const [appMode, setAppMode] = useState<'offline' | 'online'>(() => {
    try {
      const saved = localStorage.getItem('app_mode_v2');
      if (saved === 'offline' || saved === 'online') return saved;
    } catch {}
    return 'offline';
  });

  const [isModeSelectionOpen, setIsModeSelectionOpen] = useState<boolean>(() => {
    try {
      return !localStorage.getItem('app_mode_v2');
    } catch {
      return false;
    }
  });

  // TẦNG 3: KIỂM TRA LẦN ĐẦU CÀI ĐẶT (CHỐNG DỮ LIỆU RÁC AUTO-RESTORE CỦA ANDROID)
  useEffect(() => {
    (async () => {
      try {
        const isFirstLaunch = await checkAndHandleFirstLaunch(CURRENT_APP_VERSION);
        if (isFirstLaunch) {
          console.info('[CleanSlate] Phát hiện lần đầu mở app mới. Khởi tạo kho sạch sẽ 100%...');
          setBooks([]);
          setSettings(loadLocalSettings());
          setAppMode('offline');
          setIsModeSelectionOpen(true);
          setCurrentUser(null);
          setSpreadsheetInfo(null);
        }
      } catch (e) {
        console.warn('[CleanSlate] Lỗi khởi tạo lần đầu:', e);
      }
    })();
  }, []);

  // User Auth & Google Spreadsheet Info
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => {
    try {
      const saved = localStorage.getItem('library_user_v2');
      if (saved) return JSON.parse(saved);
      const profile = localStorage.getItem('google_drive_user_profile');
      if (profile) {
        const p = JSON.parse(profile);
        return {
          email: p.email || '',
          name: p.name || p.displayName || 'Người dùng Google',
          photoURL: p.picture || p.photoURL || undefined,
          userRole: 'ADMIN',
          isOffline: false,
        };
      }
    } catch {}
    return null;
  });

  const [spreadsheetInfo, setSpreadsheetInfo] = useState<SpreadsheetInfo | null>(() => {
    try {
      const saved = localStorage.getItem('library_spreadsheet_info_v2');
      if (saved) return JSON.parse(saved);
    } catch {}
    return null;
  });

  // Modals state
  const [isAddEditModalOpen, setIsAddEditModalOpen] = useState(false);
  const [editingBook, setEditingBook] = useState<BookRecord | null>(null);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isFamilyShareModalOpen, setIsFamilyShareModalOpen] = useState(false);
  const [isAutoNormalizing, setIsAutoNormalizing] = useState(false);
  
  // App Auto Update
  const {
    updateInfo,
    isModalOpen: isUpdateModalOpen,
    checkForUpdate,
    closeModal: closeUpdateModal
  } = useAutoUpdate();

  // Lưu cache sách vào localStorage khi books thay đổi
  useEffect(() => {
    if (books && books.length > 0) {
      saveAllLocalBooks(books);
    }
  }, [books]);

  // Khởi tạo Auth listener
  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        const u: AuthUser = {
          email: user.email || '',
          name: user.displayName || 'Người dùng Google',
          photoURL: user.photoURL || undefined,
          userRole: 'ADMIN',
          isOffline: false,
        };
        setCurrentUser(u);

        // NẾU phát hiện phiên Google Auth hợp lệ, tự động chuyển sang chế độ Online và đóng màn hình 2 nút bấm!
        if (token) {
          setAppMode('online');
          setIsModeSelectionOpen(false);
          try {
            localStorage.setItem('app_mode_v2', 'online');
          } catch {}

          // Tự động khám phá file active trên Google Drive nếu máy hiện tại chưa có thông tin liên kết hoặc liên kết chưa chuẩn
          (async () => {
            let savedSheet: SpreadsheetInfo | null = null;
            try {
              const raw = localStorage.getItem('library_spreadsheet_info_v2');
              if (raw) savedSheet = JSON.parse(raw);
            } catch {}

            if (savedSheet) {
              setSpreadsheetInfo(savedSheet);
              saveKnownSpreadsheet(savedSheet);
            }

            if (user.email) {
              const discovered = await autoDiscoverSharedSpreadsheets(token, user.email);
              if (discovered.length > 0) {
                const activeSheet = discovered[0];
                
                // Nếu chưa có savedSheet, hoặc có savedSheet nhưng khác với file active chính trên Drive và máy chưa có sách
                if (!savedSheet || (savedSheet.id !== activeSheet.id && loadLocalBooks().length === 0)) {
                  console.log(`[AutoDiscover] Tự động liên kết về file active chính của tài khoản: "${activeSheet.name}" (${activeSheet.id})`);
                  setSpreadsheetInfo(activeSheet);
                  try {
                    localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(activeSheet));
                    localStorage.removeItem('unlinked_spreadsheet_explicitly');
                  } catch {}
                  const role = await determineCurrentUserRole(token, activeSheet.id, user.email);
                  setCurrentUser(prev => prev ? { ...prev, userRole: role } : null);
                  
                  // Đồng bộ ngay với file vừa được tự động liên kết
                  await syncBooksTwoWay(loadLocalBooks(), token, activeSheet.id, role)
                    .then((syncRes) => {
                      if (syncRes.hasChanges) {
                        saveAllLocalBooks(syncRes.mergedBooks);
                        setBooks(syncRes.mergedBooks);
                        setLastDriveSyncTimestamp();
                      }
                    }).catch((e) => console.warn('[AutoDiscover] Đồng bộ sau tự động chuyển file thất bại:', e));
                }
              }
            }
          })();
        } else {
          // Nếu app đang cấu hình chế độ online, nhưng không lấy được token (hết hạn hoặc chưa đăng nhập)
          const savedMode = localStorage.getItem('app_mode_v2');
          if (savedMode === 'online') {
            console.log('[Auth] Đang cấu hình Online nhưng Token hết hạn/không có. Hiển thị màn hình 2 nút...');
            setIsModeSelectionOpen(true);
          }
        }
      },
      () => {
        // Sign out callback (khi user chủ động đăng xuất hoặc Firebase mất phiên)
        const savedMode = localStorage.getItem('app_mode_v2');
        if (savedMode === 'online') {
          console.log('[Auth] Trạng thái đăng xuất. Hiển thị lại màn hình 2 nút...');
          setIsModeSelectionOpen(true);
        }
      }
    );
    return () => unsubscribe();
  }, []);

  // Hàm Đồng Bộ 2 Chiều với Google Drive (Sheets API v4)
  const syncWithGoogleDrive = useCallback(
    async (currentBooks: BookRecord[]): Promise<BookRecord[]> => {
      if (appMode !== 'online') return currentBooks;

      const token = await getAccessToken();
      if (!token) {
        console.log('[Sync] Chưa có token Google Drive trong bộ nhớ, giữ nguyên dữ liệu máy.');
        return currentBooks;
      }

      setIsSyncingDrive(true);
      try {
        let sheetInfo = spreadsheetInfo;
        if (!sheetInfo || !sheetInfo.id) {
          console.log('[Sync] Chưa có Google Sheet nào được liên kết. Bỏ qua đồng bộ Drive.');
          setIsSyncingDrive(false);
          return currentBooks;
        }

        // 0. Xác thực sự tồn tại thực tế của file trên Google Drive trước khi đồng bộ
        const fileStatus = await checkSpreadsheetStatusOnDrive(token, sheetInfo.id);
        if (fileStatus.trashed || fileStatus.error === 'FILE_NOT_FOUND') {
          console.warn(`[Sync] File liên kết "${sheetInfo.name}" (${sheetInfo.id}) đã bị xóa hoặc vào thùng rác trên Drive:`, fileStatus.error);
          setSpreadsheetInfo(null);
          localStorage.removeItem('library_spreadsheet_info_v2');
          localStorage.removeItem('last_drive_sync_time');
          removeKnownSpreadsheet(sheetInfo.id);
          showToast(`⚠️ File "${sheetInfo.name}" đã bị xóa trên Google Drive. Đã hủy liên kết!`, 'warning');
          setIsSyncingDrive(false);
          return currentBooks;
        }

        // 1. Dynamic Authorization: Xác thực chéo vai trò thực tế từ Tab Config ẩn
        const activeRole = await determineCurrentUserRole(token, sheetInfo.id, currentUser?.email || '');
        if (currentUser && currentUser.userRole !== activeRole) {
          console.log(`[Sync] Cập nhật vai trò thành viên thực tế: ${currentUser.userRole} -> ${activeRole}`);
          const updatedUser = { ...currentUser, userRole: activeRole };
          setCurrentUser(updatedUser);
          try {
            localStorage.setItem('library_user_v2', JSON.stringify(updatedUser));
          } catch {}
        }

        // 2. Thực hiện đồng bộ 2 chiều
        const syncRes = await syncBooksTwoWay(
          currentBooks,
          token,
          sheetInfo.id,
          activeRole
        );

        // 3. Nếu là ADMIN (Owner), chạy kiểm toán và dọn dẹp quyền vật lý rác trên Google Drive
        if (activeRole === 'ADMIN') {
          synchronizeDrivePermissionsWithJsonMembers(token, sheetInfo.id, currentUser?.email || '')
            .then(() => console.log('[Sync] Đã tự động dọn dẹp và kiểm toán quyền truy cập Drive thành công.'))
            .catch((err) => console.warn('[Sync] Kiểm toán quyền Drive thất bại:', err));
        }

        if (syncRes.hasChanges) {
          saveAllLocalBooks(syncRes.mergedBooks);
          setBooks(syncRes.mergedBooks);
          setLastDriveSyncTimestamp();
          showToast(`🚀 Đã đồng bộ thành công ${syncRes.mergedBooks.length} sách với Google Drive!`, 'success');
          return syncRes.mergedBooks;
        }
      } catch (err: any) {
        if (
          err.message?.includes('404') ||
          err.message?.includes('not found') ||
          err.message?.includes('FILE_NOT_FOUND') ||
          err.message?.includes('FILE_TRASHED') ||
          err.message?.includes('Requested entity was not found') ||
          err.message?.includes('đã bị xóa')
        ) {
          setSpreadsheetInfo(null);
          localStorage.removeItem('library_spreadsheet_info_v2');
          localStorage.removeItem('last_drive_sync_time');
          if (spreadsheetInfo?.id) removeKnownSpreadsheet(spreadsheetInfo.id);
          showToast(`⚠️ File "${spreadsheetInfo?.name || 'liên kết'}" không còn tồn tại trên Google Drive. Đã tự động hủy liên kết!`, 'warning');
          return currentBooks;
        } else if (err.message === 'READ_ONLY_SCOPE_OR_PERMISSION') {
          showToast('⚠️ File này chỉ được cấp quyền Đọc (Read-Only). Đã lấy sách thành công, nhưng không thể đồng bộ 2 chiều ngược lên Drive. Hãy tạo File mới để đồng bộ đầy đủ!', 'warning');
          return currentBooks;
        } else if (
          err.message?.includes('invalid authentication credentials') ||
          err.message?.includes('401') ||
          err.message?.includes('TOKEN_EXPIRED')
        ) {
          clearExpiredGoogleSession();
          showToast('⚠️ Phiên đăng nhập Google đã hết hạn. Vui lòng bấm vào avatar góc trên để kết nối lại.', 'warning');
          return currentBooks;
        } else {
          console.warn('[Sync] Đồng bộ Google Drive gặp lỗi:', err.message || err);
          showToast(`⚠️ Đồng bộ thất bại: ${err.message || String(err)}`, 'error');
        }
        return currentBooks;
      } finally {
        setIsSyncingDrive(false);
      }

      return currentBooks;
    },
    [appMode, currentUser, spreadsheetInfo, showToast]
  );

  // 1. Khởi tạo Native Status Bar trên Android Capacitor
  useEffect(() => {
    const initStatusBar = async () => {
      try {
        if (Capacitor.isNativePlatform() || (typeof window !== 'undefined' && 'Capacitor' in window)) {
          await StatusBar.setOverlaysWebView({ overlay: false });
          await StatusBar.setBackgroundColor({ color: '#2b170e' });
          await StatusBar.setStyle({ style: Style.Dark });
        }
      } catch {}
    };
    initStatusBar();
  }, []);

  // 2. Nạp dữ liệu ban đầu từ bộ nhớ máy & chạy đồng bộ nếu ở chế độ Online
  useEffect(() => {
    const initData = async () => {
      setIsLoading(true);
      try {
        const localBooks = loadLocalBooks();
        setBooks(localBooks);

        const localSettings = loadLocalSettings();
        setSettings(localSettings);

        if (appMode === 'online') {
          if (isGoogleTokenValid()) {
            await syncWithGoogleDrive(localBooks).catch(() => {});
          } else {
            console.log('[Init] Phiên Google chưa sẵn sàng hoặc đã hết hạn, giữ nguyên kho sách trên máy.');
          }
        }
      } catch (err: any) {
        console.warn('Fallback to local storage cache:', err);
        setBooks(loadLocalBooks());
      } finally {
        setIsLoading(false);
      }
    };

    initData();
  }, [appMode, syncWithGoogleDrive]);

  // 3. Tự động kiểm tra bản cập nhật mới khi mở ứng dụng (sau 1.5 giây, chỉ áp dụng cho bản APK)
  useEffect(() => {
    if (IS_BUILD_AAB) return;

    const isAiStudioPreview = typeof window !== 'undefined' && window.location.hostname.includes('run.app');
    if (isAiStudioPreview) return;

    const timer = setTimeout(() => {
      checkForUpdate(false).catch((err) => {
        console.log('[AutoUpdate] Bỏ qua kiểm tra ngầm:', err);
      });
    }, 1500);

    return () => clearTimeout(timer);
  }, [checkForUpdate]);

  // 4. Xử lý Chọn Chế Độ (Offline vs Online)
  const handleSelectMode = async (selectedMode: 'offline' | 'online') => {
    if (selectedMode === 'offline') {
      setAppMode('offline');
      try {
        localStorage.setItem('app_mode_v2', 'offline');
      } catch {}
      setIsModeSelectionOpen(false);
    } else if (selectedMode === 'online') {
      try {
        // KIỂM TRA TRƯỚC: Nếu đã có phiên Google Auth hợp lệ sẵn rồi, chuyển thẳng vào trang và đồng bộ ngay
        const existingToken = await getAccessToken();
        if (existingToken && currentUser) {
          setAppMode('online');
          try {
            localStorage.setItem('app_mode_v2', 'online');
          } catch {}
          setIsModeSelectionOpen(false);
          await syncWithGoogleDrive(books).catch((e) => {
            console.warn('[Sync] Đồng bộ khi chuyển chế độ Online:', e);
          });
          return;
        }

        const res = await googleSignIn();
        if (res) {
          if (res.isIframeRedirect) {
            setIsModeSelectionOpen(false);
            return;
          }
          
          let token = res.accessToken;
          if (!token) {
            console.log('[GoogleAuth] res.accessToken trống, đang gọi getAccessToken() làm fallback...');
            token = await getAccessToken() || '';
          }
          
          if (token) {
            setAppMode('online');
            try {
              localStorage.setItem('app_mode_v2', 'online');
            } catch {}
            setIsModeSelectionOpen(false);
            
            // Cập nhật ngay lập tức thông tin người dùng đang đăng nhập
            const loggedInUser: AuthUser = res.authUser || {
              email: res.user.email || '',
              name: res.user.displayName || 'Người dùng Google',
              photoURL: res.user.photoURL,
              userRole: 'ADMIN',
              isOffline: false,
            };
            setCurrentUser(loggedInUser);
            try {
              localStorage.setItem('library_user_v2', JSON.stringify(loggedInUser));
            } catch {}

            // Auto-Discovery: Nếu máy này chưa có liên kết, quét tìm file có status active trên Drive
            let currentSheet = spreadsheetInfo;
            if (!currentSheet) {
              try {
                const saved = localStorage.getItem('library_spreadsheet_info_v2');
                if (saved) currentSheet = JSON.parse(saved);
              } catch {}
            }

            if (currentSheet && token) {
              const fileStatus = await checkSpreadsheetStatusOnDrive(token, currentSheet.id);
              if (fileStatus.trashed || fileStatus.error === 'FILE_NOT_FOUND') {
                console.warn('[App] File liên kết cũ đã bị xóa trên Drive, tự động hủy liên kết:', currentSheet.name);
                localStorage.removeItem('library_spreadsheet_info_v2');
                removeKnownSpreadsheet(currentSheet.id);
                currentSheet = null;
                setSpreadsheetInfo(null);
              } else {
                setSpreadsheetInfo(currentSheet);
                saveKnownSpreadsheet(currentSheet);
              }
            }

            // Auto-Discovery: Luôn tự động tìm kiếm và liên kết với file active của tài khoản trên Drive
            if (loggedInUser.email) {
              console.log('[AutoDiscover] Đang tìm kiếm file active trên Drive...');
              const discovered = await autoDiscoverSharedSpreadsheets(token, loggedInUser.email);
              if (discovered.length > 0) {
                const activeSheet = discovered[0];
                // Nếu chưa có sheet hoặc sheet hiện tại khác với sheet active trên Drive và máy chưa có dữ liệu sách
                if (!currentSheet || (currentSheet.id !== activeSheet.id && loadLocalBooks().length === 0)) {
                  currentSheet = activeSheet;
                  setSpreadsheetInfo(currentSheet);
                  try {
                    localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(currentSheet));
                    localStorage.removeItem('unlinked_spreadsheet_explicitly');
                  } catch {}
                  console.log(`[AutoDiscover] Đã tự động kết nối về file active: "${currentSheet.name}" (${currentSheet.id})`);
                }
              }
            }

            if (currentSheet && currentSheet.id) {
              try {
                const activeRole = await determineCurrentUserRole(token, currentSheet.id, loggedInUser.email || '');
                setCurrentUser(prev => prev ? { ...prev, userRole: activeRole } : { ...loggedInUser, userRole: activeRole });
                await syncWithGoogleDrive(books);
              } catch (syncErr) {
                console.warn('[GoogleAuth] Lỗi đồng bộ khởi động sau đăng nhập:', syncErr);
              }
            } else {
              console.log('[GoogleAuth] Đăng nhập thành công. Chưa có file nào được liên kết.');
            }
          } else {
            console.warn('[GoogleAuth] Không thể lấy được token từ cả res.accessToken lẫn getAccessToken()');
          }
        }
      } catch (err: any) {
        if (err?.code === 'auth/popup-closed-by-user' || /popup-closed-by-user/i.test(err?.message || '')) {
          console.log('[GoogleAuth] Người dùng đã hủy hoặc đóng popup đăng nhập.');
          return;
        }
        if (err?.code === 'auth/unauthorized-domain' || /unauthorized-domain/i.test(err?.message || '')) {
          console.warn('[GoogleAuth] Tên miền chưa được khai báo Authorized Domains trong Firebase Console.');
          return;
        }
        if (err?.code === 'auth/popup-blocked' || /popup-blocked/i.test(err?.message || '')) {
          console.warn('[GoogleAuth] Trình duyệt chặn popup đăng nhập.');
          return;
        }
        console.error('[GoogleAuth] Đăng nhập Google thất bại:', err);
      }
    }
  };

  // Đăng xuất Google & Chuyển về Offline
  const handleGoogleLogout = async () => {
    await googleLogout();
    setCurrentUser(null);
    setSpreadsheetInfo(null);
    setAppMode('offline');
    try {
      localStorage.setItem('app_mode_v2', 'offline');
      localStorage.removeItem('library_spreadsheet_info_v2');
    } catch {}
  };

  // Hỗ trợ Tự Động Kích Hoạt Đăng Nhập khi chuyển tiếp từ Iframe sang Tab mới
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autoLogin') === 'true') {
      console.log('[AutoLogin] Phát hiện tham số autoLogin, tự động khởi chạy đăng nhập Google...');
      // Xóa tham số khỏi URL để giữ URL đẹp mắt
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('autoLogin');
      window.history.replaceState({}, '', newUrl.toString());

      // Tự động kích hoạt đăng nhập online
      handleSelectMode('online');
    }
  }, [handleSelectMode]);

  // Tự động khôi phục thông tin Profile của Google nếu đang ở chế độ online nhưng chưa có ảnh/tên
  useEffect(() => {
    (async () => {
      if (appMode !== 'online') return;
      const token = await getAccessToken();
      if (!token) return;

      if (!currentUser || !currentUser.email) {
        try {
          const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (resp.ok) {
            const info = await resp.json();
            const u: AuthUser = {
              email: info.email || '',
              name: info.name || 'Người dùng Google',
              photoURL: info.picture,
              userRole: 'ADMIN',
              isOffline: false,
            };
            setCurrentUser(u);
            try {
              localStorage.setItem('library_user_v2', JSON.stringify(u));
            } catch {}
          }
        } catch (err) {
          console.warn('[Profile Recovery] Không tải được userinfo:', err);
        }
      }
    })();
  }, [appMode, currentUser]);

  // 5. Tự động chuẩn hóa dữ liệu ngầm khi bật công tắc gạt và có sách chưa chuẩn hóa
  useEffect(() => {
    if (!settings.autoNormalizeEnabled || isAutoNormalizing || isLoading) return;

    const pending = books.filter((b) => !b.is_ai_normalized);
    if (pending.length === 0) return;

    const runAutoNormalize = async () => {
      setIsAutoNormalizing(true);
      try {
        const batchToProcess = pending.slice(0, 10);
        const { batchNormalize } = await import('./utils/geminiService');
        const result = await batchNormalize(batchToProcess);

        if (result && result.success && Array.isArray(result.normalized) && result.normalized.length > 0) {
          const updatedList = books.map((b) => {
            const found = result.normalized.find((r: any) => r.id === b.id);
            if (found) {
              return {
                ...b,
                title: found.title || b.title,
                author: found.author || b.author,
                category: found.category || b.category,
                publisher: found.publisher || b.publisher,
                is_ai_normalized: true,
                updated_at: Date.now(),
              };
            }
            return b;
          });

          await handleBatchUpdateBooks(updatedList);
          console.log(`[AutoNormalize] Đã tự động chuẩn hóa ${batchToProcess.length} cuốn sách.`);
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
  }, [books, settings.autoNormalizeEnabled, isAutoNormalizing, isLoading, settings.categoriesList]);

  // Kiểm tra cập nhật thủ công khi người dùng bấm nút (Chỉ khả dụng ở bản APK)
  const handleManualCheckUpdates = async () => {
    if (IS_BUILD_AAB) return;
    try {
      const res = await checkForUpdate(true);
      if (!res.hasUpdate) {
        showToast(`Bạn đang sử dụng phiên bản mới nhất (v${res.currentVersion})!`, 'success');
      }
    } catch {
      showToast('Không thể kết nối đến máy chủ kiểm tra cập nhật.', 'warning');
    }
  };

  // Lưu 1 cuốn sách (Lưu máy + Đẩy lên Google Drive nếu Online)
  const handleSaveBook = async (book: BookRecord) => {
    if (currentUser?.userRole === 'VIEWER') {
      showToast('⚠️ Bạn đang ở chế độ CHỈ XEM (Viewer). Không có quyền Thêm/Sửa sách!', 'warning');
      return;
    }
    const updatedBooks = upsertLocalBook(book);
    setBooks(updatedBooks);
    showToast('Đã lưu sách thành công!', 'success');
    if (appMode === 'online') {
      syncWithGoogleDrive(updatedBooks).catch(() => {});
    }
  };

  // Xóa 1 cuốn sách
  const handleDeleteBook = async (id: string) => {
    if (currentUser?.userRole === 'VIEWER') {
      showToast('⚠️ Bạn đang ở chế độ CHỈ XEM (Viewer). Không có quyền Xóa sách!', 'warning');
      return;
    }
    const updatedBooks = deleteLocalBook(id);
    setBooks(updatedBooks);
    showToast('Đã xóa cuốn sách khỏi kho!', 'info');
    if (appMode === 'online' && spreadsheetInfo?.id) {
      const token = await getAccessToken();
      if (token) {
        saveBooksToGoogleSheet(token, spreadsheetInfo.id, updatedBooks).catch((err) => {
          console.warn('[DeleteBook] Lỗi cập nhật Google Sheet:', err);
        });
      }
    }
  };

  // Cập nhật hàng loạt (chuẩn hóa AI / sửa nhanh)
  const handleBatchUpdateBooks = async (updatedBooksList: BookRecord[]) => {
    if (currentUser?.userRole === 'VIEWER') {
      showToast('⚠️ Bạn đang ở chế độ CHỈ XEM (Viewer). Không có quyền cập nhật sách!', 'warning');
      return;
    }
    const saved = batchUpsertLocalBooks(updatedBooksList);
    setBooks(saved);
    if (appMode === 'online' && spreadsheetInfo?.id) {
      const token = await getAccessToken();
      if (token) {
        saveBooksToGoogleSheet(token, spreadsheetInfo.id, saved).catch((err) => {
          console.warn('[BatchUpdate] Lỗi cập nhật Google Sheet:', err);
        });
      }
    }
  };

  // Xóa hàng loạt (Dọn trùng lặp / Dọn nhiều cuốn)
  const handleBatchDeleteBooks = async (idsToDelete: string[]) => {
    if (currentUser?.userRole === 'VIEWER') {
      showToast('⚠️ Bạn đang ở chế độ CHỈ XEM (Viewer). Không có quyền xóa sách hàng loạt!', 'warning');
      return;
    }
    const saved = batchDeleteLocalBooks(idsToDelete);
    setBooks(saved);
    if (appMode === 'online' && spreadsheetInfo?.id) {
      const token = await getAccessToken();
      if (token) {
        try {
          await saveBooksToGoogleSheet(token, spreadsheetInfo.id, saved);
          console.log(`[BatchDelete] Đã lưu danh sách sách đã dọn lên Google Drive (${saved.length} cuốn).`);
        } catch (err) {
          console.warn('[BatchDelete] Lỗi đồng bộ xóa lên Google Drive:', err);
        }
      }
    }
  };

  // Xóa sạch bộ nhớ máy LƯU Ý: CHỈ xóa trên ứng dụng & LocalStorage máy, TUYỆT ĐỐI KHÔNG đồng bộ ngược lên Google Drive
  const handleClearLocalBooksOnly = async () => {
    if (currentUser?.userRole === 'VIEWER') {
      showToast('⚠️ Bạn đang ở chế độ CHỈ XEM (Viewer). Không có quyền xóa sạch thư viện!', 'warning');
      return;
    }
    await deepClearAllApplicationData();
    setBooks([]);
    setSettings(loadLocalSettings());
    setAppMode('offline');
    setIsModeSelectionOpen(true);
    setCurrentUser(null);
    setSpreadsheetInfo(null);
    showToast('Đã dọn sạch 100% dữ liệu sách và cài đặt trên thiết bị!', 'info');
  };

  // Nạp sách nhập từ Smart Importer (Excel, Ảnh OCR, Google Sheet)
  const handleImportBooks = async (
    importedBooks: BookRecord[],
    replace = false
  ): Promise<{ addedCount: number; skippedCount: number }> => {
    if (currentUser?.userRole === 'VIEWER') {
      showToast('⚠️ Bạn đang ở chế độ CHỈ XEM (Viewer). Không có quyền nạp/nhập sách mới!', 'warning');
      return { addedCount: 0, skippedCount: importedBooks.length };
    }
    let finalBooks: BookRecord[];
    let addedCount = 0;

    if (replace) {
      saveAllLocalBooks(importedBooks);
      finalBooks = importedBooks;
      addedCount = importedBooks.length;
    } else {
      finalBooks = batchUpsertLocalBooks(importedBooks);
      addedCount = importedBooks.length;
    }

    setBooks(finalBooks);
    if (appMode === 'online') {
      syncWithGoogleDrive(finalBooks).catch(() => {});
    }

    return { addedCount, skippedCount: 0 };
  };

  // Lưu cài đặt
  const handleSaveSettings = async (newSettings: LibrarySettings) => {
    saveLocalSettings(newSettings);
    setSettings(newSettings);
    showToast('Đã lưu cấu hình cài đặt thành công!', 'success');
  };

  const currentCategories = settings.categoriesList && settings.categoriesList.length > 0
    ? settings.categoriesList
    : DEFAULT_CATEGORIES;

  if (isModeSelectionOpen) {
    return (
      <>
        <ModeSelectionModal
          isOpen={true}
          onSelectMode={handleSelectMode}
          currentMode={appMode}
          onClose={() => setIsModeSelectionOpen(false)}
          canClose={Boolean(localStorage.getItem('app_mode_v2'))}
          onCheckUpdates={!IS_BUILD_AAB ? handleManualCheckUpdates : undefined}
        />
        {!IS_BUILD_AAB && isUpdateModalOpen && (
          <Suspense fallback={null}>
            <AppUpdateModal
              isOpen={isUpdateModalOpen}
              currentVersion={CURRENT_APP_VERSION}
              updateInfo={updateInfo}
              onClose={closeUpdateModal}
            />
          </Suspense>
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[#f1f5f9] text-slate-900 flex flex-col font-sans pb-11 xl:pb-0">
      {/* Navbar Header & Bottom Dock */}
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
        onOpenModeModal={() => setIsModeSelectionOpen(true)}
        onOpenFamilyShare={() => setIsFamilyShareModalOpen(true)}
        appMode={appMode}
        isSyncingDrive={isSyncingDrive}
        onGoogleSignIn={() => handleSelectMode('online')}
        onGoogleLogout={handleGoogleLogout}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-3 sm:p-5">
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
            onSwitchToScanner={() => setCurrentTab('scanner')}
            appMode={appMode}
            isSyncingDrive={isSyncingDrive}
          />
        )}

        {currentTab === 'scanner' && (
          <Suspense fallback={<div className="py-8 text-center text-sm text-slate-500">Đang tải công cụ quét...</div>}>
          <BatchScanner
            categories={currentCategories}
            existingBooks={books}
            onSaveToLibrary={async (newBooks) => {
              await handleImportBooks(newBooks, false);
              showToast(`🎉 Đã thêm ${newBooks.length} cuốn sách vào kho!`, 'success');
            }}
            onSwitchToTable={() => setCurrentTab('table')}
          />
          </Suspense>
        )}
      </main>

      {/* Modal 1: Thêm/Sửa Sách */}
      <Suspense fallback={null}>
      {isAddEditModalOpen && <AddEditBookModal
        isOpen={isAddEditModalOpen}
        onClose={() => {
          setIsAddEditModalOpen(false);
          setEditingBook(null);
        }}
        onSave={handleSaveBook}
        initialBook={editingBook}
        categories={currentCategories}
        books={books}
      />}

      {/* Modal 2: Đồng Bộ & Nhập Xuất Thông Minh */}
      {isSyncModalOpen && <DataSyncModal
        isOpen={isSyncModalOpen}
        onClose={() => setIsSyncModalOpen(false)}
        books={books}
        onImportBooks={handleImportBooks}
        userEmail={currentUser?.email}
        appMode={appMode}
        onSyncDriveNow={async () => { await syncWithGoogleDrive(books); }}
        isSyncingDrive={isSyncingDrive}
        spreadsheetInfo={spreadsheetInfo}
        onSelectSpreadsheet={async (sheet) => {
          if (!sheet) {
            const token = await getAccessToken();
            if (token && spreadsheetInfo?.id) {
              await updateSheetConfigStatus(token, spreadsheetInfo.id, 'unlinked', currentUser?.email || '');
            }
            setSpreadsheetInfo(null);
            localStorage.removeItem('library_spreadsheet_info_v2');
            localStorage.setItem('unlinked_spreadsheet_explicitly', 'true');
            showToast('Đã hủy liên kết tệp Google Drive thành công.', 'info');
            return;
          }
          
          const token = await getAccessToken();
          if (!token) {
            return;
          }
          setIsSyncingDrive(true);
          try {
            const hasWriteAccess = await verifySpreadsheetWriteAccess(token, sheet.id, currentUser?.email || '');
            if (!hasWriteAccess) {
              showToast(`⚠️ File "${sheet.name}" không tương thích để Đồng bộ 2 chiều (Chỉ có quyền đọc). Hãy tạo file mới hoặc liên kết file do App tạo!`, 'error');
              return;
            }
            setSpreadsheetInfo(sheet);
            localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(sheet));
            localStorage.removeItem('unlinked_spreadsheet_explicitly');
            // Cập nhật trạng thái active lên tab Config ẩn của Google Sheet
            await updateSheetConfigStatus(token, sheet.id, 'active', currentUser?.email || '');
            showToast(`Đã liên kết với Google Sheet: "${sheet.name}"`, 'success');
            await syncWithGoogleDrive(books);
          } catch (err: any) {
            showToast(`Lỗi liên kết: ${err.message || String(err)}`, 'error');
          } finally {
            setIsSyncingDrive(false);
          }
        }}
        onCreateSpreadsheet={async (customTitle) => {
          let token = await getAccessToken();
          if (!token) {
            const res = await googleSignIn();
            token = res?.accessToken || '';
          }
          if (!token) throw new Error('Chưa đăng nhập tài khoản Google.');

          const creatorEmail = currentUser?.email || '';

          try {
            const newSheet = await createNewLibrarySpreadsheet(token, creatorEmail, customTitle);
            setSpreadsheetInfo(newSheet);
            try {
              localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(newSheet));
              localStorage.removeItem('unlinked_spreadsheet_explicitly');
              await updateSheetConfigStatus(token, newSheet.id, 'active', creatorEmail);
            } catch {}
            showToast(`Đã tạo và liên kết Google Sheet mới: "${newSheet.name}"`, 'success');
            await syncWithGoogleDrive(books);
            return newSheet;
          } catch (err: any) {
            console.warn('[onCreateSpreadsheet] Lỗi tạo file, tiến hành tự động làm mới phiên Google Sign-In:', err);
            // Nếu token đã hết hạn hoặc không hợp lệ, tự động gọi đăng nhập làm mới ngầm/popup và thử lại ngay lập tức
            const retryAuth = await googleSignIn().catch(() => null);
            if (retryAuth && retryAuth.accessToken) {
              const freshToken = retryAuth.accessToken;
              const freshEmail = retryAuth.authUser?.email || creatorEmail;
              const newSheet = await createNewLibrarySpreadsheet(freshToken, freshEmail, customTitle);
              setSpreadsheetInfo(newSheet);
              try {
                localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(newSheet));
                localStorage.removeItem('unlinked_spreadsheet_explicitly');
                await updateSheetConfigStatus(freshToken, newSheet.id, 'active', freshEmail);
              } catch {}
              showToast(`Đã tạo và liên kết Google Sheet mới: "${newSheet.name}"`, 'success');
              await syncWithGoogleDrive(books);
              return newSheet;
            }
            throw err;
          }
        }}
      />}

      {/* Modal 3: Cài Đặt Hệ Thống */}
      {isSettingsModalOpen && <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        settings={settings}
        onSaveSettings={handleSaveSettings}
        onCheckUpdates={!IS_BUILD_AAB ? handleManualCheckUpdates : undefined}
        books={books}
        onBatchUpdateBooks={handleBatchUpdateBooks}
        onBatchDeleteBooks={handleBatchDeleteBooks}
        onClearLocalBooksOnly={handleClearLocalBooksOnly}
        isAutoNormalizing={isAutoNormalizing}
        appMode={appMode}
        onSwitchMode={() => setIsModeSelectionOpen(true)}
        onOpenFamilyShare={() => setIsFamilyShareModalOpen(true)}
        currentUser={currentUser}
        onGoogleSignIn={() => handleSelectMode('online')}
        onGoogleLogout={handleGoogleLogout}
      />}

      {/* Modal 5: Chia Sẻ Tủ Sách Gia Đình */}
      {isFamilyShareModalOpen && <FamilyShareModal
        isOpen={isFamilyShareModalOpen}
        onClose={() => setIsFamilyShareModalOpen(false)}
        spreadsheetInfo={spreadsheetInfo}
        currentUser={currentUser}
      />}

      {/* Modal 6: Auto Update (Chỉ khả dụng ở bản APK) */}
      {!IS_BUILD_AAB && isUpdateModalOpen && (
        <AppUpdateModal
          isOpen={isUpdateModalOpen}
          currentVersion={CURRENT_APP_VERSION}
          updateInfo={updateInfo}
          onClose={closeUpdateModal}
        />
      )}
      </Suspense>
    </div>
  );
}
