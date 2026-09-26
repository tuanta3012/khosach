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

// Định nghĩa cấu trúc cho GitHub API response
interface GitHubApiContentResponse {
  content?: string;
  encoding?: string;
}

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
 * Giải mã Unicode Base64 an toàn cho trình duyệt
 */
function decodeBase64Unicode(str: string): string {
  try {
    // Giải mã Base64 sang chuỗi byte
    const binary = atob(str.replace(/\s/g, ''));
    // Chuyển đổi chuỗi byte sang mảng Uint8Array
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    // Giải mã Uint8Array thành chuỗi UTF-8 đúng chuẩn tiếng Việt có dấu
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    console.error('[UpdateService] Lỗi giải mã Base64:', e);
    return atob(str.replace(/\s/g, ''));
  }
}

/**
 * Lấy URL API đầy đủ hỗ trợ cả Web và môi trường di động Capacitor
 */
const getApiUrl = (path: string): string => {
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    // Nếu chạy trên điện thoại (Capacitor localhost) hoặc chạy thử nghiệm cục bộ,
    // chuyển hướng yêu cầu API đến máy chủ lưu trữ chính thức để xử lý
    if (origin.includes('localhost') || origin.includes('127.0.0.1') || origin.startsWith('file:')) {
      return `https://ais-pre-6xd4hn5ourvlmjugqheam6-546075383474.asia-southeast1.run.app${path}`;
    }
    return `${origin}${path}`;
  }
  return path;
};

/**
 * Kiểm tra phiên bản mới từ GitHub repository (Bằng Proxy Server-Side và Client-Side Fallback)
 */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  // BƯỚC 1: Ưu tiên gọi qua Proxy API (Không bị dính lỗi CORS ở phía client)
  try {
    const proxyUrl = getApiUrl('/api/app-update/check');
    console.log(`[UpdateService] Đang kiểm tra cập nhật qua máy chủ proxy: ${proxyUrl}`);
    
    const response = await fetch(proxyUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
      },
    });

    if (response.ok) {
      const data = await response.json();
      if (data && data.success && data.version) {
        const remoteVer = data.version.trim();
        const hasUpdate = compareSemver(remoteVer, CURRENT_APP_VERSION) > 0;
        
        console.log(`[UpdateService] [Proxy Thành công] Máy đang chạy: v${CURRENT_APP_VERSION} | Server mới nhất: v${remoteVer}`);
        console.log(`[UpdateService] Kết quả: ${hasUpdate ? 'CÓ BẢN MỚI (Hiện popup)' : 'ĐÃ LÀ MỚI NHẤT (Bỏ qua)'}`);

        const defaultApkUrl = `https://github.com/tuanta3012/khosach/releases/download/v${remoteVer}/khosach_v${remoteVer}.apk`;

        return {
          hasUpdate,
          currentVersion: CURRENT_APP_VERSION,
          latestVersion: remoteVer,
          notes: data.notes || `Bản cập nhật v${remoteVer} cho ứng dụng Kho Sách Cá Nhân.`,
          apkUrl: data.apkUrl || defaultApkUrl,
        };
      }
    } else {
      console.warn(`[UpdateService] Máy chủ proxy trả về lỗi HTTP: ${response.status}. Chuyển sang cơ chế dự phòng...`);
    }
  } catch (err) {
    console.warn('[UpdateService] Không thể kết nối tới máy chủ proxy. Đang tự động chuyển sang cơ chế kiểm tra trực tiếp (Client-Side Direct Fetch)...', err);
  }

  // BƯỚC 2: Dự phòng trực tiếp nếu không thể kết nối tới máy chủ Proxy (Ví dụ khi offline hoàn toàn hoặc lỗi server)
  const SOURCES = [
    {
      name: 'GitHub Raw (refs/heads/main)',
      url: 'https://raw.githubusercontent.com/tuanta3012/khosach/refs/heads/main/version.json',
      isApi: false
    },
    {
      name: 'GitHub Raw (main)',
      url: 'https://raw.githubusercontent.com/tuanta3012/khosach/main/version.json',
      isApi: false
    },
    {
      name: 'jsDelivr CDN (Tốc độ cao)',
      url: 'https://cdn.jsdelivr.net/gh/tuanta3012/khosach@main/version.json',
      isApi: false
    },
    {
      name: 'GitHub API (Tránh bị ISP chặn)',
      url: 'https://api.github.com/repos/tuanta3012/khosach/contents/version.json',
      isApi: true
    }
  ];

  for (const src of SOURCES) {
    try {
      const cacheBustUrl = `${src.url}?t=${Date.now()}`;
      console.log(`[UpdateService] [Fallback] Đang tải trực tiếp từ nguồn: ${src.name}`);
      
      const response = await fetch(cacheBustUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Cache-Control': 'no-cache',
        },
      });

      if (response.ok) {
        const jsonResult = await response.json();
        let data: RemoteVersionInfo | null = null;

        if (src.isApi) {
          const apiResponse = jsonResult as GitHubApiContentResponse;
          if (apiResponse.content && apiResponse.encoding === 'base64') {
            const decodedStr = decodeBase64Unicode(apiResponse.content);
            data = JSON.parse(decodedStr) as RemoteVersionInfo;
          }
        } else {
          data = jsonResult as RemoteVersionInfo;
        }

        if (data && data.version) {
          const remoteVer = data.version.trim();
          const hasUpdate = compareSemver(remoteVer, CURRENT_APP_VERSION) > 0;
          
          console.log(`[UpdateService] [Fallback Thành công] Máy đang chạy: v${CURRENT_APP_VERSION} | Server mới nhất: v${remoteVer}`);
          
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
      console.error(`[UpdateService] [Fallback Thất bại] Không thể tải từ ${src.name}:`, err);
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
