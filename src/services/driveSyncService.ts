import { BookRecord, UserRole } from '../types';
import { sanitizeDocId, sanitizeSingleCategory } from '../utils/driveSyncClient';
import { checkDuplicateBook } from '../utils/fuzzyMatcher';
import { getAccessToken } from './googleAuthService';

export interface FamilyMember {
  email: string;
  role: 'Owner' | 'Editor' | 'Viewer';
  addedAt: string;
  permissionId?: string;
}

export interface SpreadsheetInfo {
  id: string;
  name: string;
  webViewLink?: string;
  isNew?: boolean;
}

export interface DuplicateResolutionLog {
  id: string;
  originalTitle: string;
  matchedTitle?: string;
  action: 'MERGED' | 'IGNORED' | 'FIXED' | 'DELETED';
  resolvedAt: string;
  resolvedBy?: string;
  note?: string;
}

export interface SheetConfigMetadata {
  schemaVersion?: number;
  status: 'active' | 'unlinked';
  lastAction?: 'create' | 'link' | 'unlink' | 'sync' | 'update';
  activeFileId?: string;
  activeFileName?: string;
  activeFileUrl?: string;
  adminEmail: string;
  linkedAccountEmail?: string;
  linkedTimestamp?: string;
  linkedLocalTimeVi?: string;
  updatedAt: string;
  updatedAtVi?: string;
  appName?: string;
  appVersion?: string;
  lastSyncBy?: string;
  ignoredDuplicatePairs?: string[];
  resolvedDuplicates?: DuplicateResolutionLog[];
  customSettings?: Record<string, any>;
}

export interface MasterSyncState {
  schemaVersion?: number;
  status: 'active' | 'unlinked';
  lastAction: 'create' | 'link' | 'switch' | 'unlink' | 'update';
  activeFileId: string;
  activeFileName: string;
  activeFileUrl: string;
  adminEmail: string;
  linkedAccountEmail?: string;
  linkedTimestamp?: string;
  linkedLocalTimeVi?: string;
  updatedAt: string;
  updatedAtVi?: string;
  members: FamilyMember[];
  ignoredDuplicatePairs?: string[];
  customSettings?: Record<string, any>;
}

export const KHOSACH_SHEET_TITLE = 'Khosach';
export const MASTER_CONFIG_SHEET_TITLE = '__CONFIG__';
export const CONFIG_SHEET_TITLE = 'Config';
const KNOWN_SPREADSHEETS_STORAGE_KEY = 'library_known_spreadsheets_v2';
export const APP_PROPERTY_KEY = 'app';
export const APP_PROPERTY_VALUE = 'khosach_app';

/**
 * Đọc danh sách các file Google Sheet do App tạo đã lưu trong bộ nhớ máy
 */
export function getKnownSpreadsheets(): SpreadsheetInfo[] {
  try {
    const raw = localStorage.getItem(KNOWN_SPREADSHEETS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

/**
 * Lưu một file Google Sheet do App tạo vào danh bạ file của ứng dụng
 */
export function saveKnownSpreadsheet(sheet: SpreadsheetInfo): void {
  if (!sheet || !sheet.id) return;
  try {
    const current = getKnownSpreadsheets();
    const map = new Map<string, SpreadsheetInfo>();
    current.forEach((s) => map.set(s.id, s));
    map.set(sheet.id, {
      id: sheet.id,
      name: sheet.name || 'Kho Sách',
      webViewLink: sheet.webViewLink || `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`,
    });
    const updated = Array.from(map.values());
    localStorage.setItem(KNOWN_SPREADSHEETS_STORAGE_KEY, JSON.stringify(updated));
  } catch {}
}

/**
 * Xóa một file khỏi danh bạ file
 */
export function removeKnownSpreadsheet(sheetId: string): void {
  if (!sheetId) return;
  try {
    const current = getKnownSpreadsheets();
    const filtered = current.filter((s) => s.id !== sheetId);
    localStorage.setItem(KNOWN_SPREADSHEETS_STORAGE_KEY, JSON.stringify(filtered));
  } catch {}
}

/**
 * Kiểm tra xem tệp Google Sheet còn tồn tại trên Google Drive và không bị xóa vào Thùng rác (trash)
 */
export async function checkSpreadsheetStatusOnDrive(
  accessToken: string,
  spreadsheetId: string
): Promise<{ exists: boolean; trashed: boolean; name?: string; error?: string }> {
  try {
    if (!accessToken || !spreadsheetId) {
      return { exists: true, trashed: false, error: 'MISSING_PARAMS' };
    }
    const url = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=id,name,trashed,appProperties&supportsAllDrives=true`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status === 404) {
      // DUY NHẤT mã 404 là file thực sự đã bị xóa hoặc không tồn tại
      return { exists: false, trashed: false, error: 'FILE_NOT_FOUND' };
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.warn(`[DriveSync] checkSpreadsheetStatusOnDrive HTTP_${resp.status}:`, err);
      // Các lỗi 401 (hết hạn token), 403 (tạm thời/hạn mức), 5xx KHÔNG PHẢI là file bị xóa!
      return { exists: true, trashed: false, error: err?.error?.message || `HTTP_${resp.status}` };
    }
    const data = await resp.json();
    if (data.trashed) {
      return { exists: false, trashed: true, name: data.name, error: 'FILE_TRASHED' };
    }
    return {
      exists: true,
      trashed: false,
      name: data.name,
    };
  } catch (err: any) {
    console.warn('[DriveSync] checkSpreadsheetStatusOnDrive network error:', err);
    // Lỗi mạng, offline hoặc timeout: Tuyệt đối không đánh dấu file bị xóa!
    return { exists: true, trashed: false, error: err?.message || 'NETWORK_ERROR' };
  }
}

/**
 * Gắn appProperties định danh file do App tạo lên Google Drive
 */
export async function tagSpreadsheetAsAppCreated(
  accessToken: string,
  spreadsheetId: string
): Promise<void> {
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appProperties: {
          [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE,
          created_by: APP_PROPERTY_VALUE,
        },
      }),
    });
  } catch (err) {
    console.warn('[DriveSync] Gắn thẻ appProperties thất bại:', err);
  }
}

/**
 * Kiểm tra xác thực một Google Sheet xem có phải là file do App Tủ Sách Gia Đình tạo hay không.
 * Lọc DUY NHẤT theo điều kiện: appProperties.app == 'khosach_app'
 */
export async function isBookLibrarySpreadsheet(
  _accessToken: string,
  _spreadsheetId: string,
  appProps?: any
): Promise<boolean> {
  return Boolean(appProps && appProps[APP_PROPERTY_KEY] === APP_PROPERTY_VALUE);
}

/**
 * Lấy các Google Sheet Drive API cho phép ứng dụng nhìn thấy, gồm file được chia sẻ,
 * file có appProperties và file có tên thường dùng của ứng dụng.
 */
export async function fetchUserSpreadsheetsFromDrive(
  accessToken: string
): Promise<SpreadsheetInfo[]> {
  const map = new Map<string, SpreadsheetInfo>();

  if (!accessToken) {
    return getKnownSpreadsheets();
  }

  // Nạp sẵn các file đã từng lưu trong máy trước
  getKnownSpreadsheets().forEach((s) => map.set(s.id, s));

  // Quét danh sách Google Sheet bằng truy vấn chuẩn (giống như trong googleDriveService.ts)
  // Tuyệt đối không truyền includeItemsFromAllDrives gây lỗi HTTP 400 Bad Request
  const queries = [
    "trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'",
    "sharedWithMe = true and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
  ];

  for (const q of queries) {
    try {
      let pageToken: string | undefined;
      let pageCount = 0;
      do {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.set('pageSize', '100');
        url.searchParams.set('fields', 'nextPageToken,files(id,name,webViewLink,trashed,modifiedTime)');
        url.searchParams.set('orderBy', 'modifiedTime desc');
        url.searchParams.set('spaces', 'drive');
        url.searchParams.set('q', q);
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const response = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          console.warn(`[DriveSync] Drive discovery query failed (HTTP ${response.status}) for "${q}".`);
          break;
        }

        const data = await response.json();
        for (const file of data.files || []) {
          if (!file.id || file.trashed) continue;
          map.set(file.id, {
            id: file.id,
            name: file.name || 'Kho Sách Gia Đình',
            webViewLink: file.webViewLink || `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
          });
        }
        pageToken = data.nextPageToken;
        pageCount += 1;
      } while (pageToken && pageCount < 3);
    } catch (err) {
      console.warn('[DriveSync] Quét danh sách Google Sheet từ Drive gặp lỗi:', err);
    }
  }

  const savedSheetId = (() => {
    try {
      return (JSON.parse(localStorage.getItem('library_spreadsheet_info_v2') || 'null') as SpreadsheetInfo | null)?.id;
    } catch {
      return undefined;
    }
  })();
  const verifiedList = Array.from(map.values()).sort((a, b) => {
    if (a.id === savedSheetId) return -1;
    if (b.id === savedSheetId) return 1;
    return 0;
  });

  // Lưu danh sách file vào LocalStorage
  try {
    localStorage.setItem(KNOWN_SPREADSHEETS_STORAGE_KEY, JSON.stringify(verifiedList));
  } catch {}

  return verifiedList;
}

