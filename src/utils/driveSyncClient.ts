import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { handleTokenErrorAndReauthorize, getAccessToken } from '../services/googleAuthService';

export function sanitizeDocId(id: string): string {
  if (!id) return '';
  return id.replace(/[^a-zA-Z0-9_\-]/g, '').trim();
}

export function sanitizeSingleCategory(rawCategory: string): string {
  if (!rawCategory || !rawCategory.trim()) return 'Chung';
  const first = rawCategory.split(/[,/|+\\]/)[0].trim();
  return first || 'Chung';
}


/**
 * Thực hiện request tới Google API hoặc external URL với hỗ trợ:
 * 1. Native bypass CORS qua CapacitorHttp trên Android/iOS
 * 2. Tự động Intercept lỗi 401 Unauthorized (Token hết hạn):
 *    - Tự động gọi Silent Refresh lấy token mới
 *    - Cập nhật header Authorization và tự động Retry lại request đó ngầm
 *    - Tránh gián đoạn và không gây lỗi gián đoạn ra UI người dùng
 */
export async function smartDriveFetch(
  targetUrl: string,
  options?: RequestInit,
  autoRetry401 = true
): Promise<Response> {
  let response: Response;

  if (Capacitor.isNativePlatform()) {
    const headers = Object.fromEntries(new Headers(options?.headers).entries());
    const nativeResponse = await CapacitorHttp.request({
      url: targetUrl,
      method: options?.method || 'GET',
      headers,
      data: typeof options?.body === 'string' ? options.body : undefined,
      responseType: 'text',
      connectTimeout: 20000,
      readTimeout: 30000,
    });
    const body = typeof nativeResponse.data === 'string'
      ? nativeResponse.data
      : JSON.stringify(nativeResponse.data ?? '');
    response = new Response(body, {
      status: nativeResponse.status,
      headers: nativeResponse.headers,
    });
  } else {
    response = await fetch(targetUrl, { ...options, redirect: 'follow' });
  }

  // Nếu gặp lỗi 401 (Unauthorized/Token Expired) và cho phép tự động thử lại
  if (response.status === 401 && autoRetry401) {
    console.warn(`[smartDriveFetch] Bắt được mã 401 khi gọi API: ${targetUrl}. Tự động khôi phục token và retry ngầm...`);
    try {
      const freshToken = await handleTokenErrorAndReauthorize();
      if (freshToken) {
        const headers = new Headers(options?.headers);
        headers.set('Authorization', `Bearer ${freshToken}`);
        const updatedOptions: RequestInit = {
          ...options,
          headers,
        };
        console.info(`[smartDriveFetch] Gia hạn token ngầm thành công! Đang tự động thử lại request: ${targetUrl}`);
        return await smartDriveFetch(targetUrl, updatedOptions, false);
      }
    } catch (retryErr) {
      console.warn('[smartDriveFetch] Lỗi khi tự động retry sau khi làm mới token:', retryErr);
    }
  }

  return response;
}

/**
 * Bọc hàm gọi Google Drive / Google Sheets API với token xác thực tự động
 * và auto-retry 401 interceptor.
 */
export async function fetchWithGoogleAuth(
  targetUrl: string,
  options: RequestInit = {},
  fallbackToken?: string
): Promise<Response> {
  const token = fallbackToken || (await getAccessToken());
  const headers = new Headers(options.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return smartDriveFetch(targetUrl, { ...options, headers }, true);
}