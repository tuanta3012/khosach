import { Network, ConnectionStatus } from '@capacitor/network';
import { Capacitor } from '@capacitor/core';

export interface DetailedNetworkStatus {
  hasPhysicalConnection: boolean;
  connectionType: string;
}

/**
 * 1. Kiểm tra trạng thái kết nối phần cứng (Wifi hoặc Mobile Data)
 * Thiết bị được coi là KHÔNG CÓ MẠNG nếu không có cả Wifi lẫn Mobile Data.
 */
export async function getNetworkStatus(): Promise<DetailedNetworkStatus> {
  try {
    const status: ConnectionStatus = await Network.getStatus();
    const hasPhysicalConnection = Boolean(
      status.connected && status.connectionType !== 'none'
    );
    return {
      hasPhysicalConnection,
      connectionType: status.connectionType || (hasPhysicalConnection ? 'cellular' : 'none'),
    };
  } catch (err) {
    console.warn('[Network] Lỗi đọc Network.getStatus(), dùng fallback navigator:', err);
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    return {
      hasPhysicalConnection: isOnline,
      connectionType: isOnline ? 'unknown' : 'none',
    };
  }
}

/**
 * 2. Ping kiểm tra kết nối Internet thực tế tới máy chủ (Active Probe)
 * Khi bật kết nối lại (Wifi / 4G), hệ thống gửi ping siêu nhẹ (generate_204) để xác nhận
 * mạng đã thông ra ngoài Internet thực tế hay chưa (tránh trường hợp dính captive portal hoặc rớt mạng).
 */
export async function checkRealInternetAccess(timeoutMs = 4000): Promise<boolean> {
  // Nếu phần cứng chưa nối Wifi hoặc Mobile Data -> chắc chắn không có mạng
  const { hasPhysicalConnection } = await getNetworkStatus();
  if (!hasPhysicalConnection) {
    return false;
  }

  const pingUrl = `https://clients3.google.com/generate_204?_t=${Date.now()}`;

  // Trên thiết bị Native Android/iOS, sử dụng CapacitorHttp để bypass CORS và đo chính xác HTTP status
  if (Capacitor.isNativePlatform()) {
    try {
      const { CapacitorHttp } = await import('@capacitor/core');
      const res = await CapacitorHttp.request({
        url: pingUrl,
        method: 'GET',
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      return res.status === 204 || res.status === 200;
    } catch (nativeErr) {
      console.log('[Network] Native ping generate_204 thất bại:', nativeErr);
      return false;
    }
  }

  // Trên Web Browser: fetch với mode 'no-cors' và AbortController timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await fetch(pingUrl, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return true;
  } catch (webErr) {
    clearTimeout(timer);
    console.log('[Network] Web ping generate_204 thất bại, thử fallback endpoint:', webErr);

    // Thử fallback sang endpoint phụ
    try {
      const fbController = new AbortController();
      const fbTimer = setTimeout(() => fbController.abort(), 2500);
      await fetch(`https://www.cloudflare.com/cdn-cgi/trace?_t=${Date.now()}`, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: fbController.signal,
      });
      clearTimeout(fbTimer);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 3. Bộ lắng nghe sự kiện phục hồi kết nối mạng (Network Recovery Listener)
 * Chỉ kích hoạt callback khi:
 * - Thiết bị đã bật Wifi hoặc Mobile Data
 * - VÀ ĐÃ PING THÀNH CÔNG ra Internet thực tế
 */
export function setupNetworkRecoveryListener(onInternetRestored: () => void): () => void {
  let isChecking = false;

  const handlePotentialConnection = async () => {
    if (isChecking) return;
    isChecking = true;

    try {
      const status = await getNetworkStatus();
      if (!status.hasPhysicalConnection) {
        console.log('[Network] Thiết bị không có kết nối Wifi lẫn Mobile Data.');
        return;
      }

      console.log(`[Network] Phát hiện kết nối ${status.connectionType}, đang ping kiểm tra Internet thực tế...`);
      const hasRealInternet = await checkRealInternetAccess(4000);

      if (hasRealInternet) {
        console.log('[Network] Ping thành công! Internet thực tế đã sẵn sàng, tiến hành quy trình tiếp theo.');
        onInternetRestored();
      } else {
        console.log('[Network] Có sóng nhưng ping thất bại (chưa có internet). Chờ 3s thử lại 1 lần...');
        setTimeout(async () => {
          const retrySuccess = await checkRealInternetAccess(4000);
          if (retrySuccess) {
            console.log('[Network] Ping lần 2 thành công! Tiến hành quy trình tiếp theo.');
            onInternetRestored();
          } else {
            console.log('[Network] Ping lần 2 vẫn thất bại, giữ nguyên chế độ chờ.');
          }
        }, 3000);
      }
    } finally {
      isChecking = false;
    }
  };

  // Đăng ký Capacitor Network Listener
  let removeCapacitorListener: (() => void) | null = null;
  try {
    const listenerPromise = Network.addListener('networkStatusChange', (status) => {
      if (status.connected && status.connectionType !== 'none') {
        void handlePotentialConnection();
      }
    });
    removeCapacitorListener = () => {
      listenerPromise.then((handle) => handle.remove()).catch(() => {});
    };
  } catch (err) {
    console.warn('[Network] Lỗi đăng ký Network.addListener:', err);
  }

  // Đăng ký Web Event Listener
  const onOnline = () => {
    void handlePotentialConnection();
  };
  window.addEventListener('online', onOnline);

  return () => {
    window.removeEventListener('online', onOnline);
    if (removeCapacitorListener) {
      removeCapacitorListener();
    }
  };
}