export async function findOrCreateLibrarySpreadsheet(
  accessToken: string,
  userEmail: string,
  customTitle = 'Kho Sách Cá Nhân'
): Promise<SpreadsheetInfo> {
  // BƯỚC 1: Tìm kiếm xem tài khoản đã có file phù hợp hay chưa
  try {
    const allSheets = await fetchUserSpreadsheetsFromDrive(accessToken);
    
    // Ưu tiên 1: File đã gắn thẻ appProperties
    let matched = allSheets.find((f: any) => f.appProperties && f.appProperties[APP_PROPERTY_KEY] === APP_PROPERTY_VALUE);

    // Ưu tiên 2: File có tên "Tu sach gia dinh", "Tủ sách gia đình", hoặc customTitle
    if (!matched) {
      matched = allSheets.find((f) => 
        f.name === customTitle ||
        f.name.toLowerCase().includes('tu sach') ||
        f.name.toLowerCase().includes('tủ sách') ||
        f.name.toLowerCase().includes('kho sach') ||
        f.name.toLowerCase().includes('kho sách')
      );
    }

    if (!matched && allSheets.length > 0) {
      matched = allSheets[0];
    }

    if (matched) {
      console.log(`[DriveSync] Đã tìm thấy Google Sheet phù hợp: ${matched.name} (${matched.id})`);
      await ensureSpreadsheetTabs(accessToken, matched.id, userEmail);
      const info: SpreadsheetInfo = {
        id: matched.id,
        name: matched.name,
        webViewLink: matched.webViewLink || `https://docs.google.com/spreadsheets/d/${matched.id}/edit`,
        isNew: false,
      };
      saveKnownSpreadsheet(info);
      tagSpreadsheetAsAppCreated(accessToken, matched.id).catch(() => {});
      return info;
    }
  } catch (err) {
    console.warn('[DriveSync] Quét file trên Drive thất bại, tiến hành tạo mới:', err);
  }

  // BƯỚC 2: Tự động tạo mới Google Sheet và gắn thẻ appProperties
  return await createNewLibrarySpreadsheet(accessToken, userEmail, customTitle);
}

/**
 * Tạo mới trực tiếp một Google Sheet theo tên tùy chỉnh (Dùng Drive API + Sheets API đồng bộ 100%)
 */
export async function createNewLibrarySpreadsheet(
  accessToken: string,
  userEmail: string,
  customTitle = 'Kho Sách Cá Nhân'
): Promise<SpreadsheetInfo> {
  console.log(`[DriveSync] Đang tạo mới Google Sheet: "${customTitle}"...`);
  
  let spreadsheetId = '';
  let webViewLink = '';

  let activeToken = accessToken;

  // 1. Thử tạo file qua Google Drive API (Hoàn hảo cho scope https://www.googleapis.com/auth/drive.file)
  try {
    let driveCreateResp = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${activeToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: customTitle,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        appProperties: {
          [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE,
          created_by: APP_PROPERTY_VALUE,
        },
      }),
    });

    // Nếu gặp mã lỗi 401, tự động silent refresh token và thử lại ngay lập tức
    if (driveCreateResp.status === 401) {
      console.log('[DriveSync] Token 401, đang tự động silent refresh và tạo lại file...');
      const freshToken = await getAccessToken(true);
      if (freshToken) {
        activeToken = freshToken;
        driveCreateResp = await fetch('https://www.googleapis.com/drive/v3/files', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${activeToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: customTitle,
            mimeType: 'application/vnd.google-apps.spreadsheet',
            appProperties: {
              [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE,
              created_by: APP_PROPERTY_VALUE,
            },
          }),
        });
      }
    }

    if (driveCreateResp.ok) {
      const driveData = await driveCreateResp.json();
      spreadsheetId = driveData.id;
      webViewLink = driveData.webViewLink || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
      console.log(`[DriveSync] Đã tạo file qua Google Drive API thành công: ${spreadsheetId}`);
    } else {
      const err = await driveCreateResp.json().catch(() => ({}));
      console.warn('[DriveSync] Drive API create file status:', driveCreateResp.status, err);
    }
  } catch (err) {
    console.warn('[DriveSync] Lỗi gọi Drive API tạo file, chuyển sang Sheets API:', err);
  }

  // 2. Nếu Drive API không khả dụng, gọi Sheets API làm fallback
  if (!spreadsheetId) {
    const createUrl = 'https://sheets.googleapis.com/v4/spreadsheets';
    const createPayload = {
      properties: {
        title: customTitle,
      },
      sheets: [
        {
          properties: {
            title: KHOSACH_SHEET_TITLE,
            gridProperties: { frozenRowCount: 1 },
          },
        },
        {
          properties: {
            title: CONFIG_SHEET_TITLE,
            gridProperties: { frozenRowCount: 1 },
          },
        },
      ],
    };

    let createResp = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${activeToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createPayload),
    });

    if (createResp.status === 401) {
      const freshToken = await getAccessToken(true);
      if (freshToken) {
        activeToken = freshToken;
        createResp = await fetch(createUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${activeToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(createPayload),
        });
      }
    }

    if (!createResp.ok) {
      const errorData = await createResp.json().catch(() => ({}));
      if (createResp.status === 401) {
        throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng bấm Đăng nhập lại.');
      }
      throw new Error(
        errorData?.error?.message || `Không thể tạo Google Sheet (Mã lỗi ${createResp.status})`
      );
    }

    const createdData = await createResp.json();
    spreadsheetId = createdData.spreadsheetId;
    webViewLink = createdData.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

    // Gắn tag appProperties cho file tạo bằng Sheets API
    await tagSpreadsheetAsAppCreated(activeToken, spreadsheetId);
  }

  // Luôn đảm bảo file có tag appProperties trên Google Drive
  await tagSpreadsheetAsAppCreated(activeToken, spreadsheetId);

  // 3. Đảm bảo cấu trúc 2 Tab và ghi tiêu đề dòng 1
  await ensureSpreadsheetTabs(activeToken, spreadsheetId, userEmail);
  await initializeSheetHeaders(activeToken, spreadsheetId, userEmail, customTitle);

  const result: SpreadsheetInfo = {
    id: spreadsheetId,
    name: customTitle,
    webViewLink,
    isNew: true,
  };

  saveKnownSpreadsheet(result);
  return result;
}

/**
 * Xóa một file Google Sheet khỏi Google Drive
 */
export async function deleteDriveSpreadsheet(
  accessToken: string,
  fileId: string
): Promise<void> {
  removeKnownSpreadsheet(fileId);
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok && resp.status !== 404) {
    const errJson = await resp.json().catch(() => ({}));
    if (resp.status === 401) {
      throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng bấm Đăng nhập lại.');
    }
    throw new Error(errJson?.error?.message || `Không thể xóa file trên Drive (${resp.status})`);
  }
}

/**
 * Đảm bảo cả 2 Tab ("Khosach" và "__CONFIG__") đều tồn tại trong Google Sheet
 */
