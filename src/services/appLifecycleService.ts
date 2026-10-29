import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { isGoogleTokenValid, trySilentRefresh, getAccessToken } from './googleAuthService';

export interface AppResumeCallback {
  onTokenRefreshed?: (newToken: string) => void;
  onForeground?: () => void;
}

/**
 * Lắng nghe vòng đời của ứng dụng khi người dùng mở lại app từ chạy ngầm (Background -> Foreground)
 * hoặc chuyển đổi tab quay lại màn hình trên Web:
 * - Tự động kiểm tra thời hạn của Token Google
 * - Tự động Silent Refresh ngầm nếu token đã hết hạn
 * - Kích hoạt callback để app cập nhật trạng thái hoặc đồng bộ nếu cần
 */
export function setupAppLifecycleListener(callbacks: AppResumeCallback): () => void {
  let isChecking = false;

  const handleAppResumed = async () => {
    if (isChecking) return;
    isChecking = true;

    try {
      console.log('[AppLifecycle] Ứng dụng đã chuyển về Foreground (hoạt động trở lại). Đang kiểm tra phiên làm việc...');

      // Kiểm tra xem đã từng có phiên đăng nhập trên thiết bị hay chưa
      const hasStoredSession = Boolean(
        localStorage.getItem('google_drive_access_token') ||
        localStorage.getItem('library_user_v2')
      );

      if (hasStoredSession) {
        if (!isGoogleTokenValid()) {
          console.log('[AppLifecycle] Token Google đã hết hạn trong thời gian chạy ngầm. Tiến hành Silent Refresh đón đầu...');
          const newToken = await trySilentRefresh();
          if (newToken) {
            console.log('[AppLifecycle] Silent Refresh đón đầu thành công! Đã có token mới sẵn sàng.');
            callbacks.onTokenRefreshed?.(newToken);
          } else {
            console.log('[AppLifecycle] Chưa thể gia hạn ngầm (có thể mất mạng), giữ nguyên phiên offline.');
          }
        } else {
          console.log('[AppLifecycle] Token Google hiện tại vẫn còn hạn sử dụng hợp lệ.');
        }
      }

      callbacks.onForeground?.();
    } catch (err) {
      console.warn('[AppLifecycle] Lỗi trong quá trình kiểm tra khi app resume:', err);
    } finally {
      isChecking = false;
    }
  };

  // 1. Lắng nghe qua Capacitor App (trên thiết bị Android / iOS Native)
  let removeCapacitorListener: (() => void) | null = null;
  if (Capacitor.isNativePlatform() || (typeof window !== 'undefined' && 'Capacitor' in window)) {
    try {
      const listenerPromise = CapApp.addListener('appStateChange', (state) => {
        if (state.isActive) {
          void handleAppResumed();
        }
      });
      removeCapacitorListener = () => {
        listenerPromise.then((handle) => handle.remove()).catch(() => {});
      };
    } catch (capErr) {
      console.warn('[AppLifecycle] Không thể đăng ký CapApp.addListener:', capErr);
    }
  }

  // 2. Lắng nghe qua sự kiện VisibilityChange & Focus (trên Web / Browser)
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      void handleAppResumed();
    }
  };

  const handleFocus = () => {
    void handleAppResumed();
  };

  window.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleFocus);

  return () => {
    window.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('focus', handleFocus);
    if (removeCapacitorListener) {
      removeCapacitorListener();
    }
  };
}
