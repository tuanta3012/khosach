import React, { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { BookRecord, LibrarySettings, AuthUser, UserRole } from './types';
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
  clearAllLocalBooks,
} from './utils/localBooksStorage';
import { Navbar, NavTabType } from './components/Navbar';
import { BookTableView } from './components/BookTableView';
import { SplashScreen } from './components/SplashScreen';
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
  handleTokenErrorAndReauthorize,
} from './services/googleAuthService';
import { setupNetworkRecoveryListener } from './services/networkService';
import {
  findOrCreateLibrarySpreadsheet,
  createNewLibrarySpreadsheet,
  syncBooksTwoWay,
  saveBooksToGoogleSheet,
  determineCurrentUserRole,
  synchronizeDrivePermissionsWithJsonMembers,
  autoDiscoverSharedSpreadsheets,
  autoDiscoverCentralVault,
  tagSpreadsheetAsAppCreated,
  updateSheetConfigStatus,
  fetchSheetConfigMetadata,
  fetchFamilyMembers,
  unlinkWorkspace,
  SpreadsheetInfo,
  verifySpreadsheetWriteAccess,
  checkSpreadsheetStatusOnDrive,
  removeKnownSpreadsheet,
  saveKnownSpreadsheet,
  saveUserApiKeyToSheetConfig,
  syncUserApiKeyWithSheetConfig,
  syncSheetConfigVaultName,
} from './services/driveSyncService';
import { batchNormalize, getStoredGeminiApiKeys, saveStoredGeminiApiKeys } from './utils/geminiService';
import { checkAndHandleFirstLaunch, deepClearAllApplicationData } from './utils/cleanSlateService';
import { syncStartupCloudRulesOnce } from './services/curationLearningService';
import { 
  consumeAssignedFileForMember, 
  publishAssignedFilesForMembers,
  publishAssignedFile,
} from './services/firebaseShareRelayService';
import { log } from './utils/logger';

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

  const [showSplash, setShowSplash] = useState<boolean>(true);

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
          setCurrentUser(null);
          setSpreadsheetInfo(null);
        }
      } catch (e) {
        console.warn('[CleanSlate] Lỗi khởi tạo lần đầu:', e);
      }
    })();
  }, []);

  // Tự động kiểm tra và cập nhật quy tắc đồng thuận từ Cloud Firestore đúng 1 lần duy nhất khi mở app
  useEffect(() => {
    syncStartupCloudRulesOnce().catch((err) => {
      console.warn('[CurationLearning] Startup cloud sync silent warning:', err);
    });
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
  const [settingsInitialExpandKey, setSettingsInitialExpandKey] = useState(false);
  const [isAutoNormalizing, setIsAutoNormalizing] = useState(false);
  const autoNormalizeAttemptsRef = useRef(new Set<string>());
  
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

  // LUỒNG TỰ ĐỘNG KẾT NỐI (AUTO-DISCOVERY & FALLBACK FLOW)
  // Đăng nhập trên bất kỳ thiết bị nào (Web hay APK Android) tự động nhận diện tệp dữ liệu ngầm qua Firestore & Google Drive
  const handleAutoDiscoverAndConnect = useCallback(
    async (token: string, userEmail: string): Promise<SpreadsheetInfo | null> => {
      if (!token || !userEmail) return null;
      setIsSyncingDrive(true);
      try {
        log.info('[AutoConnect] Khởi chạy luồng Auto-Discovery & Firestore Relay cho:', userEmail);
        const discovery = await autoDiscoverCentralVault(token, userEmail);

        if (discovery.matchedSheet) {
          const activeSheet = discovery.matchedSheet;
          const role =
            discovery.role ||
            (await determineCurrentUserRole(token, activeSheet.id, userEmail).catch(() => 'VIEWER' as const));

          log.info(`[AutoConnect] Đã tự động nhận diện file dữ liệu (${discovery.source}):`, activeSheet.id, activeSheet.name, role);

          setSpreadsheetInfo(activeSheet);
          saveKnownSpreadsheet(activeSheet);
          try {
            localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(activeSheet));
            localStorage.removeItem('unlinked_spreadsheet_explicitly');
            localStorage.removeItem('explicitly_unlinked');
          } catch {}

          setCurrentUser((prev) => (prev ? { ...prev, userRole: role } : null));

          // Đồng bộ 2 chiều dữ liệu tức thì
          const localBooks = loadLocalBooks();
          try {
            const syncRes = await syncBooksTwoWay(localBooks, token, activeSheet.id, role);
            if (syncRes.hasChanges || localBooks.length === 0) {
              saveAllLocalBooks(syncRes.mergedBooks);
              setBooks(syncRes.mergedBooks);
              setLastDriveSyncTimestamp();
            }
          } catch (syncErr) {
            log.warn('[AutoConnect] Lỗi đồng bộ dữ liệu sau liên kết:', syncErr);
          }

          // Đồng bộ API key nếu có
          if (role === 'ADMIN' || role === 'EDITOR') {
            const localKeys = getStoredGeminiApiKeys();
            syncUserApiKeyWithSheetConfig(token, activeSheet.id, userEmail, role, localKeys)
              .then((res) => {
                if (res.hasUpdatedLocal) {
                  setSettings((prev) => ({ ...prev, geminiApiKeys: res.syncedKeys }));
                  saveStoredGeminiApiKeys(res.syncedKeys);
                }
              })
              .catch(() => {});
          }

          // Đảm bảo gắn nhãn com.khosach.app và phát hành relay cho thành viên nếu là ADMIN
          tagSpreadsheetAsAppCreated(token, activeSheet.id).catch(() => {});
          if (role === 'ADMIN') {
            fetchFamilyMembers(token, activeSheet.id)
              .then((members) => {
                if (members && members.length > 0) {
                  publishAssignedFilesForMembers(members, activeSheet.id, activeSheet.name, userEmail).catch(() => {});
                }
              })
              .catch(() => {});
          }

          const roleLabel = role === 'ADMIN' ? 'Quản trị viên' : role === 'EDITOR' ? 'Quyền Chỉnh sửa' : 'Quyền Xem';
          showToast(`✨ Đã tự động kết nối với "${activeSheet.name}" (${roleLabel})`, 'success');
          return activeSheet;
        } else {
          log.info('[AutoConnect] Không tìm thấy file active phù hợp trong config.');
          // Nếu có các file gắn nhãn com.khosach.app trên Drive, thông báo và mở modal chọn file
          if (discovery.taggedSheets.length > 0) {
            log.info('[AutoConnect] Tìm thấy', discovery.taggedSheets.length, 'file gắn nhãn com.khosach.app.');
            showToast(`Tìm thấy ${discovery.taggedSheets.length} file Kho Sách trên Drive. Vui lòng chọn file liên kết.`, 'info');
            setIsSyncModalOpen(true);
          }
          return null;
        }
      } catch (err: any) {
        log.warn('[AutoConnect] Lỗi quá trình Auto-Discovery:', err);
        return null;
      } finally {
        setIsSyncingDrive(false);
      }
    },
    [showToast]
  );

  // Khởi tạo Auth listener
  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        const u: AuthUser = {
          email: user.email || '',
          name: user.displayName || 'Người dùng Google',
          photoURL: user.photoURL || undefined,
          userRole: 'ADMIN',
        };
        setCurrentUser(u);

        // NẾU phát hiện phiên Google Auth hợp lệ, tự động chuyển sang chế độ Online và chạy Auto-Discovery
        if (token) {
          setAppMode('online');
          try {
            localStorage.setItem('app_mode_v2', 'online');
          } catch {}

          if (user.email) {
            handleAutoDiscoverAndConnect(token, user.email).catch((e) => {
              log.warn('[InitAuth] Auto-Discovery gặp lỗi:', e);
            });
          }
        } else {
          console.log('[Auth] Chưa có token Google Drive hợp lệ. Giữ trạng thái local offline an toàn.');
        }
      },
      () => {
        // Sign out callback (khi user chủ động đăng xuất hoặc Firebase mất phiên)
        console.log('[Auth] Người dùng đã đăng xuất hoặc mất phiên.');
        setCurrentUser(null);
      }
    );
    return () => unsubscribe();
  }, [handleAutoDiscoverAndConnect]);

  // Hàm Đồng Bộ 2 Chiều với Google Drive (Sheets API v4)
  const syncWithGoogleDrive = useCallback(
    async (currentBooks: BookRecord[]): Promise<BookRecord[]> => {
      if (appMode !== 'online') return currentBooks;

      const token = await getAccessToken();
      if (!token) {
        log.info('[Sync] Chưa có token Google Drive trong bộ nhớ, giữ nguyên dữ liệu máy.');
        return currentBooks;
      }

      setIsSyncingDrive(true);
      
      // Reload spreadsheetInfo from localStorage to ensure we have the latest
      let currentSpreadsheetInfo = spreadsheetInfo;
      try {
        const saved = localStorage.getItem('library_spreadsheet_info_v2');
        log.info('[Sync] Dữ liệu sheet trong localStorage:', saved);
        if (saved) {
          currentSpreadsheetInfo = JSON.parse(saved);
        }
      } catch (e) {
        log.error('[Sync] Lỗi đọc localStorage:', e);
      }

      const sheetInfo = currentSpreadsheetInfo;
      let activeRole = currentUser?.userRole || 'VIEWER';
      try {
        if (!sheetInfo || !sheetInfo.id) {
          log.info('[Sync] Chưa có Google Sheet nào được liên kết (trong bộ nhớ hoặc localStorage). Bỏ qua đồng bộ Drive.');
          setIsSyncingDrive(false);
          return currentBooks;
        }

        log.info(`[Sync] Bắt đầu đồng bộ file "${sheetInfo.name}" (${sheetInfo.id})...`);

        // 0. Xác thực sự tồn tại thực tế của file trên Google Drive trước khi đồng bộ
        const fileStatus = await checkSpreadsheetStatusOnDrive(token, sheetInfo.id);
        if (fileStatus.trashed || fileStatus.error === 'FILE_NOT_FOUND') {
          log.warn(`[Sync] File liên kết "${sheetInfo.name}" (${sheetInfo.id}) đã bị xóa hoặc vào thùng rác trên Drive:`, fileStatus.error);
          saveAllLocalBooks([]);
          setBooks([]);
          setSpreadsheetInfo(null);
          localStorage.removeItem('library_spreadsheet_info_v2');
          localStorage.removeItem('last_drive_sync_time');
          removeKnownSpreadsheet(sheetInfo.id);
          showToast(`⚠️ File "${sheetInfo.name}" đã bị xóa trên Google Drive. Đã hủy liên kết!`, 'warning');
          setIsSyncingDrive(false);
          return currentBooks;
        }

        // Tự động cập nhật tên file hiển thị nếu fileStatus trả về tên thực tế khác với cache
        if (fileStatus.name && fileStatus.name !== sheetInfo.name) {
          log.info(`[Sync] Tên file Google Drive thực tế đã thay đổi: "${sheetInfo.name}" -> "${fileStatus.name}"`);
          const updatedSheet: SpreadsheetInfo = {
            ...sheetInfo,
            name: fileStatus.name,
          };
          setSpreadsheetInfo(updatedSheet);
          saveKnownSpreadsheet(updatedSheet);
          try {
            localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(updatedSheet));
          } catch {}
        }

        let workspaceMetadata = await fetchSheetConfigMetadata(token, sheetInfo.id);
        const userEmailClean = (currentUser?.email || '').trim().toLowerCase();

        if (!workspaceMetadata) {
          log.info('[Sync] Tab __CONFIG__ chưa có dữ liệu hoặc file mới tạo. Khởi tạo cấu hình mặc định...');
          try {
            await updateSheetConfigStatus(token, sheetInfo.id, 'active', currentUser?.email || '', sheetInfo.name);
            workspaceMetadata = await fetchSheetConfigMetadata(token, sheetInfo.id);
          } catch (initErr) {
            log.warn('[Sync] Không thể tự tạo cấu hình ngầm, vẫn tiếp tục đồng bộ sách:', initErr);
          }
        }

        if (workspaceMetadata && (workspaceMetadata.status !== 'active' || workspaceMetadata.lastAction === 'unlink')) {
          const adminEmailClean = (workspaceMetadata.adminEmail || '').trim().toLowerCase();
          const isCurrentUserAdmin = userEmailClean && (userEmailClean === adminEmailClean || !adminEmailClean);

          if (isCurrentUserAdmin) {
            // Admin đang chủ động đồng bộ: Tự động kích hoạt lại Workspace
            log.info('[Sync] Admin tái kích hoạt Workspace. Đang cập nhật trạng thái active lên Drive...');
            await updateSheetConfigStatus(token, sheetInfo.id, 'active', currentUser?.email || '', sheetInfo.name).catch(() => {});
          } else {
            // Chỉ thành viên thường (Editor/Viewer) mới bị xóa dữ liệu khi Admin hủy liên kết
            log.info('[Sync] Workspace đã bị Admin hủy liên kết; xóa dữ liệu Workspace cục bộ của thành viên.');
            saveAllLocalBooks([]);
            setBooks([]);
            setSpreadsheetInfo(null);
            localStorage.removeItem('library_spreadsheet_info_v2');
            localStorage.removeItem('last_drive_sync_time');
            removeKnownSpreadsheet(sheetInfo.id);
            showToast('⚡ Admin đã hủy liên kết Workspace. Thiết bị này đã ngắt kết nối và xóa dữ liệu Workspace cục bộ.', 'warning');
            return [];
          }
        }

        // 1. Dynamic Authorization: Xác thực chéo vai trò thực tế từ Tab Config ẩn
        activeRole = await determineCurrentUserRole(token, sheetInfo.id, currentUser?.email || '');
        if (currentUser && currentUser.userRole !== activeRole) {
          log.info(`[Sync] Cập nhật vai trò thành viên thực tế: ${currentUser.userRole} -> ${activeRole}`);
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

        // 3. Nếu là ADMIN (Owner), chạy kiểm toán và dọn dẹp quyền vật lý rác trên Google Drive & đồng bộ relay Firestore
        const liveDriveName = fileStatus.name || sheetInfo.name;
        if (activeRole === 'ADMIN') {
          // Tự động đồng bộ Vault Name & Metadata trong Tab __CONFIG__ với tên thực tế trên Google Drive
          if (liveDriveName && (!workspaceMetadata || workspaceMetadata.activeFileName !== liveDriveName)) {
            log.info(`[Sync] Quản trị viên tự động cập nhật Vault Name trong Sheet thành "${liveDriveName}"...`);
            syncSheetConfigVaultName(token, sheetInfo.id, liveDriveName, currentUser?.email || '').catch((e) => {
              log.warn('[Sync] Đồng bộ Vault Name với Drive thất bại:', e);
            });
          }

          synchronizeDrivePermissionsWithJsonMembers(token, sheetInfo.id, currentUser?.email || '')
            .then(() => log.info('[Sync] Đã tự động dọn dẹp và kiểm toán quyền truy cập Drive thành công.'))
            .catch((err) => log.warn('[Sync] Kiểm toán quyền Drive thất bại:', err));

          // Tự động đảm bảo tất cả thành viên trong Workspace có bản ghi relay trên Firestore (Zero-UI)
          if (currentUser?.email) {
            fetchFamilyMembers(token, sheetInfo.id)
              .then((members) => {
                if (members && members.length > 0) {
                  publishAssignedFilesForMembers(
                    members,
                    sheetInfo.id,
                    liveDriveName || sheetInfo.name || 'Kho Sách',
                    currentUser.email
                  ).catch((rErr) => log.warn('[Sync] Tự động phát hành relay thất bại:', rErr));
                }
              })
              .catch(() => {});
          }
        }

        // 3b. Tự động đồng bộ 2 chiều Gemini API Key của Admin/Editor với Sheet Config
        if ((activeRole === 'ADMIN' || activeRole === 'EDITOR') && currentUser?.email) {
          const localKeys = getStoredGeminiApiKeys();
          syncUserApiKeyWithSheetConfig(token, sheetInfo.id, currentUser.email, activeRole, localKeys)
            .then((keyRes) => {
              if (keyRes.hasUpdatedLocal) {
                setSettings((prev) => ({ ...prev, geminiApiKeys: keyRes.syncedKeys }));
                saveStoredGeminiApiKeys(keyRes.syncedKeys);
              }
            })
            .catch((err) => log.warn('[Sync] Đồng bộ API Key trong 2-way sync thất bại:', err));
        }

        saveAllLocalBooks(syncRes.mergedBooks);
        setBooks(syncRes.mergedBooks);
        setLastDriveSyncTimestamp();
        log.info(`[Sync] Đồng bộ thành công: Tổng cộng ${syncRes.mergedBooks.length} cuốn sách.`);
        showToast(`🚀 Đã đồng bộ thành công ${syncRes.mergedBooks.length} sách với Google Drive!`, 'success');
        return syncRes.mergedBooks;
      } catch (err: any) {
        log.error('[Sync] Đồng bộ Google Drive gặp lỗi:', err?.message || String(err));
        if (
          err.message?.includes('404') ||
          err.message?.includes('not found') ||
          err.message?.includes('FILE_NOT_FOUND') ||
          err.message?.includes('FILE_TRASHED') ||
          err.message?.includes('Requested entity was not found') ||
          err.message?.includes('đã bị xóa')
        ) {
          saveAllLocalBooks([]);
          setBooks([]);
          setSpreadsheetInfo(null);
          localStorage.removeItem('library_spreadsheet_info_v2');
          localStorage.removeItem('last_drive_sync_time');
          if (spreadsheetInfo?.id) removeKnownSpreadsheet(spreadsheetInfo.id);
          showToast(`⚠️ File "${spreadsheetInfo?.name || 'liên kết'}" không còn tồn tại trên Google Drive. Đã tự động hủy liên kết!`, 'warning');
          return currentBooks;
        } else if (err.message === 'Tài khoản Google hiện tại không có trong danh sách thành viên của Workspace.') {
          saveAllLocalBooks([]);
          setBooks([]);
          setSpreadsheetInfo(null);
          localStorage.removeItem('library_spreadsheet_info_v2');
          localStorage.removeItem('last_drive_sync_time');
          if (spreadsheetInfo?.id) removeKnownSpreadsheet(spreadsheetInfo.id);
          showToast('⚡ Tài khoản này không còn quyền thành viên Workspace. Đã ngắt kết nối và xóa dữ liệu Workspace cục bộ.', 'warning');
          return [];
        } else if (err.message === 'READ_ONLY_SCOPE_OR_PERMISSION') {
          showToast('⚠️ File này chỉ được cấp quyền Đọc (Read-Only). Đã lấy sách thành công, nhưng không thể đồng bộ 2 chiều ngược lên Drive. Hãy tạo File mới để đồng bộ đầy đủ!', 'warning');
          return currentBooks;
        } else if (
          err.message?.includes('invalid authentication credentials') ||
          err.message?.includes('401') ||
          err.message?.includes('TOKEN_EXPIRED')
        ) {
          log.warn('[Sync] Nhận mã lỗi token (401/hết hạn). Đang thử tự động gia hạn ngầm hoặc xin cấp lại quyền...');
          const freshToken = await handleTokenErrorAndReauthorize();
          if (freshToken) {
            log.info('[Sync] Token đã hoạt động tốt trở lại. Đang tự động tiếp tục đồng bộ...');
            try {
              const retryRes = await syncBooksTwoWay(
                currentBooks,
                freshToken,
                sheetInfo.id,
                activeRole
              );
              saveAllLocalBooks(retryRes.mergedBooks);
              setBooks(retryRes.mergedBooks);
              setLastDriveSyncTimestamp();
              showToast(`🚀 Đã khôi phục và đồng bộ thành công ${retryRes.mergedBooks.length} sách với Google Drive!`, 'success');
              return retryRes.mergedBooks;
            } catch (retryErr: any) {
              log.error('[Sync] Thử lại sau khi khôi phục token thất bại:', retryErr?.message || retryErr);
            }
          } else {
            showToast('⚠️ Không thể xác thực với Google Drive. Kho sách vẫn được lưu an toàn trên máy.', 'warning');
          }
          return currentBooks;
        } else {
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

  // Kiểm tra lại khi app được mở lại và định kỳ để nhận biết unlink/thu hồi quyền từ thiết bị Admin.
  useEffect(() => {
    if (appMode !== 'online' || !spreadsheetInfo?.id) return;

    let checkInProgress = false;
    const checkWorkspaceLink = async () => {
      if (checkInProgress) return;
      checkInProgress = true;
      try {
        const token = await getAccessToken();
        if (!token) return;

        const driveStatus = await checkSpreadsheetStatusOnDrive(token, spreadsheetInfo.id);
        if (driveStatus.error === 'FILE_NOT_FOUND' || driveStatus.trashed) {
          saveAllLocalBooks([]);
          setBooks([]);
          setSpreadsheetInfo(null);
          localStorage.removeItem('library_spreadsheet_info_v2');
          localStorage.removeItem('last_drive_sync_time');
          removeKnownSpreadsheet(spreadsheetInfo.id);
          showToast('⚡ File Workspace không còn được chia sẻ hoặc đã bị xóa. Thiết bị này đã ngắt kết nối.', 'warning');
          return;
        }

        // Tự động cập nhật tên file hiển thị nếu tên thực tế trên Google Drive / Sheets khác với tên đang lưu
        const liveDriveName = driveStatus.name || spreadsheetInfo.name;
        if (driveStatus.name && driveStatus.name !== spreadsheetInfo.name) {
          log.info(`[Workspace] Tự động cập nhật tên file thực tế từ Google Drive: "${spreadsheetInfo.name}" -> "${driveStatus.name}"`);
          const updatedSheet: SpreadsheetInfo = {
            ...spreadsheetInfo,
            name: driveStatus.name,
          };
          setSpreadsheetInfo(updatedSheet);
          saveKnownSpreadsheet(updatedSheet);
          try {
            localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(updatedSheet));
          } catch {}
        }

        const metadata = await fetchSheetConfigMetadata(token, spreadsheetInfo.id);
        const userEmailClean = (currentUser?.email || '').trim().toLowerCase();
        const adminEmailClean = (metadata?.adminEmail || '').trim().toLowerCase();
        const isCurrentUserAdmin = currentUser?.userRole === 'ADMIN' || (userEmailClean && (userEmailClean === adminEmailClean || !adminEmailClean));

        // Nếu người dùng là Quản trị viên và tên trong tab __CONFIG__ chưa cập nhật theo tên thật trên Drive, tự động đồng bộ
        if (isCurrentUserAdmin && metadata && liveDriveName && metadata.activeFileName !== liveDriveName) {
          log.info(`[Workspace] Admin tự động đồng bộ tên thật "${liveDriveName}" vào Tab __CONFIG__ và Firestore Relay...`);
          syncSheetConfigVaultName(token, spreadsheetInfo.id, liveDriveName, currentUser?.email || '').catch((e) => {
            log.warn('[Workspace] Đồng bộ Vault Name với Drive thất bại:', e);
          });
        }

        if (metadata && (metadata.status !== 'active' || metadata.lastAction === 'unlink')) {
          const userEmailClean = (currentUser?.email || '').trim().toLowerCase();
          const adminEmailClean = (metadata.adminEmail || '').trim().toLowerCase();
          const isCurrentUserAdmin = userEmailClean && (userEmailClean === adminEmailClean || !adminEmailClean);

          if (!isCurrentUserAdmin) {
            saveAllLocalBooks([]);
            setBooks([]);
            setSpreadsheetInfo(null);
            localStorage.removeItem('library_spreadsheet_info_v2');
            localStorage.removeItem('last_drive_sync_time');
            removeKnownSpreadsheet(spreadsheetInfo.id);
            showToast('⚡ Admin đã hủy liên kết Workspace. Thiết bị này đã ngắt kết nối và xóa dữ liệu Workspace cục bộ.', 'warning');
          }
        }
      } catch (err) {
        console.warn('[Workspace] Không thể kiểm tra trạng thái liên kết:', err);
      } finally {
        checkInProgress = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkWorkspaceLink();
    };
    const timer = window.setInterval(() => void checkWorkspaceLink(), 60_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    void checkWorkspaceLink();

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [appMode, spreadsheetInfo?.id, showToast]);

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

  // Tự động kiểm tra mạng (Wifi + Mobile Data) và Ping Internet thực tế trước khi đẩy đồng bộ (Auto-Reconnect)
  useEffect(() => {
    const cleanup = setupNetworkRecoveryListener(() => {
      console.log('[Network] Internet thực tế đã được xác nhận. Tiến hành đồng bộ tự động...');
      if (appMode === 'online' && spreadsheetInfo?.id) {
        syncWithGoogleDrive(books).catch((err) => {
          console.warn('[Network] Tự động đồng bộ khi có mạng gặp lỗi:', err);
        });
      }
    });

    return () => {
      cleanup();
    };
  }, [appMode, spreadsheetInfo?.id, books, syncWithGoogleDrive]);

  // Tự động kiểm tra liên kết chuyển tiếp Firestore (Zero-UI) định kỳ cho thành viên (chưa liên kết hoặc Admin đổi file mới)
  useEffect(() => {
    if (appMode !== 'online' || !currentUser?.email) return;
    // Chỉ bỏ qua quét relay nếu ĐÃ CÓ file spreadsheet VÀ người dùng là Quản trị viên (ADMIN) của file đó
    if (spreadsheetInfo?.id && currentUser?.userRole === 'ADMIN') return;

    let isPolling = false;
    const pollRelay = async () => {
      if (isPolling) return;
      isPolling = true;
      try {
        const token = await getAccessToken();
        if (token && currentUser?.email) {
          await handleAutoDiscoverAndConnect(token, currentUser.email);
        }
      } catch (err) {
        log.warn('[ShareRelay] Polling background relay error:', err);
      } finally {
        isPolling = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void pollRelay();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const intervalTimer = setInterval(pollRelay, 15_000);
    void pollRelay();

    return () => {
      clearInterval(intervalTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [appMode, currentUser?.email, currentUser?.userRole, spreadsheetInfo?.id, handleAutoDiscoverAndConnect]);

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
    } else if (selectedMode === 'online') {
      try {
        // KIỂM TRA TRƯỚC: Nếu đã có phiên Google Auth hợp lệ sẵn rồi, chuyển thẳng vào trang và đồng bộ ngay
        const existingToken = await getAccessToken();
        if (existingToken && currentUser) {
          setAppMode('online');
          try {
            localStorage.setItem('app_mode_v2', 'online');
          } catch {}
          await syncWithGoogleDrive(books).catch((e) => {
            console.warn('[Sync] Đồng bộ khi chuyển chế độ Online:', e);
          });
          return;
        }

        const res = await googleSignIn();
        if (res) {
          if (res.isIframeRedirect) {
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
            
            // Cập nhật ngay lập tức thông tin người dùng đang đăng nhập
            const loggedInUser: AuthUser = res.authUser || {
              email: res.user.email || '',
              name: res.user.displayName || 'Người dùng Google',
              photoURL: res.user.photoURL,
              userRole: 'ADMIN',
            };
            setCurrentUser(loggedInUser);
            try {
              localStorage.setItem('library_user_v2', JSON.stringify(loggedInUser));
            } catch {}

            // Tự động nhận diện & kết nối file qua Auto-Discovery & Firestore Relay
            if (loggedInUser.email) {
              await handleAutoDiscoverAndConnect(token, loggedInUser.email);
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

    const pending = books.filter((book) => (
      !book.is_ai_normalized &&
      !autoNormalizeAttemptsRef.current.has(JSON.stringify([
        book.id, book.title, book.author, book.publisher, book.category,
      ]))
    ));
    if (pending.length === 0) return;

    const runAutoNormalize = async () => {
      setIsAutoNormalizing(true);
      try {
        const batchToProcess = pending.slice(0, 10);
        batchToProcess.forEach((book) => {
          autoNormalizeAttemptsRef.current.add(JSON.stringify([
            book.id, book.title, book.author, book.publisher, book.category,
          ]));
        });
        const result = await batchNormalize(batchToProcess, { categories: settings.categoriesList });

        if (result && Array.isArray(result.normalized) && result.normalized.length > 0) {
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
        if (result.failedChunks.length > 0) {
          const failedCount = result.failedChunks.reduce((count, chunk) => count + chunk.bookIds.length, 0);
          showToast(`Tự động hiệu chỉnh chưa xử lý được ${failedCount} cuốn. Có thể thử lại thủ công trong Cài đặt.`, 'warning');
        }
      } catch (err) {
        console.error('[AutoNormalize] Lỗi chuẩn hóa tự động ngầm:', err);
        showToast(`Tự động hiệu chỉnh sách thất bại: ${err instanceof Error ? err.message : String(err)}`, 'warning');
      } finally {
        setTimeout(() => {
          setIsAutoNormalizing(false);
        }, 4000);
      }
    };

    const timer = setTimeout(runAutoNormalize, 2000);
    return () => clearTimeout(timer);
  }, [books, settings.autoNormalizeEnabled, isAutoNormalizing, isLoading, settings.categoriesList, showToast]);

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
      syncWithGoogleDrive(updatedBooks)
        .then(() => {
          console.info('[SaveBook] Sách đã được lưu và đồng bộ lên Google Drive thành công.');
        })
        .catch((err) => {
          console.warn('[SaveBook] Lỗi đẩy sách lên Google Drive:', err);
          showToast(`⚠️ Sách đã lưu vào máy nhưng chưa lên Google Drive: ${err.message || String(err)}`, 'warning');
        });
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
    if (appMode === 'online') {
      syncWithGoogleDrive(updatedBooks)
        .then(() => {
          console.info('[DeleteBook] Sách đã được xóa và đồng bộ 2 chiều với Google Drive.');
        })
        .catch((err) => {
          console.warn('[DeleteBook] Lỗi đồng bộ 2 chiều lên Google Drive:', err);
          showToast(`⚠️ Đã xóa trên máy nhưng đồng bộ Drive lỗi: ${err.message || String(err)}`, 'warning');
        });
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
    if (appMode === 'online') {
      syncWithGoogleDrive(saved)
        .then(() => {
          console.info('[BatchUpdate] Sách đã được cập nhật và đồng bộ 2 chiều với Google Drive.');
        })
        .catch((err) => {
          console.warn('[BatchUpdate] Lỗi đồng bộ 2 chiều lên Google Drive:', err);
        });
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
    if (appMode === 'online') {
      syncWithGoogleDrive(saved)
        .then(() => {
          console.info('[BatchDelete] Sách đã được dọn dẹp và đồng bộ 2 chiều với Google Drive.');
        })
        .catch((err) => {
          console.warn('[BatchDelete] Lỗi đồng bộ 2 chiều lên Google Drive:', err);
        });
    }
  };

  // Xóa sạch bộ nhớ máy LƯU Ý: CHỈ xóa trên ứng dụng & LocalStorage máy, TUYỆT ĐỐI KHÔNG đồng bộ ngược lên Google Drive
  const handleClearLocalBooksOnly = async () => {
    if (currentUser?.userRole === 'VIEWER') {
      showToast('⚠️ Bạn đang ở chế độ CHỈ XEM (Viewer). Không có quyền xóa sạch thư viện!', 'warning');
      return;
    }
    clearAllLocalBooks();
    setBooks([]);
    setAppMode('offline');
    try {
      localStorage.setItem('app_mode_v2', 'offline');
    } catch {}
    showToast('Đã xóa toàn bộ sách trên thiết bị!', 'info');
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

    // Đồng bộ API Key lên Google Sheet Config nếu người dùng là Admin hoặc Editor
    if (
      currentUser &&
      (currentUser.userRole === 'ADMIN' || currentUser.userRole === 'EDITOR') &&
      currentUser.email &&
      spreadsheetInfo?.id
    ) {
      try {
        const token = await getAccessToken();
        if (token) {
          const updatedKeys = newSettings.geminiApiKeys || getStoredGeminiApiKeys();
          const synced = await saveUserApiKeyToSheetConfig(
            token,
            spreadsheetInfo.id,
            currentUser.email,
            updatedKeys,
            currentUser.userRole
          );
          if (synced) {
            console.log('[Settings] Đã lưu & đồng bộ API Key lên Sheet Config thành công');
            showToast('Đã lưu cấu hình & đồng bộ API Key lên Google Sheet!', 'success');
            return;
          }
        }
      } catch (keySyncErr) {
        console.warn('[Settings] Lỗi đồng bộ API Key lên Sheet Config:', keySyncErr);
      }
    }

    showToast('Đã lưu cấu hình cài đặt thành công!', 'success');
  };

  const currentCategories = settings.categoriesList && settings.categoriesList.length > 0
    ? settings.categoriesList
    : DEFAULT_CATEGORIES;

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
        onOpenFamilyShare={() => setIsFamilyShareModalOpen(true)}
        appMode={appMode}
        isSyncingDrive={isSyncingDrive}
        hasLinkedSpreadsheet={!!spreadsheetInfo?.id}
        spreadsheetInfo={spreadsheetInfo}
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
            onOpenSettingsKey={() => {
              setSettingsInitialExpandKey(true);
              setIsSettingsModalOpen(true);
            }}
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
        onSignInGoogle={() => handleSelectMode('online')}
        onSyncDriveNow={async () => { await syncWithGoogleDrive(books); }}
        isSyncingDrive={isSyncingDrive}
        spreadsheetInfo={spreadsheetInfo}
        canUnlinkWorkspace={currentUser?.userRole === 'ADMIN'}
        canManageDriveFiles={currentUser?.userRole === 'ADMIN'}
        onSelectSpreadsheet={async (sheet) => {
          if (!sheet) {
            setSpreadsheetInfo(null);
            localStorage.removeItem('library_spreadsheet_info_v2');
            localStorage.setItem('unlinked_spreadsheet_explicitly', 'true');
            return;
          }
          
          const token = await getAccessToken();
          if (!token) {
            return;
          }
          setIsSyncingDrive(true);
          try {
            const userEmail = currentUser?.email || '';
            const role: UserRole = await determineCurrentUserRole(token, sheet.id, userEmail).catch(() => 'VIEWER');

            log.info('[SelectSheet] Đang lưu vào localStorage:', sheet.id, sheet.name);
            setSpreadsheetInfo(sheet);
            localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(sheet));
            localStorage.removeItem('unlinked_spreadsheet_explicitly');

            // Gắn nhãn com.khosach.app lên Google Drive
            tagSpreadsheetAsAppCreated(token, sheet.id).catch(() => {});

            // Cập nhật trạng thái active lên tab Config ẩn của Google Sheet nếu không phải viewer
            if (role !== 'VIEWER') {
              await updateSheetConfigStatus(token, sheet.id, 'active', userEmail).catch(() => {});
            }

            setCurrentUser((prev) => (prev ? { ...prev, userRole: role } : null));
            await syncWithGoogleDrive(books);

            const roleLabel = role === 'ADMIN' ? 'Quản trị viên' : role === 'EDITOR' ? 'Quyền Chỉnh sửa' : 'Quyền Xem';
            showToast(`✨ Đã tự động liên kết với "${sheet.name}" (${roleLabel})`, 'success');

            // Tự động phát hành relay cho toàn bộ thành viên trong file vừa liên kết
            if (currentUser?.email) {
              fetchFamilyMembers(token, sheet.id)
                .then((members) => {
                  if (members && members.length > 0) {
                    publishAssignedFilesForMembers(
                      members,
                      sheet.id,
                      sheet.name || 'Kho Sách',
                      currentUser.email
                    ).catch(() => {});
                  }
                })
                .catch(() => {});
            }
          } catch (err: any) {
            showToast(`Lỗi liên kết: ${err.message || String(err)}`, 'error');
          } finally {
            setIsSyncingDrive(false);
          }
        }}
        onUnlinkWorkspace={async () => {
          if (currentUser?.userRole !== 'ADMIN' || !currentUser.email || !spreadsheetInfo?.id) {
            throw new Error('Chỉ Admin của Workspace mới có thể hủy liên kết.');
          }
          const token = await getAccessToken();
          if (!token) throw new Error('Phiên đăng nhập Google đã hết hạn.');
          const unlinkResult = await unlinkWorkspace(token, spreadsheetInfo.id, currentUser.email);
          saveAllLocalBooks([]);
          setBooks([]);
          setSpreadsheetInfo(null);
          localStorage.removeItem('library_spreadsheet_info_v2');
          localStorage.removeItem('last_drive_sync_time');
          removeKnownSpreadsheet(spreadsheetInfo.id);
          if (unlinkResult.failedRevocations.length > 0) {
            showToast(`Đã hủy liên kết, nhưng chưa thu hồi được quyền Drive của: ${unlinkResult.failedRevocations.join(', ')}. Trạng thái Workspace đã được cập nhật.`, 'warning');
          } else {
            showToast('Đã hủy liên kết Workspace và thu hồi quyền của các thành viên.', 'success');
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
            tagSpreadsheetAsAppCreated(token, newSheet.id).catch(() => {});
            setSpreadsheetInfo(newSheet);
            try {
              localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(newSheet));
              localStorage.removeItem('unlinked_spreadsheet_explicitly');
              await updateSheetConfigStatus(token, newSheet.id, 'active', creatorEmail, newSheet.name);
            } catch {}
            setCurrentUser((prev) => (prev ? { ...prev, userRole: 'ADMIN' } : null));
            showToast(`Đã tạo và liên kết Google Sheet mới: "${newSheet.name}"`, 'success');
            await syncWithGoogleDrive(books);

            // Tự động phát hành relay cho toàn bộ thành viên
            if (creatorEmail) {
              fetchFamilyMembers(token, newSheet.id)
                .then((members) => {
                  if (members && members.length > 0) {
                    publishAssignedFilesForMembers(members, newSheet.id, newSheet.name, creatorEmail).catch(() => {});
                  }
                })
                .catch(() => {});
            }
            return newSheet;
          } catch (err: any) {
            console.warn('[onCreateSpreadsheet] Lỗi tạo file, tiến hành tự động làm mới phiên Google Sign-In:', err);
            // Nếu token đã hết hạn hoặc không hợp lệ, tự động gọi đăng nhập làm mới ngầm/popup và thử lại ngay lập tức
            const retryAuth = await googleSignIn().catch(() => null);
            if (retryAuth && retryAuth.accessToken) {
              const freshToken = retryAuth.accessToken;
              const freshEmail = retryAuth.authUser?.email || creatorEmail;
              const newSheet = await createNewLibrarySpreadsheet(freshToken, freshEmail, customTitle);
              tagSpreadsheetAsAppCreated(freshToken, newSheet.id).catch(() => {});
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
        onClose={() => {
          setIsSettingsModalOpen(false);
          setSettingsInitialExpandKey(false);
        }}
        initialExpandKeySection={settingsInitialExpandKey}
        settings={settings}
        onSaveSettings={handleSaveSettings}
        onCheckUpdates={!IS_BUILD_AAB ? handleManualCheckUpdates : undefined}
        books={books}
        onBatchUpdateBooks={handleBatchUpdateBooks}
        onBatchDeleteBooks={handleBatchDeleteBooks}
        onClearLocalBooksOnly={handleClearLocalBooksOnly}
        isAutoNormalizing={isAutoNormalizing}
        appMode={appMode}
        onOpenFamilyShare={() => setIsFamilyShareModalOpen(true)}
        currentUser={currentUser}
        onGoogleSignIn={() => handleSelectMode('online')}
        onGoogleLogout={handleGoogleLogout}
        spreadsheetInfo={spreadsheetInfo}
      />}

      {/* Modal 5: Chia Sẻ Tủ Sách Gia Đình */}
      {isFamilyShareModalOpen && <FamilyShareModal
        isOpen={isFamilyShareModalOpen}
        onClose={() => setIsFamilyShareModalOpen(false)}
        spreadsheetInfo={spreadsheetInfo}
        currentUser={currentUser}
      />}

      {/* SplashScreen khi khởi động ứng dụng */}
      {showSplash && (
        <SplashScreen onFinished={() => setShowSplash(false)} minDurationMs={2400} />
      )}

      {/* Modal 7: Auto Update (Chỉ khả dụng ở bản APK) */}
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