async function ensureSpreadsheetTabs(accessToken: string, spreadsheetId: string, userEmail: string) {
  try {
    const metaResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaResp.ok) return;

    const meta = await metaResp.json();
    const sheets: any[] = meta.sheets || [];
    const hasKhosach = sheets.some((s) => s.properties?.title === KHOSACH_SHEET_TITLE);
    const hasMasterConfig = sheets.some((s) => s.properties?.title === MASTER_CONFIG_SHEET_TITLE);

    const requests: any[] = [];

    // 1. Nếu chưa có Tab Khosach:
    if (!hasKhosach) {
      const defaultSheet = sheets.find(
        (s) => s.properties?.title !== MASTER_CONFIG_SHEET_TITLE && s.properties?.title !== CONFIG_SHEET_TITLE
      );
      if (defaultSheet && defaultSheet.properties?.sheetId !== undefined) {
        requests.push({
          updateSheetProperties: {
            properties: {
              sheetId: defaultSheet.properties.sheetId,
              title: KHOSACH_SHEET_TITLE,
              index: 0,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: 'title,index,gridProperties.frozenRowCount',
          },
        });
      } else {
        requests.push({
          addSheet: {
            properties: { title: KHOSACH_SHEET_TITLE, index: 0, gridProperties: { frozenRowCount: 1 } },
          },
        });
      }
    }

    // 2. Nếu chưa có Tab __CONFIG__, thêm Tab __CONFIG__ ẩn ở vị trí thứ 2
    if (!hasMasterConfig) {
      requests.push({
        addSheet: {
          properties: {
            title: MASTER_CONFIG_SHEET_TITLE,
            index: 1,
            hidden: true,
            gridProperties: { frozenRowCount: 1, rowCount: 30, columnCount: 5 },
          },
        },
      });
    }

    if (requests.length > 0) {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
      });
      await initializeSheetHeaders(accessToken, spreadsheetId, userEmail);
    }

    // 3. Quét lại để dọn dẹp các Tab rác ngoài Khosach, __CONFIG__ và Config
    const metaResp2 = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (metaResp2.ok) {
      const meta2 = await metaResp2.json();
      const sheets2: any[] = meta2.sheets || [];
      const extraSheets = sheets2.filter(
        (s) =>
          s.properties?.title !== KHOSACH_SHEET_TITLE &&
          s.properties?.title !== MASTER_CONFIG_SHEET_TITLE &&
          s.properties?.title !== CONFIG_SHEET_TITLE
      );
      if (extraSheets.length > 0 && sheets2.length > extraSheets.length) {
        const deleteRequests = extraSheets.map((s) => ({
          deleteSheet: { sheetId: s.properties.sheetId },
        }));
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ requests: deleteRequests }),
        });
      }
    }
  } catch (err) {
    console.warn('[DriveSync] ensureSpreadsheetTabs skipped:', err);
  }
}

/**
 * Hàm phân tích ngày tháng tiếng Việt chuẩn (Ví dụ: "22:01:36 29/9/2026")
 */
function parseVietnameseDate(dateStr: string): number {
  if (!dateStr) return Date.now();
  try {
    const parts = dateStr.trim().split(' ');
    if (parts.length === 2) {
      const timePart = parts[0]; // "22:01:36"
      const datePart = parts[1]; // "29/9/2026"
      const timeSubparts = timePart.split(':');
      const dateSubparts = datePart.split('/');
      if (timeSubparts.length >= 2 && dateSubparts.length === 3) {
        const hours = parseInt(timeSubparts[0], 10);
        const minutes = parseInt(timeSubparts[1], 10);
        const seconds = parseInt(timeSubparts[2] || '0', 10);
        const day = parseInt(dateSubparts[0], 10);
        const month = parseInt(dateSubparts[1], 10) - 1; // 0-indexed month
        const year = parseInt(dateSubparts[2], 10);
        return new Date(year, month, day, hours, minutes, seconds).getTime();
      }
    }
    const parsed = Date.parse(dateStr);
    if (!isNaN(parsed)) return parsed;
  } catch {}
  return Date.now();
}

/**
 * Định dạng Timestamp thành ngày tiếng Việt đẹp (Ví dụ: "22:01:36 29/9/2026")
 */
function formatVietnameseDate(timestamp: number): string {
  try {
    const d = new Date(timestamp);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    return `${hours}:${minutes}:${seconds} ${day}/${month}/${year}`;
  } catch {
    return '';
  }
}

/**
 * Định dạng Timestamp thành ngày tiếng Việt đầy đủ kèm Múi giờ GMT+7
 * Ví dụ: "22:39:53 04/10/2026 (GMT+7)"
 */
