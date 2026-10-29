import { Preferences } from '@capacitor/preferences';

/**
 * 1. HÀM DỌN SẠCH TOÀN DIỆN MỌI DỮ LIỆU CỤC BỘ (DEEP CLEAN SLATE)
 * Gọi hàm này khi: Đăng xuất, Hủy liên kết, hoặc người dùng muốn Reset dữ liệu sạch 100%
 */
export async function deepClearAllApplicationData(): Promise<void> {
  try {
    console.info('[Storage Cleanup] Đang tiến hành xóa sạch dữ liệu đa tầng...');

    // TẦNG 1: Dọn sạch Web Storage (localStorage, sessionStorage)
    if (typeof window !== 'undefined') {
      localStorage.clear();
      sessionStorage.clear();
      // Đánh dấu rõ ràng cờ đã dọn sạch dữ liệu
      localStorage.setItem('app_data_clean_slate', 'true');
    }

    // TẦNG 2: Dọn sạch Capacitor Preferences (Tương đương SharedPreferences trên Android)
    try {
      await Preferences.clear();
    } catch (prefErr) {
      console.warn('[Storage Cleanup] Lỗi dọn Preferences:', prefErr);
    }

    // TẦNG 3: Nếu có dùng IndexedDB của WebView, dọn dẹp toàn bộ IndexedDB
    if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
      try {
        const dbs = await indexedDB.databases();
        for (const dbInfo of dbs) {
          if (dbInfo.name) {
            indexedDB.deleteDatabase(dbInfo.name);
          }
        }
      } catch (idbErr) {
        console.warn('[Storage Cleanup] Lỗi dọn IndexedDB:', idbErr);
      }
    }

    console.info('[Storage Cleanup] Đã dọn dẹp sạch sẽ 100% dữ liệu!');
  } catch (err) {
    console.warn('[Storage Cleanup] Lỗi trong quá trình dọn dẹp bộ nhớ:', err);
  }
}

/**
 * 2. CƠ CHẾ KIỂM SOÁT PHIÊN BẢN & PHÁT HIỆN CÀI ĐẶT MỚI (FIRST INSTALL CHECK)
 * Chạy ngay khi ứng dụng vừa mount (ở App.tsx hoặc main.tsx)
 */
export async function checkAndHandleFirstLaunch(currentAppVersion: string): Promise<boolean> {
  try {
    const LAST_VERSION_KEY = 'app_installed_version_tracker';
    const { value: lastVersion } = await Preferences.get({ key: LAST_VERSION_KEY });

    // Trường hợp 1: Lần đầu tiên cài đặt app trên thiết bị mới
    if (!lastVersion) {
      console.info(`[App Init] Phát hiện lần đầu mở app (Bản ${currentAppVersion}). Đảm bảo bộ nhớ sạch...`);
      // Đảm bảo không có dữ liệu rác nào từ bản sao lưu cũ sót lại
      await deepClearAllApplicationData();
      await Preferences.set({ key: LAST_VERSION_KEY, value: currentAppVersion });
      return true; // Is First Launch
    }

    // Trường hợp 2: Nâng cấp phiên bản (Update Version)
    if (lastVersion !== currentAppVersion) {
      console.info(`[App Init] Phát hiện cập nhật từ bản ${lastVersion} lên ${currentAppVersion}`);
      await Preferences.set({ key: LAST_VERSION_KEY, value: currentAppVersion });
    }

    return false;
  } catch (err) {
    console.warn('[App Init] Lỗi khi kiểm tra phiên bản khởi động:', err);
    return false;
  }
}
