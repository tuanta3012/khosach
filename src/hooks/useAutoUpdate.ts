import { useState, useCallback } from 'react';
import { App } from '@capacitor/app';
import { CURRENT_APP_VERSION } from '../version';
import { UpdateInfo } from '../components/AppUpdateModal';
import { IS_BUILD_AAB } from '../config/buildConfig';

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

export function useAutoUpdate() {
  const [isChecking, setIsChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const checkForUpdate = useCallback(async (isManual = false): Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion: string }> => {
    // Nếu là bản AAB xuất bản lên Google Play Store: Vô hiệu hóa 100% việc kiểm tra và cập nhật APK
    if (IS_BUILD_AAB) {
      console.log('[useAutoUpdate] Chế độ Google Play Store (AAB): Bỏ qua kiểm tra Auto Update.');
      return {
        hasUpdate: false,
        currentVersion: CURRENT_APP_VERSION,
        latestVersion: CURRENT_APP_VERSION,
      };
    }

    setIsChecking(true);
    let appVersion = CURRENT_APP_VERSION;

    let isNative = false;
    // Lấy version thực tế từ Capacitor App plugin nếu đang chạy trên Android
    try {
      isNative = typeof window !== 'undefined' && !!((window as any).Capacitor?.isNativePlatform?.());
      if (isNative) {
        const info = await App.getInfo();
        if (info && info.version) {
          appVersion = info.version;
        }
      }
    } catch (err) {
      console.warn('[useAutoUpdate] Lấy info từ Capacitor skipped:', err);
    }

    const timestamp = Date.now();
    // 100% Client-Side: Kiểm tra trực tiếp qua GitHub Raw version.json
    const updateUrl = `https://raw.githubusercontent.com/tuanta3012/khosach/refs/heads/main/version.json?t=${timestamp}`;

    let latestInfo: UpdateInfo | null = null;

    try {
      console.log(`[useAutoUpdate] Đang kiểm tra cập nhật trực tiếp từ GitHub: ${updateUrl}`);
      const res = await fetch(updateUrl, { cache: 'no-store' });

      if (res.ok) {
        const data = await res.json();
        if (data && data.version) {
          latestInfo = {
            version: data.version.trim(),
            apkUrl: data.apkUrl || `https://github.com/tuanta3012/khosach/releases/download/v${data.version}/khosach_v${data.version}.apk`,
            downloadUrl: data.apkUrl || `https://github.com/tuanta3012/khosach/releases/download/v${data.version}/khosach_v${data.version}.apk`,
            changelog: data.notes ? [data.notes] : ['Bản cập nhật tối ưu hóa hiệu năng và sửa lỗi.'],
            notes: data.notes,
          };
          console.log(`[useAutoUpdate] Kiểm tra thành công! Phiên bản mới nhất trên GitHub là v${latestInfo.version}`);
        }
      }
    } catch (err) {
      console.warn('[useAutoUpdate] Kiểm tra cập nhật từ GitHub thất bại:', err);
    }

    setIsChecking(false);

    if (latestInfo && latestInfo.version) {
      const hasUpdate = compareVersions(latestInfo.version, appVersion) > 0;
      setUpdateInfo(latestInfo);

      const isAiStudioPreview = typeof window !== 'undefined' && window.location.hostname.includes('run.app');

      // Tự động mở modal cập nhật nếu có phiên bản mới
      // (chỉ bỏ qua tự động nẩy popup nếu đang dev trong iframe AI Studio preview)
      if (hasUpdate && (isManual || !isAiStudioPreview)) {
        setIsModalOpen(true);
      }
      return {
        hasUpdate,
        currentVersion: appVersion,
        latestVersion: latestInfo.version,
      };
    }

    return {
      hasUpdate: false,
      currentVersion: appVersion,
      latestVersion: appVersion,
    };
  }, []);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  return {
    isChecking,
    updateInfo,
    isModalOpen,
    checkForUpdate,
    closeModal,
  };
}