export function formatVietnameseFullDate(input?: number | string | Date): string {
  try {
    const d = input ? new Date(input) : new Date();
    if (isNaN(d.getTime())) return '';
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${hours}:${minutes}:${seconds} ${day}/${month}/${year} (GMT+7)`;
  } catch {
    return '';
  }
}

/**
 * Ghi trạng thái Master Workspace và phân quyền trực tiếp vào Tab ẩn __CONFIG__ của Google Sheet
 * Ma trận chuẩn 10 hàng x 2 cột (Dải ô A1:B10), TUYỆT ĐỐI KHÔNG CÓ AUDIT LOGS.
 */
export async function saveMasterSyncStateToGoogleSheet(
  accessToken: string,
  fileId: string,
  state: Partial<SheetConfigMetadata> & {
    activeFileId?: string;
    adminEmail?: string;
    members?: FamilyMember[];
  }
): Promise<boolean> {
  try {
    if (!accessToken || !fileId) return false;

    const nowIso = state.updatedAt || new Date().toISOString();
    const nowVi = state.updatedAtVi || formatVietnameseFullDate(nowIso);
    const linkedIso = state.linkedTimestamp || nowIso;
    const linkedVi = state.linkedLocalTimeVi || formatVietnameseFullDate(linkedIso);

    const members = state.members || [];
    const coreMetadataPayload = JSON.stringify({
      schemaVersion: 2,
      status: state.status || 'active',
      lastAction: state.lastAction || 'link',
      activeFileId: state.activeFileId || fileId,
      activeFileName: state.activeFileName || 'Kho Sách Gia Đình',
      activeFileUrl: state.activeFileUrl || `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
      adminEmail: state.adminEmail || '',
      linkedAccountEmail: state.linkedAccountEmail || state.adminEmail || '',
      linkedTimestamp: linkedIso,
      linkedLocalTimeVi: linkedVi,
      updatedAt: nowIso,
      updatedAtVi: nowVi,
    });

    const customSettingsPayload = JSON.stringify({
      ignoredDuplicatePairs: state.ignoredDuplicatePairs || [],
      customSettings: state.customSettings || {},
    });

    // Ma trận chuẩn 10 hàng x 2 cột A1:B10 theo đúng mẫu (KHÔNG CÓ AUDIT LOGS)
    const values: (string | number)[][] = [
      ['__METADATA_JSON__', coreMetadataPayload],
      ['Vault Name', state.activeFileName || 'Kho Sách Gia Đình'],
      ['Admin Email', state.adminEmail || ''],
      ['Linked Account', state.linkedAccountEmail || state.adminEmail || ''],
      ['Status', state.status || 'active'],
      ['Last Action', state.lastAction || 'link'],
      ['Linked Timestamp', linkedVi],
      ['Updated At', nowVi],
      ['Members JSON', JSON.stringify(members)],
      ['Custom Settings', customSettingsPayload],
    ];

    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values:batchUpdate`;
    const writeData = () =>
      fetch(batchUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: [
            {
              range: `${MASTER_CONFIG_SHEET_TITLE}!A1:B${values.length}`,
              majorDimension: 'ROWS',
              values: values,
            },
          ],
        }),
      });

    let updateRes = await writeData();

    // Nếu tab __CONFIG__ chưa tồn tại (HTTP 400), tự động tạo mới tab ẩn rồi thử ghi lại
    if (!updateRes.ok && updateRes.status === 400) {
      console.warn('[DriveSync] Tab __CONFIG__ chưa tồn tại, tự động tạo mới...');
      const createRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [
            {
              addSheet: {
                properties: {
                  title: MASTER_CONFIG_SHEET_TITLE,
                  hidden: true,
                  gridProperties: { rowCount: 30, columnCount: 5 },
                },
              },
            },
          ],
        }),
      });

      if (createRes.ok) {
        updateRes = await writeData();
      }
    }

    // Đồng thời đồng bộ dữ liệu vào tab Config cũ (nếu có) để tương thích ngược 100%
    try {
      const legacyMetaRows = [
        ['Key', 'Value'],
        ['__METADATA_JSON__', coreMetadataPayload],
        ['status', state.status || 'active'],
        ['activeFileId', fileId],
        ['activeFileName', state.activeFileName || 'Kho Sách Gia Đình'],
        ['adminEmail', state.adminEmail || ''],
        ['updatedAt', nowIso],
        ['updatedAtVi', nowVi],
      ];
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${CONFIG_SHEET_TITLE}!E1:F8?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: legacyMetaRows }),
      }).catch(() => {});
    } catch {}

    return updateRes.ok;
  } catch (err) {
    console.warn('[DriveSync] Lỗi hệ thống khi ghi tab cấu hình __CONFIG__:', err);
    return false;
  }
}

/**
 * Đọc cấu hình Master Workspace và danh sách thành viên trực tiếp từ Tab ẩn __CONFIG__ của Google Sheet
 * Có cơ chế tự động Fallback đọc tab Config cũ nếu file chưa chuyển sang __CONFIG__.
 */
export async function readMasterSyncStateFromGoogleSheet(
  accessToken: string,
  fileId: string
): Promise<{
  metadata: SheetConfigMetadata;
  members: FamilyMember[];
} | null> {
  try {
    if (!accessToken || !fileId) return null;

    // 1. Thử đọc dải ô cấu hình chuẩn từ tab ẩn __CONFIG__!A1:B20
    const configRange = `${MASTER_CONFIG_SHEET_TITLE}!A1:B20`;
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(configRange)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (res.ok) {
      const data = await res.json();
      const rows: any[][] = data.values || [];
      if (rows.length > 0) {
        const kvMap = new Map<string, any>();
        let metadataParsed: any = {};

        for (const row of rows) {
          if (row[0] !== undefined) {
            const key = String(row[0]).trim().toLowerCase();
            const val = row[1];
            kvMap.set(key, val);
            if (key === '__metadata_json__' && typeof val === 'string') {
              try {
                metadataParsed = JSON.parse(val) || {};
              } catch {}
            }
          }
        }

        // Đọc danh sách members
        let membersList: FamilyMember[] = [];
        const rawMembers = kvMap.get('members json') || kvMap.get('members');
        if (typeof rawMembers === 'string') {
          try {
            const parsed = JSON.parse(rawMembers);
            if (Array.isArray(parsed)) membersList = parsed;
          } catch {}
        }
        if (membersList.length === 0 && Array.isArray(metadataParsed.members)) {
          membersList = metadataParsed.members;
        }

        // Đọc custom settings / ignoredDuplicatePairs
        let ignoredDuplicatePairs: string[] = [];
        const rawCustom = kvMap.get('custom settings');
        if (typeof rawCustom === 'string') {
          try {
            const parsed = JSON.parse(rawCustom);
            if (Array.isArray(parsed.ignoredDuplicatePairs)) {
              ignoredDuplicatePairs = parsed.ignoredDuplicatePairs;
            }
          } catch {}
        }
        if (ignoredDuplicatePairs.length === 0 && Array.isArray(metadataParsed.ignoredDuplicatePairs)) {
          ignoredDuplicatePairs = metadataParsed.ignoredDuplicatePairs;
        }

        const meta: SheetConfigMetadata = {
          schemaVersion: metadataParsed.schemaVersion || 2,
          status: metadataParsed.status || (kvMap.get('status') as any) || 'active',
          lastAction: metadataParsed.lastAction || (kvMap.get('last action') as any) || 'link',
          activeFileId: fileId,
          activeFileName: metadataParsed.activeFileName || kvMap.get('vault name') || 'Kho Sách Gia Đình',
          activeFileUrl: metadataParsed.activeFileUrl || `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
          adminEmail: metadataParsed.adminEmail || kvMap.get('admin email') || '',
          linkedAccountEmail: metadataParsed.linkedAccountEmail || kvMap.get('linked account') || '',
          linkedTimestamp: metadataParsed.linkedTimestamp || kvMap.get('linked timestamp') || '',
          linkedLocalTimeVi: metadataParsed.linkedLocalTimeVi || kvMap.get('linked timestamp') || '',
          updatedAt: metadataParsed.updatedAt || kvMap.get('updated at') || '',
          updatedAtVi: metadataParsed.updatedAtVi || kvMap.get('updated at') || '',
          appName: 'Kho Sách',
          appVersion: '1.0.0',
          ignoredDuplicatePairs,
        };

        return { metadata: meta, members: membersList };
      }
    }

    // 2. Fallback: Nếu chưa có tab __CONFIG__, thử đọc từ tab Config cũ
    const legacyUrl = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${CONFIG_SHEET_TITLE}!E1:F10`;
    const legacyRes = await fetch(legacyUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (legacyRes.ok) {
      const data = await legacyRes.json();
      const rows: any[][] = data.values || [];
      let fallbackStatus: 'active' | 'unlinked' | null = null;
      let fallbackAdmin = '';
      let metaParsed: any = {};

      for (const row of rows) {
        const key = String(row[0] || '').trim().toLowerCase();
        if (key === '__metadata_json__' && row[1]) {
          try {
            metaParsed = JSON.parse(row[1]) || {};
            if (metaParsed.status === 'active' || metaParsed.status === 'unlinked') {
              fallbackStatus = metaParsed.status;
            }
          } catch {}
        }
        if (key === 'status' && (row[1] === 'active' || row[1] === 'unlinked')) {
          fallbackStatus = row[1];
        }
        if (key === 'adminemail' && row[1]) {
          fallbackAdmin = row[1];
        }
      }

      if (fallbackStatus) {
        const membersResp = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${CONFIG_SHEET_TITLE}!A:C`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const membersList: FamilyMember[] = [];
        if (membersResp.ok) {
          const mData = await membersResp.json();
          const mRows: any[][] = mData.values || [];
          for (let i = 1; i < mRows.length; i++) {
            const r = mRows[i];
            if (!r || !r[0] || !String(r[0]).includes('@')) continue;
            membersList.push({
              email: String(r[0]).trim().toLowerCase(),
              role: (r[1] === 'Owner' || r[1] === 'Editor') ? r[1] : 'Viewer',
              addedAt: r[2] ? String(r[2]) : new Date().toISOString(),
            });
          }
        }

        const meta: SheetConfigMetadata = {
          ...metaParsed,
          status: fallbackStatus,
          adminEmail: fallbackAdmin || metaParsed.adminEmail || '',
          activeFileId: fileId,
          activeFileName: metaParsed.activeFileName || 'Kho Sách Gia Đình',
          activeFileUrl: `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
          appName: 'Kho Sách',
          updatedAt: metaParsed.updatedAt || new Date().toISOString(),
        };

        return { metadata: meta, members: membersList };
      }
    }

    return null;
  } catch (err) {
    console.warn('[DriveSync] readMasterSyncStateFromGoogleSheet failed:', err);
    return null;
  }
}

/**
 * Khởi tạo tiêu đề các cột chuẩn tiếng Việt cho các Tab (Khosach và __CONFIG__)
 */
async function initializeSheetHeaders(
  accessToken: string,
  spreadsheetId: string,
  userEmail: string,
  fileName?: string
) {
  try {
    const cleanEmail = (userEmail && userEmail.trim().toLowerCase()) || '';
    const activeFileName = fileName || 'Kho Sách Gia Đình';
    const activeFileUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?usp=drivesdk`;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const timeVi = formatVietnameseFullDate(nowMs);

    // 1. Tab Khosach
    const khosachHeader = [
      ['ID', 'Tên Sách', 'Tác Giả', 'Thể Loại', 'Nhà Xuất Bản', 'Ngày Cập Nhật', 'Đã AI']
    ];
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${KHOSACH_SHEET_TITLE}!A1:G1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: khosachHeader }),
    });

    // 2. Ghi cấu hình chuẩn vào Tab __CONFIG__ (A1:B10, KHÔNG CÓ AUDIT LOGS)
    const initialMembers: FamilyMember[] = cleanEmail
      ? [{ email: cleanEmail, role: 'Owner', addedAt: nowIso }]
      : [];

    await saveMasterSyncStateToGoogleSheet(accessToken, spreadsheetId, {
      status: 'active',
      lastAction: 'create',
      activeFileId: spreadsheetId,
      activeFileName,
      activeFileUrl,
      adminEmail: cleanEmail,
      linkedAccountEmail: cleanEmail,
      linkedTimestamp: nowIso,
      linkedLocalTimeVi: timeVi,
      updatedAt: nowIso,
      updatedAtVi: timeVi,
      members: initialMembers,
      ignoredDuplicatePairs: [],
    });

    // 3. Tab Config cũ (dự phòng)
    const configData = [
      ['Email', 'Role', 'AddedAt'],
      [cleanEmail, 'Owner', nowIso]
    ];
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!A1:C2?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: configData }),
    }).catch(() => {});
  } catch (err) {
    console.warn('[DriveSync] Khởi tạo Header dòng 1 hoàn tất có cảnh báo:', err);
  }
}

