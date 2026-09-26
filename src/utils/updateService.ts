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

// Danh sách URL lấy version.json (hỗ trợ fallback nếu một domain bị chặn)
const VERSION_URLS = [
  'https://raw.githubusercontent.com/tuanta3012/khosach/main/version.json',
  'https://github.com/tuanta3012/khosach/raw/refs/heads/main/version.json',
];

/**
 * So sánh 2 chuỗi version semver (ví dụ '1.0.3' so với '1.0.0')
 * Trả về: > 0 nếu v1 > v2; < 0 nếu v1 < v2; 0 nếu bằng nhau
 */
export function compareSemver(v1: string, v2: string): number {
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
 * Kiểm tra phiên bản mới từ GitHub repository
 */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  let lastError: any = null;

  for (const url of VERSION_URLS) {
    try {
      // Thêm cache-busting timestamp để luôn lấy bản mới nhất
      const cacheBustUrl = `${url}?t=${Date.now()}`;
      const response = await fetch(cacheBustUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Cache-Control': 'no-cache',
        },
      });

      if (response.ok) {
        const data: RemoteVersionInfo = await response.json();
        if (data && data.version) {
          const remoteVer = data.version.trim();
          const hasUpdate = compareSemver(remoteVer, CURRENT_APP_VERSION) > 0;
          
          const defaultApkUrl = `https://github.com/tuanta3012/khosach/releases/download/v${remoteVer}/khosach_v${remoteVer}.apk`;

          return {
            hasUpdate,
            currentVersion: CURRENT_APP_VERSION,
            latestVersion: remoteVer,
            notes: data.notes || `Bản cập nhật v${remoteVer} cho ứng dụng Kho Sách Cá Nhân.`,
            apkUrl: data.apkUrl || defaultApkUrl,
          };
        }
      }
    } catch (err) {
      lastError = err;
    }
  }

  return {
    hasUpdate: false,
    currentVersion: CURRENT_APP_VERSION,
    latestVersion: CURRENT_APP_VERSION,
    notes: '',
    apkUrl: '',
  };
}
