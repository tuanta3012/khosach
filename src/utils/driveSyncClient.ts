import { Capacitor, CapacitorHttp } from '@capacitor/core';

export function sanitizeDocId(id: string): string {
  if (!id) return '';
  return id.replace(/[^a-zA-Z0-9_\-]/g, '').trim();
}

export function sanitizeSingleCategory(rawCategory: string): string {
  if (!rawCategory || !rawCategory.trim()) return 'Chung';
  const first = rawCategory.split(/[,/|+\\]/)[0].trim();
  return first || 'Chung';
}

export async function smartDriveFetch(targetUrl: string, options?: RequestInit): Promise<Response> {
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
    return new Response(body, {
      status: nativeResponse.status,
      headers: nativeResponse.headers,
    });
  }

  return fetch(targetUrl, { ...options, redirect: 'follow' });
}