/**
 * 2. Đọc toàn bộ danh sách sách từ Google Sheet
 */
export async function fetchBooksFromGoogleSheet(
  accessToken: string,
  spreadsheetId: string
): Promise<BookRecord[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${KHOSACH_SHEET_TITLE}!A:G`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const errJson = await resp.json().catch(() => ({}));
    throw new Error(errJson?.error?.message || `Không thể tải dữ liệu từ Google Sheet (${resp.status})`);
  }

  const data = await resp.json();
  const rows: any[][] = data.values || [];
  if (rows.length <= 1) return [];

  const books: BookRecord[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[1]) continue;

    const rawId = String(row[0] || '').trim();
    const bookId = sanitizeDocId(rawId) || `sheet_${Date.now()}_${i}`;

    const title = String(row[1] || '').trim();
    if (!title || title.toLowerCase() === 'tên sách' || title.toLowerCase() === 'title') continue;

    const author = String(row[2] || 'Chưa rõ').trim();
    const category = sanitizeSingleCategory(String(row[3] || 'Chung'));
    const publisher = String(row[4] || '').trim();

    const rawDate = String(row[5] || '').trim();
    const updatedAt = parseVietnameseDate(rawDate);

    const rawAi = String(row[6] || '').toLowerCase().trim();
    const isNormalized = rawAi === 'có' || rawAi === '1' || rawAi === 'true' || rawAi === 'yes';

    books.push({
      id: bookId,
      title,
      author,
      category,
      publisher,
      is_ai_normalized: isNormalized,
      created_at: updatedAt,
      updated_at: updatedAt,
    });
  }

  return books;
}

/**
 * 3. Ghi đè toàn bộ danh sách sách đã làm sạch lên Google Sheet
 */
export async function saveBooksToGoogleSheet(
  accessToken: string,
  spreadsheetId: string,
  books: BookRecord[]
): Promise<void> {
  // Chuẩn bị mảng hàng
  const rows = [
    ['ID', 'Tên Sách', 'Tác Giả', 'Thể Loại', 'Nhà Xuất Bản', 'Ngày Cập Nhật', 'Đã AI'],
    ...books.map((b) => [
      b.id || '',
      b.title || '',
      b.author || 'Chưa rõ',
      b.category || 'Chung',
      b.publisher || '',
      formatVietnameseDate(b.updated_at || b.created_at || Date.now()),
      b.is_ai_normalized ? 'Có' : 'Chưa',
    ]),
  ];

  // Xóa vùng dữ liệu cũ trước để tránh rác
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${KHOSACH_SHEET_TITLE}!A:G:clear`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  }).catch(() => {});

  // Ghi toàn bộ dữ liệu mới
  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${KHOSACH_SHEET_TITLE}!A1?valueInputOption=USER_ENTERED`;
  const writeResp = await fetch(writeUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: rows }),
  });

  if (!writeResp.ok) {
    const errJson = await writeResp.json().catch(() => ({}));
    if (writeResp.status === 403) {
      throw new Error('READ_ONLY_SCOPE_OR_PERMISSION');
    }
    throw new Error(errJson?.error?.message || `Không thể lưu sách lên Google Sheet (${writeResp.status})`);
  }
}

/**
 * 4. Đọc danh sách thành viên gia đình từ Tab "__CONFIG__" (hoặc fallback Config)
 */
export async function fetchFamilyMembers(
  accessToken: string,
  spreadsheetId: string
): Promise<FamilyMember[]> {
  try {
    const state = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
    if (state?.members && state.members.length > 0) {
      return state.members;
    }

    // Fallback: Đọc từ tab Config cũ nếu chưa có __CONFIG__
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!A:C`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) return [];

    const data = await resp.json();
    const rows: any[][] = data.values || [];
    if (rows.length <= 1) return [];

    const members: FamilyMember[] = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[0]) continue;
      const email = String(row[0]).trim().toLowerCase();
      const roleRaw = String(row[1] || 'Viewer').trim();
      const role = (roleRaw === 'Owner' || roleRaw === 'Editor') ? roleRaw : 'Viewer';
      const addedAt = row[2] ? String(row[2]) : new Date().toISOString();

      if (email.includes('@')) {
        members.push({ email, role, addedAt });
      }
    }
    return members;
  } catch (err) {
    console.warn('[DriveSync] Không đọc được danh sách thành viên:', err);
    return [];
  }
}

/**
 * 5. Thêm thành viên gia đình & Cấp quyền truy cập Google Drive trực tiếp
 */
export async function addFamilyMember(
  accessToken: string,
  spreadsheetId: string,
  email: string,
  role: 'Editor' | 'Viewer'
): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Địa chỉ email Gmail không hợp lệ.');
  }

  // 1. Cấp quyền trên Google Drive API
  const driveRole = role === 'Editor' ? 'writer' : 'reader';
  const permissionUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?sendNotificationEmail=true`;
  const permPayload = {
    role: driveRole,
    type: 'user',
    emailAddress: cleanEmail,
  };

  const permResp = await fetch(permissionUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(permPayload),
  });

  if (!permResp.ok) {
    const errJson = await permResp.json().catch(() => ({}));
    throw new Error(errJson?.error?.message || `Lỗi cấp quyền Google Drive cho ${cleanEmail}`);
  }

  // 2. Ghi nhận thành viên vào Tab __CONFIG__ (A1:B10)
  const existingMembers = await fetchFamilyMembers(accessToken, spreadsheetId);
  const updatedMembers = existingMembers.filter((m) => m.email.toLowerCase() !== cleanEmail);
  updatedMembers.push({
    email: cleanEmail,
    role,
    addedAt: new Date().toISOString(),
  });

  const state = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
  await saveMasterSyncStateToGoogleSheet(accessToken, spreadsheetId, {
    ...(state?.metadata || { activeFileId: spreadsheetId, adminEmail: cleanEmail }),
    members: updatedMembers,
    updatedAt: new Date().toISOString(),
  });

  // Đồng bộ tab Config cũ (dự phòng)
  try {
    const configRows = [
      ['Email', 'Role', 'AddedAt'],
      ...updatedMembers.map((m) => [m.email, m.role, m.addedAt]),
    ];

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!A:C:clear`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }).catch(() => {});

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!A1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: configRows }),
    });
  } catch {}
}

