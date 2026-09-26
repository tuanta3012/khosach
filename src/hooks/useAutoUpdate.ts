import { useState, useCallback } from 'react';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { CURRENT_APP_VERSION } from '../version';

export interface RemoteVersionInfo {
  version: string;
  notes?: string;
  apkUrl?: string;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  notes: string;
  apkUrl: string;
}

/**
 * So sánh 2 chuỗi version dạng semver (ví dụ '1.0.2' so với '1.0.0')
 * Trả về: 1 nếu v1 > v2, -1 nếu v1 < v2, 0 nếu bằng nhau
 */
export function compareVersions(v1: string, v2: string): number {
  const clean1 = (v1 || '').replace(/[^0-9.]/g, '').split('.').map(Number);
  const clean2 = (v2 || '').replace(/[^0-9.]/g, '').split('.').map(Number);
  
  const len = Math.max(clean1.length, clean2.length);
  for (let i = 0; i < len; i++) {
    const num1 = clean1[i] || 0;
    const num2 = clean2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/**
 * Lấy URL API đầy đủ hỗ trợ cả Web và môi trường di động Capacitor
 */
const getApiUrl = (path: string): string => {
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    if (origin.includes('localhost') || origin.includes('127.0.0.1') || origin.startsWith('file:')) {
      return `https://ais-pre-6xd4hn5ourvlmjugqheam6-546075383474.asia-southeast1.run.app${path}`;
    }
    return `${origin}${path}`;
  }
  return path;
};

export function useAutoUpdate() {
  const [isChecking, setIsChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const checkForUpdate = useCallback(async (isManual = false): Promise<UpdateCheckResult> => {
    setIsChecking(true);
    let appVersion = CURRENT_APP_VERSION;

    // Lấy version thực tế từ Capacitor App plugin nếu đang chạy trên thiết bị di động
    try {
      const isNative = (window as any).Capacitor && (window as any).Capacitor.isNativePlatform();
      if (isNative) {
        const info = await App.getInfo();
        if (info && info.version) {
          appVersion = info.version;
          console.log(`[useAutoUpdate] Lấy phiên bản thiết bị di động thành công: v${appVersion}`);
        }
      }
    } catch (err) {
      console.warn('[useAutoUpdate] Không thể gọi Capacitor App.getInfo() (Đang chạy trên môi trường Web)', err);
    }

    // Các nguồn tải version.json: Ưu tiên Server-Side Proxy để chống CORS và chặn mạng, sau đó dự phòng bằng Github Raw trực tiếp
    const sources = [
      {
        name: 'Máy chủ Proxy (Khuyên dùng)',
        url: getApiUrl('/api/app-update/check'),
        isProxy: true
      },
      {
        name: 'GitHub Raw (Đường dẫn chính thức)',
        url: `https://raw.githubusercontent.com/tuanta3012/khosach/refs/heads/main/version.json?t=${Date.now()}`,
        isProxy: false
      },
      {
        name: 'GitHub Raw (Đường dẫn dự phòng)',
        url: `https://raw.githubusercontent.com/tuanta3012/khosach/main/version.json?t=${Date.now()}`,
        isProxy: false
      }
    ];

    let fetchedData: RemoteVersionInfo | null = null;

    for (const src of sources) {
      try {
        console.log(`[useAutoUpdate] Thử tải dữ liệu từ: ${src.name} (${src.url})`);
        const response = await fetch(src.url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Cache-Control': 'no-cache',
          },
        });

        if (response.ok) {
          const result = await response.json();
          if (src.isProxy) {
            if (result && result.success && result.version) {
              fetchedData = {
                version: result.version,
                notes: result.notes,
                apkUrl: result.apkUrl
              };
            }
          } else {
            if (result && result.version) {
              fetchedData = result;
            }
          }

          if (fetchedData && fetchedData.version) {
            console.log(`[useAutoUpdate] Tải dữ liệu thành công từ ${src.name}: v${fetchedData.version}`);
            break;
          }
        }
      } catch (err) {
        console.warn(`[useAutoUpdate] Thất bại khi tải từ ${src.name}:`, err);
      }
    }

    setIsChecking(false);

    if (fetchedData && fetchedData.version) {
      const latestVer = fetchedData.version.trim();
      const hasUpdate = compareVersions(latestVer, appVersion) > 0;
      const defaultApkUrl = `https://github.com/tuanta3012/khosach/releases/download/v${latestVer}/khosach_v${latestVer}.apk`;

      const result: UpdateCheckResult = {
        hasUpdate,
        currentVersion: appVersion,
        latestVersion: latestVer,
        notes: fetchedData.notes || `Phiên bản cập nhật mới v${latestVer} với nhiều cải tiến và tối ưu hóa hệ thống.`,
        apkUrl: fetchedData.apkUrl || defaultApkUrl
      };

      setUpdateInfo(result);
      if (hasUpdate) {
        setIsModalOpen(true);
      }
      return result;
    }

    // Nếu fetch hoàn toàn thất bại hoặc không có dữ liệu hợp lệ
    const failedResult: UpdateCheckResult = {
      hasUpdate: false,
      currentVersion: appVersion,
      latestVersion: appVersion,
      notes: '',
      apkUrl: ''
    };
    setUpdateInfo(failedResult);
    return failedResult;
  }, []);

  const openApkDownload = useCallback(async (url: string) => {
    if (!url) return;
    try {
      console.log(`[useAutoUpdate] Đang mở trình duyệt tải APK từ: ${url}`);
      // Ưu tiên sử dụng @capacitor/browser để mở liên kết trong hệ thống để tránh lỗi điều hướng trong webview
      const isNative = (window as any).Capacitor && (window as any).Capacitor.isNativePlatform();
      if (isNative) {
        await Browser.open({ url });
      } else {
        window.open(url, '_blank');
      }
    } catch (err) {
      console.error('[useAutoUpdate] Lỗi mở trình duyệt:', err);
      window.open(url, '_blank');
    }
  }, []);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  return {
    isChecking,
    updateInfo,
    isModalOpen,
    checkForUpdate,
    openApkDownload,
    closeModal
  };
}