export async function revokeFilePermission(
  accessToken: string,
  fileId: string,
  userEmail: string
): Promise<boolean> {
  const cleanEmail = userEmail.trim().toLowerCase();
  if (!accessToken || !fileId || !cleanEmail) return false;

  const listResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,emailAddress,type)&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listResponse.ok) return false;

  const data = await listResponse.json();
  const permission = (data.permissions || []).find(
    (item: { emailAddress?: string; type?: string }) =>
      item.type === 'user' && item.emailAddress?.trim().toLowerCase() === cleanEmail
  );
  if (!permission?.id) return true;

  const deleteResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${permission.id}?supportsAllDrives=true`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  return deleteResponse.ok || deleteResponse.status === 204;
}

/**
 * 6. Cập nhật quyền của thành viên gia đình (Editor / Viewer)
 */
export async function updateFamilyMemberRole(
  accessToken: string,
  spreadsheetId: string,
  email: string,
  newRole: 'Editor' | 'Viewer'
): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();
  const driveRole = newRole === 'Editor' ? 'writer' : 'reader';

  // 1. Cập nhật quyền trên Google Drive API
  try {
    const permListResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?fields=permissions(id,emailAddress,role)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (permListResp.ok) {
      const pData = await permListResp.json();
      const permItem = (pData.permissions || []).find(
        (p: any) => (p.emailAddress || '').toLowerCase() === cleanEmail
      );
      if (permItem && permItem.id) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions/${permItem.id}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ role: driveRole }),
        });
      } else {
        await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?sendNotificationEmail=false`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            role: driveRole,
            type: 'user',
            emailAddress: cleanEmail,
          }),
        });
      }
    }
  } catch (err) {
    console.warn('[DriveSync] Cập nhật permission trên Drive:', err);
  }

  // 2. Cập nhật Tab __CONFIG__ trong Google Sheet
  const existing = await fetchFamilyMembers(accessToken, spreadsheetId);
  const updatedMembers = existing.map((m) => {
    if (m.email.toLowerCase() === cleanEmail) {
      return { ...m, role: newRole };
    }
    return m;
  });

  if (!updatedMembers.some((m) => m.email.toLowerCase() === cleanEmail)) {
    updatedMembers.push({
      email: cleanEmail,
      role: newRole,
      addedAt: new Date().toISOString(),
    });
  }

  const state = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
  await saveMasterSyncStateToGoogleSheet(accessToken, spreadsheetId, {
    ...(state?.metadata || { activeFileId: spreadsheetId, adminEmail: cleanEmail }),
    members: updatedMembers,
    updatedAt: new Date().toISOString(),
  });

  // Đồng bộ tab Config cũ (dự phòng)
  try {
    const configRows = [
      ['Email', 'Role', 'AddedAt'],
      ...updatedMembers.map((m) => [m.email, m.role, m.addedAt]),
    ];

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!A:C:clear`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }).catch(() => {});

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!A1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: configRows }),
    });
  } catch {}
}

/**
 * 7. Xóa thành viên khỏi gia đình (Bảo vệ tuyệt đối danh sách thành viên còn lại)
 */
export async function removeFamilyMember(
  accessToken: string,
  spreadsheetId: string,
  email: string
): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();

  // 1. Đọc danh sách hiện tại trước, nếu không đọc được thì không xóa tab để tránh mất dữ liệu
  const existing = await fetchFamilyMembers(accessToken, spreadsheetId);

  // 2. Xóa permission trên Drive API
  try {
    const permListResp = await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?fields=permissions(id,emailAddress,role)`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (permListResp.ok) {
      const pData = await permListResp.json();
      const permItem = (pData.permissions || []).find((p: any) => (p.emailAddress || '').toLowerCase() === cleanEmail);
      if (permItem && permItem.id) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions/${permItem.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      }
    }
  } catch (err) {
    console.warn('[DriveSync] Xóa permission trên Drive:', err);
  }

  // 3. Cập nhật lại Tab __CONFIG__ với danh sách còn lại
  const remaining = existing.filter((m) => m.email.toLowerCase() !== cleanEmail);

  const state = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
  await saveMasterSyncStateToGoogleSheet(accessToken, spreadsheetId, {
    ...(state?.metadata || { activeFileId: spreadsheetId, adminEmail: cleanEmail }),
    members: remaining,
    updatedAt: new Date().toISOString(),
  });

  // Đồng bộ tab Config cũ (dự phòng)
  try {
    const configRows = [
      ['Email', 'Role', 'AddedAt'],
      ...remaining.map((m) => [m.email, m.role, m.addedAt]),
    ];

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!A:C:clear`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }).catch(() => {});

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!A1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: configRows }),
    });
  } catch {}
}

/**
 * 7. Thuật toán Đồng Bộ 2 Chiều: Google Drive là Master Database tuyệt đối
 * - Dữ liệu trên Google Drive luôn là Single Source of Truth (Sở hữu tối cao).
 * - Mọi thiết bị local sẽ cập nhật trùng khớp tuyệt đối với Master Database trên Drive sau khi đồng bộ.
 */
export async function syncBooksTwoWay(
  localBooks: BookRecord[],
  accessToken: string,
  spreadsheetId: string,
  userRole: UserRole = 'ADMIN'
): Promise<{
  mergedBooks: BookRecord[];
  cloudCount: number;
  localCount: number;
  hasChanges: boolean;
}> {
  console.log(`[DriveSync] Đồng bộ dữ liệu - Đảm bảo tệp Drive là Master Database...`);

  // 1. Kéo dữ liệu gốc từ Master Database trên Google Drive
  const remoteBooks = await fetchBooksFromGoogleSheet(accessToken, spreadsheetId);

  // Tự động đồng bộ danh sách cặp không trùng lặp (Ignored Duplicates) từ Tab Config ẩn
  try {
    await syncIgnoredDuplicatePairsWithDrive(accessToken, spreadsheetId);
  } catch {}

  // Nếu là VIEWER, dữ liệu trên Drive luôn là tuyệt đối, không ghi đè, không thay đổi
  if (userRole === 'VIEWER') {
    return {
      mergedBooks: remoteBooks,
      cloudCount: remoteBooks.length,
      localCount: localBooks.length,
      hasChanges: true, // Cho phép ghi đè hoàn toàn cục bộ
    };
  }

  // 2. Với ADMIN/EDITOR, hợp nhất dựa trên nguyên tắc Master Database:
  // - Toàn bộ sách trên Drive (Master) được giữ nguyên.
  // - Chỉ các sách mới tạo hoặc sửa đổi sau thời gian trên Drive mới được đồng bộ lên Master.
  const mergedMap = new Map<string, BookRecord>();

  // Đưa toàn bộ sách từ Master Database trên Drive vào trước
  for (const rBook of remoteBooks) {
    if (rBook.id) {
      mergedMap.set(rBook.id, rBook);
    }
  }

  let localChangesMade = false;

  for (const lBook of localBooks) {
    if (!lBook.id) continue;
    const existing = mergedMap.get(lBook.id);
    if (!existing) {
      // Sách mới tạo hoàn toàn ở local chưa có trên Drive -> Đồng bộ lên Master
      mergedMap.set(lBook.id, lBook);
      localChangesMade = true;
    } else {
      // Sách có ở cả 2 nơi: Nếu bản local được chỉnh sửa mới hơn, cập nhật lên Master
      const lTime = lBook.updated_at || 0;
      const rTime = existing.updated_at || existing.created_at || 0;
      if (lTime > rTime) {
        mergedMap.set(lBook.id, {
          ...existing,
          ...lBook,
          updated_at: lTime,
        });
        localChangesMade = true;
      }
    }
  }

  const finalMergedList = Array.from(mergedMap.values());

  // 3. Nếu phát sinh thay đổi, ghi đè cập nhật lại lên Master Database trên Google Drive
  if (localChangesMade || finalMergedList.length !== remoteBooks.length) {
    await saveBooksToGoogleSheet(accessToken, spreadsheetId, finalMergedList);
  }

  return {
    mergedBooks: finalMergedList,
    cloudCount: remoteBooks.length,
    localCount: localBooks.length,
    hasChanges: true, // Luôn đồng nhất local khớp tuyệt đối với Master Database
  };
}

/**
 * Dynamic Authorization Verification: Xác thực chéo vai trò dựa trên email đối chiếu với tab __CONFIG__ ẩn
 */
export async function determineCurrentUserRole(
  accessToken: string,
  spreadsheetId: string,
  userEmail: string
): Promise<UserRole> {
  const cleanEmail = userEmail.trim().toLowerCase();
  if (!cleanEmail) throw new Error('Không xác định được email tài khoản Google hiện tại.');

  const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
  if (!syncState || !syncState.metadata) throw new Error('Không thể đọc cấu hình quyền của Google Sheet.');

  const { metadata, members } = syncState;
  if (metadata.status !== 'active' || metadata.lastAction === 'unlink') {
    throw new Error('WORKSPACE_UNLINKED');
  }

  if (metadata.adminEmail?.trim().toLowerCase() === cleanEmail) return 'ADMIN';

  const matched = members.find((member) => member.email.trim().toLowerCase() === cleanEmail);
  if (matched?.role === 'Owner') return 'ADMIN';
  if (matched?.role === 'Editor') return 'EDITOR';
  if (matched?.role === 'Viewer') return 'VIEWER';
  throw new Error('Tài khoản Google hiện tại không có trong danh sách thành viên của Workspace.');
}

/**
 * Đọc Metadata cấu hình trạng thái (active / unlinked) từ Tab __CONFIG__ ẩn của Google Sheet
 */
export async function fetchSheetConfigMetadata(
  accessToken: string,
  spreadsheetId: string
): Promise<SheetConfigMetadata | null> {
  try {
    const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
    return syncState?.metadata || null;
  } catch (err) {
    console.warn('[DriveSync] fetchSheetConfigMetadata failed:', err);
    return null;
  }
}

/**
 * Cập nhật trạng thái liên kết (active hoặc unlinked) trực tiếp lên Tab __CONFIG__ ẩn của Google Sheet
 * Tuyệt đối không lưu audit logs, bảo đảm cấu hình nhẹ và nhanh.
 */
export async function updateSheetConfigStatus(
  accessToken: string,
  spreadsheetId: string,
  status: 'active' | 'unlinked',
  adminEmail?: string,
  fileName?: string
): Promise<void> {
  const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
  const existing = syncState?.metadata;
  const members = syncState?.members || [];
  const adminFromMembers = members.find((member) => member.role === 'Owner')?.email;
  const storedAdmin = (existing?.adminEmail || adminFromMembers || '').trim().toLowerCase();
  const requestingUser = (adminEmail || '').trim().toLowerCase();

  if (status === 'unlinked' && (!storedAdmin || !requestingUser || storedAdmin !== requestingUser)) {
    throw new Error('Chỉ Admin đã đăng ký trong cấu hình mới được hủy liên kết Workspace.');
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timeVi = formatVietnameseFullDate(nowMs);
  const currentAdmin = existing?.adminEmail || adminFromMembers || adminEmail || '';
  const currentFileName = fileName || existing?.activeFileName || 'Kho Sách Gia Đình';
  const fileUrl = existing?.activeFileUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?usp=drivesdk`;

  await saveMasterSyncStateToGoogleSheet(accessToken, spreadsheetId, {
    ...existing,
    schemaVersion: 2,
    status,
    lastAction: status === 'active' ? 'link' : 'unlink',
    activeFileId: spreadsheetId,
    activeFileName: currentFileName,
    activeFileUrl: fileUrl,
    adminEmail: currentAdmin,
    linkedAccountEmail: currentAdmin,
    linkedTimestamp: existing?.linkedTimestamp || nowIso,
    linkedLocalTimeVi: existing?.linkedLocalTimeVi || timeVi,
    updatedAt: nowIso,
    updatedAtVi: timeVi,
    appName: existing?.appName || 'Kho Sách Gia Đình',
    appVersion: existing?.appVersion || '1.0.0',
    members,
    ignoredDuplicatePairs: existing?.ignoredDuplicatePairs || [],
  });

  console.log(`[DriveSync] Đã cập nhật trạng thái sheet (${spreadsheetId}) thành: ${status}`);
}

export async function unlinkWorkspace(
  accessToken: string,
  spreadsheetId: string,
  userEmail: string
): Promise<{ failedRevocations: string[] }> {
  const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
  const metadata = syncState?.metadata;
  const members = syncState?.members || [];
  const adminEmail = (metadata?.adminEmail || members.find((member) => member.role === 'Owner')?.email || '')
    .trim()
    .toLowerCase();

  if (!adminEmail || adminEmail !== userEmail.trim().toLowerCase()) {
    throw new Error('Chỉ Admin của Workspace mới có thể hủy liên kết.');
  }

  await updateSheetConfigStatus(accessToken, spreadsheetId, 'unlinked', userEmail);
  const failedRevocations: string[] = [];
  for (const member of members) {
    if (member.role === 'Owner' || member.email.trim().toLowerCase() === adminEmail) continue;
    if (!(await revokeFilePermission(accessToken, spreadsheetId, member.email))) {
      failedRevocations.push(member.email);
    }
  }
  if (failedRevocations.length > 0) {
    console.warn('[DriveSync] Workspace unlinked, but some Drive permissions could not be revoked:', failedRevocations);
  }
  return { failedRevocations };
}

/**
 * Hủy liên kết Workspace và dọn sạch trạng thái trên máy thành viên
 */
export async function setMasterSyncUnlinked(
  accessToken: string,
  userEmail?: string,
  explicitFileId?: string
): Promise<void> {
  try {
    localStorage.setItem('explicitly_unlinked', 'true');
    sessionStorage.setItem('explicitly_unlinked', 'true');

    const targetFileId = explicitFileId || (() => {
      try {
        return (JSON.parse(localStorage.getItem('library_spreadsheet_info_v2') || 'null') as SpreadsheetInfo | null)?.id;
      } catch {
        return null;
      }
    })();

    if (!targetFileId || !accessToken) return;

    const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, targetFileId);
    const adminEmailVal = syncState?.metadata.adminEmail || userEmail || 'admin';
    const cleanUser = userEmail?.trim().toLowerCase();
    const adminEmailClean = adminEmailVal.trim().toLowerCase();

    if (cleanUser && adminEmailClean && cleanUser !== adminEmailClean) {
      console.warn(`[Unlink Security] Tài khoản ${cleanUser} không phải Admin.`);
      return;
    }

    if (syncState?.members && syncState.members.length > 0) {
      for (const member of syncState.members) {
        if (member.role !== 'Owner' && member.email) {
          await revokeFilePermission(accessToken, targetFileId, member.email).catch(() => {});
        }
      }
    }

    await updateSheetConfigStatus(accessToken, targetFileId, 'unlinked', userEmail);
  } catch (err) {
    console.warn('[Unlink] Lỗi setMasterSyncUnlinked:', err);
  }
}

/**
 * Ghi nhận nhật ký xử lý sách trùng lặp vào Metadata Config (Không ghi audit logs)
 */
export async function recordDuplicateResolutionRecord(
  accessToken: string,
  spreadsheetId: string,
  logItem: Omit<DuplicateResolutionLog, 'resolvedAt'>
): Promise<void> {
  try {
    const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
    if (!syncState) return;

    const existing = syncState.metadata;
    const fullLogItem: DuplicateResolutionLog = {
      ...logItem,
      resolvedAt: new Date().toISOString(),
    };

    const updatedResolved = [...(existing.resolvedDuplicates || []), fullLogItem];
    await saveMasterSyncStateToGoogleSheet(accessToken, spreadsheetId, {
      ...existing,
      resolvedDuplicates: updatedResolved,
      members: syncState.members,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[DriveSync] recordDuplicateResolutionRecord error:', err);
  }
}

const IGNORED_DUPLICATES_LOCAL_KEY = 'library_ignored_duplicates_v2';

/**
 * Đọc danh sách các cặp sách đã xác nhận không trùng từ bộ nhớ thiết bị
 */
export function getLocalIgnoredDuplicatePairs(): string[] {
  try {
    const raw = localStorage.getItem(IGNORED_DUPLICATES_LOCAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

/**
 * Lưu danh sách các cặp sách đã xác nhận không trùng vào bộ nhớ thiết bị
 */
export function saveLocalIgnoredDuplicatePairs(pairs: string[]): void {
  try {
    localStorage.setItem(IGNORED_DUPLICATES_LOCAL_KEY, JSON.stringify(Array.from(new Set(pairs))));
  } catch {}
}

/**
 * Đồng bộ danh sách các cặp sách đã xác nhận không trùng với Google Sheet (Tab __CONFIG__ ẩn)
 */
export async function syncIgnoredDuplicatePairsWithDrive(
  accessToken: string,
  spreadsheetId: string,
  newPairsToAdd?: string[]
): Promise<string[]> {
  try {
    const local = getLocalIgnoredDuplicatePairs();
    const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
    const existingMeta = syncState?.metadata;
    const remote = existingMeta?.ignoredDuplicatePairs || [];

    const mergedSet = new Set<string>([...local, ...remote, ...(newPairsToAdd || [])]);
    const mergedList = Array.from(mergedSet);

    saveLocalIgnoredDuplicatePairs(mergedList);

    if (mergedList.length !== remote.length || (newPairsToAdd && newPairsToAdd.length > 0)) {
      if (existingMeta) {
        await saveMasterSyncStateToGoogleSheet(accessToken, spreadsheetId, {
          ...existingMeta,
          ignoredDuplicatePairs: mergedList,
          members: syncState?.members || [],
          updatedAt: new Date().toISOString(),
        });
        console.log(`[DriveSync] Đã lưu ${mergedList.length} cặp không trùng lặp lên Google Drive __CONFIG__!`);
      }
    }

    return mergedList;
  } catch (err) {
    console.warn('[DriveSync] syncIgnoredDuplicatePairsWithDrive error:', err);
    return getLocalIgnoredDuplicatePairs();
  }
}

/**
 * Tự động tìm Workspace active mà tài khoản hiện tại được xác nhận là Admin hoặc Thành viên.
 * Đọc trực tiếp tab __CONFIG__ từ từng file bảng tính khả dụng để xác định quyền chính xác.
 */
export async function autoDiscoverSharedSpreadsheets(
  accessToken: string,
  userEmail: string
): Promise<SpreadsheetInfo[]> {
  try {
    const cleanEmail = userEmail.trim().toLowerCase();
    const spreadsheets = await fetchUserSpreadsheetsFromDrive(accessToken);
    const discovered: SpreadsheetInfo[] = [];

    const savedId = (() => {
      try {
        return (JSON.parse(localStorage.getItem('library_spreadsheet_info_v2') || 'null') as SpreadsheetInfo | null)?.id;
      } catch {
        return undefined;
      }
    })();
    const orderedSheets = [...spreadsheets].sort((a, b) => {
      if (a.id === savedId) return -1;
      if (b.id === savedId) return 1;
      return 0;
    });

    const candidates = orderedSheets.slice(0, 100);
    for (let i = 0; i < candidates.length; i += 6) {
      const batch = candidates.slice(i, i + 6);
      const verified = await Promise.all(
        batch.map(async (sheet) => {
          const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, sheet.id);
          if (!syncState || !syncState.metadata) return null;

          const meta = syncState.metadata;
          if (meta.status !== 'active' || meta.lastAction === 'unlink') return null;

          const adminEmail = (meta.adminEmail || '').trim().toLowerCase();
          const isAdmin = adminEmail === cleanEmail;
          const members = syncState.members || [];
          const matchedMember = members.find((member) => member.email.trim().toLowerCase() === cleanEmail);

          if (!isAdmin && !matchedMember) return null;

          const resolvedSheet: SpreadsheetInfo = {
            id: sheet.id,
            name: meta.activeFileName || sheet.name || 'Kho Sách Gia Đình',
            webViewLink: sheet.webViewLink || `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`,
          };

          saveKnownSpreadsheet(resolvedSheet);
          if (isAdmin && adminEmail) {
            synchronizeDrivePermissionsWithJsonMembers(accessToken, sheet.id, adminEmail).catch((err) => {
              console.warn('[AutoDiscover] Permission audit failed:', err);
            });
          }
          return resolvedSheet;
        })
      );

      discovered.push(...verified.filter((sheet): sheet is SpreadsheetInfo => sheet !== null));
      if (discovered.length > 0) break;
    }
    return discovered;
  } catch (err) {
    console.warn('[DriveSync] autoDiscoverSharedSpreadsheets failed:', err);
    return [];
  }
}

/**
 * ĐỒNG BỘ TOÀN VẸN CHÉO (PERMISSION AUDIT SYNC)
 * Đối chiếu danh sách quyền thực tế của Google Drive khớp hoàn toàn với danh sách thành viên được duyệt trong cấu hình JSON
 */
export async function synchronizeDrivePermissionsWithJsonMembers(
  accessToken: string,
  spreadsheetId: string,
  adminEmail: string
): Promise<void> {
  try {
    if (!spreadsheetId || !accessToken) return;
    const cleanAdminEmail = adminEmail.trim().toLowerCase();
    const members = await fetchFamilyMembers(accessToken, spreadsheetId);

    // 1. Lấy danh sách quyền đang tồn tại trên Google Drive
    const listUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?fields=permissions(id,emailAddress,role,type)&supportsAllDrives=true`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) return;

    const data = await listRes.json();
    const drivePermissions: Array<{ id: string; emailAddress?: string; role?: string; type?: string }> = data.permissions || [];

    // Bản đồ tra cứu vai trò các thành viên theo Email trong Tab Config
    const memberMap = new Map<string, 'Owner' | 'Editor' | 'Viewer'>();
    members.forEach((m) => {
      memberMap.set(m.email.trim().toLowerCase(), m.role);
    });

    // 2. Kiểm tra thu hồi các quyền dư thừa không nằm trong danh sách được duyệt hoặc sai vai trò
    for (const p of drivePermissions) {
      if (p.role === 'owner') continue; // Không can thiệp chủ sở hữu gốc của file

      const emailClean = p.emailAddress?.trim().toLowerCase();
      if (!emailClean) continue;

      if (emailClean === cleanAdminEmail) continue; // Giữ nguyên quyền Admin gốc

      const expectedRoleInSheet = memberMap.get(emailClean);
      if (!expectedRoleInSheet) {
        // Thu hồi quyền của email lạ không có tên trong cấu hình Config
        console.log(`[Permission Audit] Thu hồi quyền của email lạ: ${emailClean}`);
        const delUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions/${p.id}`;
        await fetch(delUrl, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } else {
        // Khớp vai trò thực tế trên Drive: Editor -> writer, Viewer -> reader
        const expectedDriveRole = expectedRoleInSheet === 'Editor' ? 'writer' : 'reader';
        if (p.role !== expectedDriveRole) {
          console.log(`[Permission Audit] Sửa vai trò của ${emailClean} thành ${expectedDriveRole}`);
          // Cập nhật lại quyền bằng cách xóa đi thêm lại hoặc patch
          const delUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions/${p.id}`;
          await fetch(delUrl, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` },
          });

          // Thêm lại với quyền mới chuẩn xác
          const createUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?sendNotificationEmail=false`;
          await fetch(createUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              role: expectedDriveRole,
              type: 'user',
              emailAddress: emailClean,
            }),
          });
        }
      }
    }
  } catch (err) {
    console.warn('[DriveSync] Lỗi kiểm toán đồng bộ quyền Google Drive:', err);
  }
}

/**
 * Kiểm tra xem ứng dụng có quyền GHI (drive.file) đối với tệp spreadsheet này hay không.
 * Nếu không ghi được (ví dụ tệp ngoài do người dùng chọn), trả về false.
 */
export async function verifySpreadsheetWriteAccess(
  accessToken: string,
  spreadsheetId: string,
  userEmail: string
): Promise<boolean> {
  try {
    // 1. Kiểm tra cấu trúc các Sheet trước
    const metaResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaResp.ok) return false;

    const meta = await metaResp.json();
    const sheetTitles = (meta.sheets || []).map((s: any) => s.properties?.title);

    const hasKhosach = sheetTitles.includes(KHOSACH_SHEET_TITLE);
    const hasConfig = sheetTitles.includes(CONFIG_SHEET_TITLE);

    // 2. Thử tạo các Tab thiếu
    if (!hasKhosach || !hasConfig) {
      const requests: any[] = [];
      if (!hasKhosach) {
        requests.push({
          addSheet: {
            properties: { title: KHOSACH_SHEET_TITLE, gridProperties: { frozenRowCount: 1 } },
          },
        });
      }
      if (!hasConfig) {
        requests.push({
          addSheet: {
            properties: { title: CONFIG_SHEET_TITLE, gridProperties: { frozenRowCount: 1 } },
          },
        });
      }

      const batchResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
      });

      if (!batchResp.ok) return false; // Thất bại do 403 Forbidden (chỉ có quyền đọc)
      await initializeSheetHeaders(accessToken, spreadsheetId, userEmail);
    } else {
      // 3. Nếu đã có sẵn cả 2 Tab, thực hiện ghi thử 1 ô dữ liệu trong Tab "Config" để kiểm nghiệm quyền Ghi thực tế
      const testResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!D1?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [['AppChecked']] }),
      });
      if (!testResp.ok) {
        return false; // Thất bại do không có quyền ghi (403 Forbidden)
      }
    }

    return true;
  } catch {
    return false;
  }
}
