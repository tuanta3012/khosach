import { BookRecord, UserRole } from '../types';
import { sanitizeDocId, sanitizeSingleCategory } from '../utils/driveSyncClient';
import { checkDuplicateBook } from '../utils/fuzzyMatcher';
import { getAccessToken } from './googleAuthService';
import { saveStoredGeminiApiKeys } from './geminiService';
import {
  getPendingBookMutations,
  removePendingBookMutationsByIds,
  clearPendingBookMutations,
  isMasterRestoreRequired,
  setMasterRestoreRequired,
} from '../utils/localBooksStorage';
import { log } from '../utils/logger';
import {
  removeAssignedFilesForWorkspace,
  removeAssignedFileForMember,
  consumeAssignedFileForMember,
  publishAssignedFile,
  publishAssignedFilesForMembers,
} from './firebaseShareRelayService';

export interface FamilyMember {
  email: string;
  role: 'Owner' | 'Editor' | 'Viewer';
  addedAt: string;
  permissionId?: string;
  apiKey?: string;
  apiKeys?: string[];
  apiKeyUpdatedAt?: string;
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
  lastAction?: 'create' | 'link' | 'switch' | 'unlink' | 'sync' | 'update';
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
  userApiKeys?: Record<string, string[]>;
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
  userApiKeys?: Record<string, string[]>;
  customSettings?: Record<string, any>;
}

export const KHOSACH_SHEET_TITLE = 'Khosach';
export const MASTER_CONFIG_SHEET_TITLE = '__CONFIG__';
export const CONFIG_SHEET_TITLE = '__CONFIG__';
const KNOWN_SPREADSHEETS_STORAGE_KEY = 'library_known_spreadsheets_v2';
export const APP_PROPERTY_KEY = 'app';
export const APP_PROPERTY_VALUE = 'khosach_app';

export const DRIVE_APP_TAG = {
  key: 'khosach_app_id',
  value: 'com.khosach.app',
  appKey: 'app_id',
  appValue: 'com.khosach.app',
  legacyKey: 'app',
  legacyValue: 'khosach_app',
};

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

    // 1. Kiểm tra qua Drive API trước
    const url = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=id,name,trashed,appProperties&supportsAllDrives=true`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.trashed) {
        return { exists: false, trashed: true, name: data.name, error: 'FILE_TRASHED' };
      }
      return {
        exists: true,
        trashed: false,
        name: data.name,
      };
    }

    // 2. Nếu Drive API trả về lỗi (404/403 rất thường xảy ra với tài khoản thành viên chỉ được chia sẻ file qua scope drive.file):
    // Fallback: Kiểm tra trực tiếp qua Sheets API v4
    try {
      const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties.title`;
      const sheetsResp = await fetch(sheetsUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (sheetsResp.ok) {
        const sData = await sheetsResp.json();
        return {
          exists: true,
          trashed: false,
          name: sData.properties?.title || 'Kho Sách Gia Đình',
        };
      } else if (sheetsResp.status === 404) {
        // Cả Drive API và Sheets API đều báo 404 -> File thực sự không tồn tại
        return { exists: false, trashed: false, error: 'FILE_NOT_FOUND' };
      }
    } catch (sheetErr) {
      console.warn('[DriveSync] Sheets API status check fallback error:', sheetErr);
    }

    if (resp.status === 404) {
      return { exists: false, trashed: false, error: 'FILE_NOT_FOUND' };
    }

    const err = await resp.json().catch(() => ({}));
    return { exists: true, trashed: false, error: err?.error?.message || `HTTP_${resp.status}` };
  } catch (err: any) {
    console.warn('[DriveSync] checkSpreadsheetStatusOnDrive network error:', err);
    return { exists: true, trashed: false, error: err?.message || 'NETWORK_ERROR' };
  }
}

/**
 * Gắn nhãn com.khosach.app vào thuộc tính ẩn appProperties của tệp trên Google Drive
 */
export async function tagSpreadsheetAsAppCreated(
  accessToken: string,
  spreadsheetId: string
): Promise<void> {
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=id,name,appProperties&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appProperties: {
          khosach_app_id: 'com.khosach.app',
          app_id: 'com.khosach.app',
          app: 'com.khosach.app',
          created_by: 'com.khosach.app',
          workspace_type: 'family_library',
          status: 'active',
        },
      }),
    });
  } catch (err) {
    console.warn('[DriveSync] Gắn thẻ appProperties thất bại:', err);
  }
}

/**
 * Kiểm tra xác thực một Google Sheet xem có phải là file do App Tủ Sách Gia Đình tạo hay không.
 * Lọc theo điều kiện nhãn com.khosach.app
 */
export async function isBookLibrarySpreadsheet(
  _accessToken: string,
  _spreadsheetId: string,
  appProps?: any
): Promise<boolean> {
  return Boolean(
    appProps &&
      (appProps['khosach_app_id'] === 'com.khosach.app' ||
        appProps['app_id'] === 'com.khosach.app' ||
        appProps['app'] === 'com.khosach.app' ||
        appProps[APP_PROPERTY_KEY] === APP_PROPERTY_VALUE)
  );
}

/**
 * Lấy các Google Sheet Drive API cho phép ứng dụng nhìn thấy, gồm file được chia sẻ,
 * file có appProperties và file có tên thường dùng của ứng dụng.
 */
export async function fetchUserSpreadsheetsFromDrive(
  accessToken: string
): Promise<SpreadsheetInfo[]> {
  const map = new Map<string, SpreadsheetInfo>();

  // Nạp sẵn các file đã từng lưu trong máy trước (tức thì 0ms)
  getKnownSpreadsheets().forEach((s) => map.set(s.id, s));

  if (!accessToken) {
    return Array.from(map.values());
  }

  // Quét đa nguồn: Lọc trực tiếp theo nhãn appProperties ngầm com.khosach.app, File sở hữu và File chia sẻ
  const queries = [
    `appProperties has { key='khosach_app_id' and value='com.khosach.app' } and trashed = false`,
    `appProperties has { key='app_id' and value='com.khosach.app' } and trashed = false`,
    `appProperties has { key='app' and value='com.khosach.app' } and trashed = false`,
    `appProperties has { key='${APP_PROPERTY_KEY}' and value='${APP_PROPERTY_VALUE}' } and trashed = false`,
    "trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'",
    "sharedWithMe = true and trashed = false",
    "sharedWithMe = true",
    "trashed = false",
  ];

  await Promise.all(
    queries.map(async (q) => {
      try {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.set('pageSize', '50');
        url.searchParams.set('fields', 'files(id,name,webViewLink,trashed,modifiedTime,appProperties,sharedWithMeTime,mimeType)');
        url.searchParams.set('orderBy', 'modifiedTime desc');
        url.searchParams.set('supportsAllDrives', 'true');
        url.searchParams.set('includeItemsFromAllDrives', 'true');
        url.searchParams.set('q', q);

        const response = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          return;
        }

        const data = await response.json();
        for (const file of data.files || []) {
          if (!file.id || file.trashed) continue;
          if (file.mimeType && file.mimeType !== 'application/vnd.google-apps.spreadsheet' && !file.name?.toLowerCase().includes('kho sach') && !file.name?.toLowerCase().includes('kho sách') && !file.name?.toLowerCase().includes('tu sach') && !file.name?.toLowerCase().includes('tủ sách')) {
            continue;
          }
          map.set(file.id, {
            id: file.id,
            name: file.name || 'Kho Sách Gia Đình',
            webViewLink: file.webViewLink || `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
          });
        }
      } catch (err) {
        console.warn('[DriveSync] Quét danh sách Google Sheet từ Drive gặp lỗi:', err);
      }
    })
  );

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
  console.log(`[DriveSync] Đang tạo mới Google Sheet tốc độ cao: "${customTitle}"...`);
  
  let spreadsheetId = '';
  let webViewLink = '';
  let activeToken = accessToken;

  // 1. Tạo trực tiếp Spreadsheet có sẵn 2 Tab (Khosach & __CONFIG__) qua Sheets API v4
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
          title: MASTER_CONFIG_SHEET_TITLE,
          hidden: true,
          gridProperties: { rowCount: 30, columnCount: 5 },
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

  if (createResp.ok) {
    const createdData = await createResp.json();
    spreadsheetId = createdData.spreadsheetId;
    webViewLink = createdData.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  } else {
    // Fallback: Thử tạo qua Drive API nếu Sheets API gặp trở ngại
    try {
      const driveCreateResp = await fetch('https://www.googleapis.com/drive/v3/files', {
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

      if (driveCreateResp.ok) {
        const driveData = await driveCreateResp.json();
        spreadsheetId = driveData.id;
        webViewLink = driveData.webViewLink || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
        await ensureSpreadsheetTabs(activeToken, spreadsheetId, userEmail);
      }
    } catch (err) {
      console.warn('[DriveSync] Drive API fallback create error:', err);
    }
  }

  if (!spreadsheetId) {
    throw new Error('Không thể tạo file Google Sheet. Vui lòng kiểm tra quyền truy cập Google.');
  }

  // Gắn tag appProperties trên Google Drive và ghi tiêu đề dòng 1
  tagSpreadsheetAsAppCreated(activeToken, spreadsheetId).catch(() => {});
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
    const masterConfigSheet = sheets.find((s) => s.properties?.title === MASTER_CONFIG_SHEET_TITLE);
    const legacyConfigSheet = sheets.find((s) => s.properties?.title === 'Config');

    const requests: any[] = [];

    // 1. Nếu chưa có Tab Khosach:
    if (!hasKhosach) {
      const defaultSheet = sheets.find(
        (s) => s.properties?.title !== MASTER_CONFIG_SHEET_TITLE && s.properties?.title !== 'Config'
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

    // 2. Nếu chưa có Tab __CONFIG__:
    if (!masterConfigSheet) {
      if (legacyConfigSheet && legacyConfigSheet.properties?.sheetId !== undefined) {
        // Chuyển đổi tab Config cũ sang __CONFIG__ chuẩn (mặc định ẩn an toàn)
        requests.push({
          updateSheetProperties: {
            properties: {
              sheetId: legacyConfigSheet.properties.sheetId,
              title: MASTER_CONFIG_SHEET_TITLE,
              hidden: true,
              gridProperties: { rowCount: 30, columnCount: 5 },
            },
            fields: 'title,hidden,gridProperties',
          },
        });
      } else {
        requests.push({
          addSheet: {
            properties: {
              title: MASTER_CONFIG_SHEET_TITLE,
              index: 1,
              hidden: true,
              gridProperties: { rowCount: 30, columnCount: 5 },
            },
          },
        });
      }
    } else if (!masterConfigSheet.properties?.hidden) {
      // Đảm bảo tab __CONFIG__ luôn được ẩn an toàn để tránh user vô tình sửa
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: masterConfigSheet.properties.sheetId,
            hidden: true,
          },
          fields: 'hidden',
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
      // Chỉ khởi tạo headers nếu thực sự THIẾU Tab Khosach hoặc THIẾU Tab __CONFIG__
      // TUYỆT ĐỐI KHÔNG gọi initializeSheetHeaders nếu tab __CONFIG__ đã tồn tại (ví dụ chỉ đổi thuộc tính hidden)
      if (!hasKhosach || !masterConfigSheet) {
        await initializeSheetHeaders(accessToken, spreadsheetId, userEmail);
      }
    }

    // 3. Dọn dẹp các Tab thừa ngoài Khosach và __CONFIG__ (xóa tab Config cũ nếu đã có __CONFIG__)
    const metaResp2 = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (metaResp2.ok) {
      const meta2 = await metaResp2.json();
      const sheets2: any[] = meta2.sheets || [];
      const extraSheets = sheets2.filter(
        (s) => s.properties?.title !== KHOSACH_SHEET_TITLE && s.properties?.title !== MASTER_CONFIG_SHEET_TITLE
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

    // Defensive: Nếu không truyền danh sách thành viên hoặc mảng rỗng nhưng trên sheet đã có thành viên,
    // đọc lại từ sheet để bảo toàn (trừ khi hành động là xóa hẳn hoặc hủy liên kết)
    let finalMembers = state.members;
    let resolvedAdminEmail = (state.adminEmail || '').trim().toLowerCase();
    let resolvedFileName = (state.activeFileName || '').trim();

    if (!finalMembers || (Array.isArray(finalMembers) && finalMembers.length === 0) || !resolvedAdminEmail || !resolvedFileName || resolvedFileName === 'Kho Sách Gia Đình') {
      try {
        const existing = await readMasterSyncStateFromGoogleSheet(accessToken, fileId);
        if ((!finalMembers || (Array.isArray(finalMembers) && finalMembers.length === 0)) && existing?.members && existing.members.length > 0) {
          if (state.lastAction !== 'unlink' && state.lastAction !== 'switch') {
            finalMembers = existing.members;
          }
        }
        if (!resolvedAdminEmail && existing?.metadata?.adminEmail) {
          resolvedAdminEmail = existing.metadata.adminEmail.trim().toLowerCase();
        }
        if ((!resolvedFileName || resolvedFileName === 'Kho Sách Gia Đình') && existing?.metadata?.activeFileName && existing.metadata.activeFileName !== 'Kho Sách Gia Đình') {
          resolvedFileName = existing.metadata.activeFileName;
        }
      } catch (e) {
        finalMembers = finalMembers || [];
      }
    }

    // Tự động đối chiếu tên thật trực tiếp từ Google Drive / Sheets API để không bao giờ bị gán nhầm tên mặc định
    if (!resolvedFileName || resolvedFileName === 'Kho Sách Gia Đình') {
      try {
        const liveDriveStatus = await checkSpreadsheetStatusOnDrive(accessToken, fileId);
        if (liveDriveStatus.name && liveDriveStatus.name.trim()) {
          resolvedFileName = liveDriveStatus.name.trim();
        }
      } catch {}
    }

    const members = (finalMembers || []).map((m) => ({
      email: m.email,
      role: m.role,
      addedAt: m.addedAt,
    }));

    const resolvedLinkedEmail = state.linkedAccountEmail || resolvedAdminEmail || '';

    const userApiKeys: Record<string, string[]> = {
      ...(state.userApiKeys || {}),
      ...(state.customSettings?.userApiKeys || {}),
    };

    for (const m of (finalMembers || [])) {
      const email = (m.email || '').trim().toLowerCase();
      if (m.apiKeys && Array.isArray(m.apiKeys) && m.apiKeys.length > 0) {
        userApiKeys[email] = m.apiKeys;
      } else if (m.apiKey && typeof m.apiKey === 'string' && m.apiKey.trim()) {
        userApiKeys[email] = [m.apiKey.trim()];
      }
    }

    const coreMetadataPayload = JSON.stringify({
      schemaVersion: 2,
      status: state.status || 'active',
      lastAction: state.lastAction || 'link',
      activeFileId: state.activeFileId || fileId,
      activeFileName: resolvedFileName || 'Kho Sách Gia Đình',
      activeFileUrl: state.activeFileUrl || `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
      adminEmail: resolvedAdminEmail,
      linkedAccountEmail: resolvedLinkedEmail,
      linkedTimestamp: linkedIso,
      linkedLocalTimeVi: linkedVi,
      updatedAt: nowIso,
      updatedAtVi: nowVi,
    });

    const customSettingsPayload = JSON.stringify({
      ignoredDuplicatePairs: state.ignoredDuplicatePairs || [],
      customSettings: state.customSettings || {},
    });

    const values: (string | number)[][] = [
      ['__METADATA_JSON__', coreMetadataPayload],
      ['Vault Name', resolvedFileName || 'Kho Sách Gia Đình'],
      ['Admin Email', resolvedAdminEmail],
      ['Linked Account', resolvedLinkedEmail],
      ['Status', state.status || 'active'],
      ['Last Action', state.lastAction || 'link'],
      ['Linked Timestamp', linkedVi],
      ['Updated At', nowVi],
      ['Members JSON', JSON.stringify(members)],
      ['Custom Settings', customSettingsPayload],
      ['User API Keys JSON', JSON.stringify(userApiKeys)],
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

    // Nếu tab __CONFIG__ chưa tồn tại (HTTP 400), tự động tạo mới tab rồi thử ghi lại
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
    log.info(`[Debug] Đang đọc config từ: ${fileId}, Range: ${configRange}`);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(configRange)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    log.info(`[Debug] Kết quả đọc config (OK: ${res.ok}, Status: ${res.status})`);


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

        // Đọc custom settings / ignoredDuplicatePairs / userApiKeys
        let ignoredDuplicatePairs: string[] = [];
        let userApiKeysMap: Record<string, string[]> = {};
        const rawCustom = kvMap.get('custom settings');
        if (typeof rawCustom === 'string') {
          try {
            const parsed = JSON.parse(rawCustom);
            if (Array.isArray(parsed.ignoredDuplicatePairs)) {
              ignoredDuplicatePairs = parsed.ignoredDuplicatePairs;
            }
            if (parsed.userApiKeys && typeof parsed.userApiKeys === 'object') {
              userApiKeysMap = { ...userApiKeysMap, ...parsed.userApiKeys };
            } else if (parsed.customSettings?.userApiKeys && typeof parsed.customSettings.userApiKeys === 'object') {
              userApiKeysMap = { ...userApiKeysMap, ...parsed.customSettings.userApiKeys };
            }
          } catch {}
        }
        if (ignoredDuplicatePairs.length === 0 && Array.isArray(metadataParsed.ignoredDuplicatePairs)) {
          ignoredDuplicatePairs = metadataParsed.ignoredDuplicatePairs;
        }

        // Đọc từ hàng 'User API Keys JSON'
        const rawUserApiKeys = kvMap.get('user api keys json') || kvMap.get('user api keys');
        if (typeof rawUserApiKeys === 'string') {
          try {
            const parsed = JSON.parse(rawUserApiKeys);
            if (parsed && typeof parsed === 'object') {
              userApiKeysMap = { ...userApiKeysMap, ...parsed };
            }
          } catch {}
        }

        // Đọc từ metadataParsed nếu có
        if (metadataParsed.userApiKeys && typeof metadataParsed.userApiKeys === 'object') {
          userApiKeysMap = { ...userApiKeysMap, ...metadataParsed.userApiKeys };
        }

        // Đồng bộ ngược lại vào từng member nếu member có apiKeys
        for (const m of membersList) {
          const em = m.email.trim().toLowerCase();
          if (m.apiKeys && Array.isArray(m.apiKeys) && m.apiKeys.length > 0) {
            userApiKeysMap[em] = m.apiKeys;
          } else if (m.apiKey && typeof m.apiKey === 'string' && m.apiKey.trim()) {
            if (!userApiKeysMap[em]) userApiKeysMap[em] = [m.apiKey.trim()];
          } else if (userApiKeysMap[em] && userApiKeysMap[em].length > 0) {
            m.apiKeys = userApiKeysMap[em];
            m.apiKey = userApiKeysMap[em][0] || '';
          }
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
          userApiKeys: userApiKeysMap,
        };

        return { metadata: meta, members: membersList };
      }
    }

    // 2. Fallback: Nếu chưa có tab __CONFIG__, thử đọc từ tab Config cũ
    const legacyUrl = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/Config!E1:F10`;
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
          `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/Config!A:D`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const membersList: FamilyMember[] = [];
        const fallbackApiKeys: Record<string, string[]> = {};
        if (membersResp.ok) {
          const mData = await membersResp.json();
          const mRows: any[][] = mData.values || [];
          for (let i = 1; i < mRows.length; i++) {
            const r = mRows[i];
            if (!r || !r[0] || !String(r[0]).includes('@')) continue;
            const em = String(r[0]).trim().toLowerCase();
            const role = (r[1] === 'Owner' || r[1] === 'Editor') ? r[1] : 'Viewer';
            const rawKey = r[3] ? String(r[3]).trim() : '';
            const keys = rawKey ? rawKey.split(';').map((k) => k.trim()).filter(Boolean) : [];
            if (keys.length > 0) {
              fallbackApiKeys[em] = keys;
            }
            membersList.push({
              email: em,
              role,
              addedAt: r[2] ? String(r[2]) : new Date().toISOString(),
              apiKey: keys[0] || undefined,
              apiKeys: keys.length > 0 ? keys : undefined,
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
          userApiKeys: fallbackApiKeys,
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
    let activeFileName = (fileName || '').trim();
    if (!activeFileName || activeFileName === 'Kho Sách Gia Đình') {
      try {
        const liveDriveStatus = await checkSpreadsheetStatusOnDrive(accessToken, spreadsheetId);
        if (liveDriveStatus.name && liveDriveStatus.name.trim()) {
          activeFileName = liveDriveStatus.name.trim();
        }
      } catch {}
    }
    activeFileName = activeFileName || 'Kho Sách Gia Đình';
    const activeFileUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?usp=drivesdk`;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const timeVi = formatVietnameseFullDate(nowMs);

    // 1. Tab Khosach: Kiểm tra xem hàng tiêu đề dòng 1 đã có chưa
    try {
      const headerCheck = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${KHOSACH_SHEET_TITLE}!A1:G1`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const headerData = headerCheck.ok ? await headerCheck.json() : null;
      if (!headerData?.values || headerData.values.length === 0 || !headerData.values[0] || headerData.values[0].length === 0) {
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
      }
    } catch {}

    // 2. Tab __CONFIG__: TUYỆT ĐỐI BẢO VỆ DỮ LIỆU ĐANG CÓ
    // Trước khi ghi, kiểm tra xem Tab __CONFIG__ đã có cấu hình hoặc danh sách thành viên hay chưa
    const existingConfig = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
    if (existingConfig && existingConfig.metadata && (existingConfig.metadata.adminEmail || existingConfig.members.length > 0)) {
      log.info('[DriveSync] Tab __CONFIG__ đã có cấu hình và thành viên hợp lệ. Giữ nguyên toàn vẹn dữ liệu.');
      return;
    }

    // Chỉ khởi tạo khi Tab __CONFIG__ thực sự rỗng hoặc chưa từng có cấu hình
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

    // Tab __CONFIG__ đã được khởi tạo hoàn tất chuẩn xác theo mẫu A1:B10.
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
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
    },
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

  // 1. Đảm bảo các tab (Khosach và __CONFIG__) tồn tại và được định dạng chuẩn
  await ensureSpreadsheetTabs(accessToken, spreadsheetId, '').catch((err) => {
    console.warn('[DriveSync] ensureSpreadsheetTabs trước khi lưu gặp cảnh báo:', err);
  });

  // 2. Xóa vùng dữ liệu cũ trước để tránh rác
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(KHOSACH_SHEET_TITLE + '!A:G')}:clear`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  }).catch(() => {});

  // 3. Ghi toàn bộ dữ liệu mới bằng values:batchUpdate chuẩn xác với đầy đủ ValueRange
  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
  const writeResp = await fetch(batchUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: `${KHOSACH_SHEET_TITLE}!A1:G${rows.length}`,
          majorDimension: 'ROWS',
          values: rows,
        },
      ],
    }),
  });

  if (!writeResp.ok) {
    const errJson = await writeResp.json().catch(() => ({}));
    if (writeResp.status === 403) {
      throw new Error('READ_ONLY_SCOPE_OR_PERMISSION');
    }
    console.error(`[DriveSync] Lỗi lưu sách lên Google Sheet (${writeResp.status}):`, errJson);
    throw new Error(errJson?.error?.message || `Không thể lưu sách lên Google Sheet (${writeResp.status})`);
  }
  console.info(`[DriveSync] Đã lưu thành công ${books.length} cuốn sách lên tab "${KHOSACH_SHEET_TITLE}"`);
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
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Config!A:C`;
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
  let cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) {
    throw new Error('Vui lòng nhập email hoặc username.');
  }
  if (!cleanEmail.includes('@')) {
    cleanEmail = `${cleanEmail}@gmail.com`;
  }

  // 1. Cấp quyền trên Google Drive API
  const driveRole = role === 'Editor' ? 'writer' : 'reader';
  const permissionUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?sendNotificationEmail=false`;
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
}

/**
 * 7b. Lưu hoặc cập nhật Gemini API Key của thành viên (Admin hoặc Editor) vào Google Sheet Config
 * Đồng bộ sang mọi thiết bị hoặc phiên đăng nhập khác của user đó mà không cần nhập lại.
 */
export async function saveUserApiKeyToSheetConfig(
  accessToken: string,
  spreadsheetId: string,
  userEmail: string,
  apiKeys: string[],
  userRole?: UserRole
): Promise<boolean> {
  const cleanEmail = (userEmail || '').trim().toLowerCase();
  if (!accessToken || !spreadsheetId || !cleanEmail) return false;

  // Bảo vệ phân quyền: Chỉ thành viên có vai trò Admin hoặc Editor mới được lưu API Key vào Sheet Config
  if (userRole === 'VIEWER') {
    console.warn(`[DriveSync] Từ chối lưu API Key vào Sheet Config: Người dùng ${cleanEmail} có vai trò VIEWER`);
    return false;
  }

  try {
    const state = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
    if (!state) {
      console.warn('[DriveSync] Không đọc được trạng thái Master Sync để lưu API Key');
      return false;
    }

    const cleanKeys = (apiKeys || []).map((k) => String(k || '').trim()).filter(Boolean);
    const existingMembers = state.members ? state.members.map((m) => ({ ...m })) : [];
    let matchedMember = existingMembers.find((m) => m.email.trim().toLowerCase() === cleanEmail);

    // Kiểm tra xem member trong sheet có phải là Viewer hay không
    if (matchedMember && matchedMember.role === 'Viewer') {
      console.warn(`[DriveSync] Không thể lưu API Key: Member ${cleanEmail} được cấu hình là Viewer trong Sheet`);
      return false;
    }

    const nowIso = new Date().toISOString();
    if (matchedMember) {
      matchedMember.apiKeys = cleanKeys;
      matchedMember.apiKey = cleanKeys[0] || '';
      matchedMember.apiKeyUpdatedAt = nowIso;
    } else {
      // Nếu user là Admin (Owner) hoặc Editor nhưng chưa có trong danh sách members
      const role = (userRole === 'ADMIN' || state.metadata.adminEmail?.trim().toLowerCase() === cleanEmail)
        ? 'Owner'
        : 'Editor';
      matchedMember = {
        email: cleanEmail,
        role,
        addedAt: nowIso,
        apiKeys: cleanKeys,
        apiKey: cleanKeys[0] || '',
        apiKeyUpdatedAt: nowIso,
      };
      existingMembers.push(matchedMember);
    }

    const userApiKeys: Record<string, string[]> = {
      ...(state.metadata.userApiKeys || {}),
      ...(state.metadata.customSettings?.userApiKeys || {}),
      [cleanEmail]: cleanKeys,
    };

    const saveSuccess = await saveMasterSyncStateToGoogleSheet(accessToken, spreadsheetId, {
      ...state.metadata,
      members: existingMembers,
      userApiKeys,
      customSettings: {
        ...(state.metadata.customSettings || {}),
        userApiKeys,
      },
      updatedAt: nowIso,
    });

    // Cập nhật bổ trợ vào Tab Config cũ (nếu tệp đang dùng tab Config)
    try {
      const configResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Config!A:D`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (configResp.ok) {
        const cData = await configResp.json();
        const rows: any[][] = cData.values || [];
        for (let i = 1; i < rows.length; i++) {
          if (rows[i] && String(rows[i][0] || '').trim().toLowerCase() === cleanEmail) {
            const rowNum = i + 1;
            await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Config!D${rowNum}?valueInputOption=USER_ENTERED`,
              {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ values: [[cleanKeys.join(';')]] }),
              }
            );
            break;
          }
        }
      }
    } catch {}

    return saveSuccess;
  } catch (err) {
    console.warn('[DriveSync] saveUserApiKeyToSheetConfig thất bại:', err);
    return false;
  }
}

/**
 * 7c. Lấy danh sách Gemini API Key đã lưu trong Google Sheet Config của một thành viên
 */
export async function fetchUserApiKeysFromSheetConfig(
  accessToken: string,
  spreadsheetId: string,
  userEmail: string
): Promise<string[]> {
  try {
    const cleanEmail = (userEmail || '').trim().toLowerCase();
    if (!accessToken || !spreadsheetId || !cleanEmail) return [];

    const state = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
    if (state) {
      // 1. Kiểm tra trong metadata.userApiKeys
      if (state.metadata.userApiKeys && state.metadata.userApiKeys[cleanEmail]) {
        const keys = state.metadata.userApiKeys[cleanEmail];
        if (Array.isArray(keys) && keys.length > 0) return keys;
      }

      // 2. Kiểm tra trong customSettings.userApiKeys
      const customApiKeys = state.metadata.customSettings?.userApiKeys;
      if (customApiKeys && customApiKeys[cleanEmail] && Array.isArray(customApiKeys[cleanEmail])) {
        return customApiKeys[cleanEmail];
      }

      // 3. Kiểm tra trong danh sách members
      const matched = state.members.find((m) => m.email.trim().toLowerCase() === cleanEmail);
      if (matched?.apiKeys && matched.apiKeys.length > 0) {
        return matched.apiKeys;
      }
      if (matched?.apiKey) {
        return [matched.apiKey];
      }
    }

    // 4. Fallback: Kiểm tra trong tab Config cũ
    const configResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Config!A:D`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (configResp.ok) {
      const cData = await configResp.json();
      const rows: any[][] = cData.values || [];
      for (let i = 1; i < rows.length; i++) {
        if (rows[i] && String(rows[i][0] || '').trim().toLowerCase() === cleanEmail) {
          const rawKey = String(rows[i][3] || '').trim();
          if (rawKey) {
            return rawKey.split(';').map((k) => k.trim()).filter(Boolean);
          }
        }
      }
    }

    return [];
  } catch (err) {
    console.warn('[DriveSync] fetchUserApiKeysFromSheetConfig error:', err);
    return [];
  }
}

/**
 * 7d. Tự động đồng bộ 2 chiều API Key giữa LocalStorage và Google Sheet Config
 * - Khi user Admin hoặc Editor đăng nhập ở máy mới: Tự nạp key từ Sheet về máy
 * - Khi user nhập key mới ở máy hiện tại: Tự lưu lên Sheet Config
 * - Khi cả 2 đều có: Hợp nhất (deduplicate) để đảm bảo đồng nhất
 */
export async function syncUserApiKeyWithSheetConfig(
  accessToken: string,
  spreadsheetId: string,
  userEmail: string,
  userRole: UserRole,
  localKeys: string[]
): Promise<{
  syncedKeys: string[];
  hasUpdatedLocal: boolean;
  hasUpdatedRemote: boolean;
}> {
  const cleanEmail = (userEmail || '').trim().toLowerCase();
  if (!accessToken || !spreadsheetId || !cleanEmail) {
    return { syncedKeys: localKeys, hasUpdatedLocal: false, hasUpdatedRemote: false };
  }

  // Chỉ Admin và Editor mới được lưu và đồng bộ API key trong sheet config
  if (userRole === 'VIEWER') {
    return { syncedKeys: localKeys, hasUpdatedLocal: false, hasUpdatedRemote: false };
  }

  const cleanLocal = (localKeys || []).map((k) => String(k || '').trim()).filter(Boolean);
  const remoteKeys = await fetchUserApiKeysFromSheetConfig(accessToken, spreadsheetId, cleanEmail);

  // Trường hợp 1: Remote có keys, Local chưa có (đăng nhập trên máy mới / trình duyệt mới)
  if (remoteKeys.length > 0 && cleanLocal.length === 0) {
    saveStoredGeminiApiKeys(remoteKeys);
    return { syncedKeys: remoteKeys, hasUpdatedLocal: true, hasUpdatedRemote: false };
  }

  // Trường hợp 2: Local có keys, Remote chưa có (vừa nhập key trên máy hiện tại)
  if (cleanLocal.length > 0 && remoteKeys.length === 0) {
    await saveUserApiKeyToSheetConfig(accessToken, spreadsheetId, cleanEmail, cleanLocal, userRole);
    return { syncedKeys: cleanLocal, hasUpdatedLocal: false, hasUpdatedRemote: true };
  }

  // Trường hợp 3: Cả 2 đều có key -> Gộp hợp nhất các key mới nhất (không trùng lặp)
  const mergedSet = new Set<string>();
  cleanLocal.forEach((k) => mergedSet.add(k));
  remoteKeys.forEach((k) => mergedSet.add(k));
  const mergedList = Array.from(mergedSet);

  let hasUpdatedLocal = false;
  let hasUpdatedRemote = false;

  if (mergedList.length > cleanLocal.length) {
    saveStoredGeminiApiKeys(mergedList);
    hasUpdatedLocal = true;
  }
  if (mergedList.length > remoteKeys.length) {
    await saveUserApiKeyToSheetConfig(accessToken, spreadsheetId, cleanEmail, mergedList, userRole);
    hasUpdatedRemote = true;
  }

  return { syncedKeys: mergedList, hasUpdatedLocal, hasUpdatedRemote };
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
  log.info(`[DriveSync] Bắt đầu đồng bộ 2 chiều (Vai trò: ${userRole})...`);

  // 1. Kéo dữ liệu gốc từ Master Database trên Google Drive
  const remoteBooks = await fetchBooksFromGoogleSheet(accessToken, spreadsheetId);
  log.info(`[DriveSync] Đã nạp ${remoteBooks.length} sách từ Google Sheet, local hiện có ${localBooks.length} sách.`);

  // Tự động đồng bộ danh sách cặp không trùng lặp (Ignored Duplicates) từ Tab Config ẩn
  try {
    await syncIgnoredDuplicatePairsWithDrive(accessToken, spreadsheetId);
  } catch {}

  // 1b. KIỂM TRA CỜ PHỤC HỒI MASTER (Master Restore Protection)
  // Nếu local bị người dùng xóa trắng (clear all) hoặc cài đặt mới, kéo toàn bộ Master về máy
  if (isMasterRestoreRequired()) {
    log.info('[DriveSync] Phát hiện cờ Master Restore. Khôi phục toàn bộ sách từ Google Drive về máy...');
    setMasterRestoreRequired(false);
    clearPendingBookMutations();
    return {
      mergedBooks: remoteBooks,
      cloudCount: remoteBooks.length,
      localCount: 0,
      hasChanges: true,
    };
  }

  // Nếu là VIEWER, dữ liệu trên Drive luôn là tuyệt đối, không ghi đè, không thay đổi
  if (userRole === 'VIEWER') {
    log.info(`[DriveSync] Quyền Viewer: Cập nhật thư viện theo chuẩn Master Drive (${remoteBooks.length} cuốn).`);
    return {
      mergedBooks: remoteBooks,
      cloudCount: remoteBooks.length,
      localCount: localBooks.length,
      hasChanges: true, // Cho phép ghi đè hoàn toàn cục bộ
    };
  }

  // 2. Với ADMIN/EDITOR, hợp nhất dựa trên Master Database kết hợp Hàng Đợi Mutation Ngoại Tuyến
  const mergedMap = new Map<string, BookRecord>();

  // Đưa toàn bộ sách từ Master Database trên Drive vào trước
  for (const rBook of remoteBooks) {
    if (rBook.id) {
      mergedMap.set(rBook.id, rBook);
    }
  }

  let localChangesMade = false;
  const pendingMutations = getPendingBookMutations();
  const appliedMutationIds: string[] = [];

  // 2a. ÁP DỤNG HÀNG ĐỢI BIẾN ĐỘNG (MUTATION REPLAY) NẾU CÓ
  if (pendingMutations.length > 0) {
    log.info(`[DriveSync] Đang phát lại ${pendingMutations.length} thao tác ngoại tuyến (Mutations)...`);
    for (const mutation of pendingMutations) {
      if (mutation.type === 'DELETE') {
        if (mergedMap.has(mutation.bookId)) {
          mergedMap.delete(mutation.bookId);
          localChangesMade = true;
        }
      } else if (mutation.type === 'CREATE' || mutation.type === 'UPDATE') {
        if (mutation.book) {
          mergedMap.set(mutation.bookId, mutation.book);
          localChangesMade = true;
        }
      }
      appliedMutationIds.push(mutation.id);
    }
  }

  // 2b. Đối chiếu bổ sung các sách local hiện tại với remote theo timestamp
  const remoteIds = new Set(remoteBooks.map((b) => b.id).filter(Boolean));
  for (const lBook of localBooks) {
    if (!lBook.id) continue;
    const existing = mergedMap.get(lBook.id);

    if (!remoteIds.has(lBook.id)) {
      // Sách này có ở local nhưng chưa có trên Drive
      const hasDeleteMutation = pendingMutations.some((m) => m.bookId === lBook.id && m.type === 'DELETE');

      if (hasDeleteMutation) {
        // Đã có lệnh xóa chủ động, bỏ qua không đưa vào danh sách hợp nhất
        localChangesMade = true;
      } else {
        // Giữ lại sách và đưa lên Drive (sách mới thêm local, nhập file, v.v.)
        mergedMap.set(lBook.id, lBook);
        localChangesMade = true;
      }
      continue;
    }

    if (!existing) {
      // Sách mới tạo ở local chưa có trên Drive
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

  const hasActualContentDifference = (listA: BookRecord[], listB: BookRecord[]): boolean => {
    if (listA.length !== listB.length) return true;
    const mapB = new Map(listB.map((b) => [b.id, b]));
    for (const a of listA) {
      const b = mapB.get(a.id);
      if (!b) return true;
      if (
        (a.title || '').trim() !== (b.title || '').trim() ||
        (a.author || '').trim() !== (b.author || '').trim() ||
        (a.category || '').trim() !== (b.category || '').trim() ||
        (a.publisher || '').trim() !== (b.publisher || '').trim()
      ) {
        return true;
      }
    }
    return false;
  };

  const isContentChanged = localChangesMade || finalMergedList.length !== remoteBooks.length || hasActualContentDifference(finalMergedList, remoteBooks);

  // 3. Nếu phát sinh thay đổi thực sự, ghi đè cập nhật lại lên Master Database trên Google Drive
  if (isContentChanged) {
    log.info(`[DriveSync] Đang ghi đè cập nhật ${finalMergedList.length} sách lên Google Sheet...`);
    await saveBooksToGoogleSheet(accessToken, spreadsheetId, finalMergedList);
    // Sau khi lưu lên Google Sheet thành công, dọn dẹp các mutation đã áp dụng
    if (appliedMutationIds.length > 0) {
      removePendingBookMutationsByIds(appliedMutationIds);
      log.info(`[DriveSync] Đã xóa ${appliedMutationIds.length} mutation khỏi hàng đợi thành công.`);
    }
  } else if (appliedMutationIds.length > 0) {
    removePendingBookMutationsByIds(appliedMutationIds);
  }

  log.info(`[DriveSync] Đồng bộ thành công: Tổng hợp ${finalMergedList.length} cuốn (Drive trước đó: ${remoteBooks.length}, Máy: ${localBooks.length}).`);

  return {
    mergedBooks: finalMergedList,
    cloudCount: remoteBooks.length,
    localCount: localBooks.length,
    hasChanges: true,
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
  const cleanEmail = (userEmail || '').trim().toLowerCase();

  const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId).catch(() => null);

  if (syncState && syncState.metadata) {
    const { metadata, members } = syncState;

    // 1. Kiểm tra quyền Admin/Owner tối cao
    const isAdmin =
      (metadata.adminEmail && metadata.adminEmail.trim().toLowerCase() === cleanEmail) ||
      (metadata.linkedAccountEmail && metadata.linkedAccountEmail.trim().toLowerCase() === cleanEmail) ||
      members.some((m) => m.email?.trim().toLowerCase() === cleanEmail && m.role === 'Owner');

    if (isAdmin) {
      return 'ADMIN';
    }

    // Kiểm tra quyền ghi thực tế trước khi kết luận bị chặn bởi WORKSPACE_UNLINKED
    let canWrite = false;
    try {
      const testWrite = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/__CONFIG__!D1?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [['check']] }),
      });
      canWrite = testWrite.ok;
    } catch {}

    // Nếu người dùng có quyền ghi trên Sheet (Owner/Editor thực tế trên Google Drive), cho phép họ quản trị và tái kích hoạt file
    if (canWrite) {
      return 'ADMIN';
    }

    // 2. Nếu không có quyền ghi và workspace đã bị Admin hủy liên kết
    if (metadata.status === 'unlinked' || metadata.lastAction === 'unlink') {
      throw new Error('WORKSPACE_UNLINKED');
    }

    // 3. Kiểm tra danh sách thành viên trong cấu hình
    const matched = members.find((member) => member.email.trim().toLowerCase() === cleanEmail);
    if (matched?.role === 'Owner') return 'ADMIN';
    if (matched?.role === 'Editor') return 'EDITOR';
    if (matched?.role === 'Viewer') return 'VIEWER';
  }

  // Fallback: Kiểm tra quyền ghi thực tế trên Sheet nếu chưa có config
  try {
    const testWrite = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/__CONFIG__!D1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['check']] }),
    });
    if (testWrite.ok) return 'ADMIN';
  } catch {}

  return 'VIEWER';
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
  let currentFileName = (fileName || existing?.activeFileName || '').trim();
  if (!currentFileName || currentFileName === 'Kho Sách Gia Đình') {
    try {
      const liveDriveStatus = await checkSpreadsheetStatusOnDrive(accessToken, spreadsheetId);
      if (liveDriveStatus.name && liveDriveStatus.name.trim()) {
        currentFileName = liveDriveStatus.name.trim();
      }
    } catch {}
  }
  currentFileName = currentFileName || 'Kho Sách Gia Đình';
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

/**
 * Đồng bộ tên thực tế (Live Real Title) của tệp từ Google Drive vào Tab __CONFIG__
 * - Cập nhật ô B2: Vault Name = realFileName
 * - Cập nhật ô B1: __METADATA_JSON__.activeFileName = realFileName
 * - Bảo toàn 100% dữ liệu danh sách thành viên, API keys, và thiết lập của Workspace
 * - Tự động đồng bộ lại Firestore Relay cho các thành viên nếu tài khoản là Admin
 */
export async function syncSheetConfigVaultName(
  accessToken: string,
  spreadsheetId: string,
  realFileName: string,
  adminEmail?: string
): Promise<boolean> {
  const cleanTitle = (realFileName || '').trim();
  if (!accessToken || !spreadsheetId || !cleanTitle) return false;

  try {
    const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
    if (!syncState) return false;

    const existingMeta: Partial<SheetConfigMetadata> = syncState.metadata || {};
    // Nếu tên trong cấu hình __CONFIG__ đã khớp tên thực tế trên Drive, không cần ghi đè
    if (existingMeta.activeFileName === cleanTitle) {
      return true;
    }

    log.info(`[DriveSync] Tự động đồng bộ tên file thật ("${cleanTitle}") vào Tab __CONFIG__ của Google Sheet (${spreadsheetId})...`);

    const nowIso = new Date().toISOString();
    const timeVi = formatVietnameseFullDate(nowIso);
    const members = syncState.members || [];

    const saveSuccess = await saveMasterSyncStateToGoogleSheet(accessToken, spreadsheetId, {
      ...existingMeta,
      activeFileName: cleanTitle,
      activeFileUrl: existingMeta.activeFileUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      members,
      updatedAt: nowIso,
      updatedAtVi: timeVi,
    });

    if (saveSuccess) {
      log.info(`[DriveSync] Đã cập nhật Vault Name và Metadata thành "${cleanTitle}" trong Sheet.`);

      // Tự động phát hành lại Firestore Relay cho toàn bộ thành viên với tên mới
      const resolvedAdmin = (adminEmail || existingMeta.adminEmail || '').trim().toLowerCase();
      if (resolvedAdmin && members.length > 0) {
        publishAssignedFilesForMembers(members, spreadsheetId, cleanTitle, resolvedAdmin).catch((err) => {
          log.warn('[DriveSync] Cập nhật relay Firestore với tên file mới thất bại:', err);
        });
      }
    }

    return saveSuccess;
  } catch (err) {
    log.warn('[DriveSync] syncSheetConfigVaultName thất bại:', err);
    return false;
  }
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
  // Dọn dẹp bản ghi chuyển tiếp trên Firestore
  removeAssignedFilesForWorkspace(spreadsheetId, members).catch(() => {});

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
          let isMember = false;
          let isAdmin = false;
          let resolvedName = sheet.name || 'Kho Sách Gia Đình';
          let adminEmail = '';

          if (syncState && syncState.metadata) {
            const meta = syncState.metadata;
            if (meta.status === 'unlinked' || meta.lastAction === 'unlink') return null;

            adminEmail = (meta.adminEmail || '').trim().toLowerCase();
            isAdmin = adminEmail === cleanEmail;
            const members = syncState.members || [];
            const matchedMember = members.find((member) => member.email.trim().toLowerCase() === cleanEmail);
            isMember = !!matchedMember;
            resolvedName =
              (sheet.name && sheet.name !== 'Kho Sách Gia Đình' ? sheet.name : null) ||
              (meta.activeFileName && meta.activeFileName !== 'Kho Sách Gia Đình' ? meta.activeFileName : null) ||
              sheet.name ||
              meta.activeFileName ||
              'Kho Sách Gia Đình';
          } else {
            // Fallback nếu chưa đọc được metadata
            const fallbackMembers = await fetchFamilyMembers(accessToken, sheet.id);
            const matchedFallback = fallbackMembers.find((member) => member.email.trim().toLowerCase() === cleanEmail);
            isMember = !!matchedFallback;
          }

          if (!isAdmin && !isMember) return null;

          const resolvedSheet: SpreadsheetInfo = {
            id: sheet.id,
            name: resolvedName,
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

export interface AutoDiscoverResult {
  matchedSheet: SpreadsheetInfo | null;
  role?: UserRole;
  taggedSheets: SpreadsheetInfo[];
  allCandidates: SpreadsheetInfo[];
  source: 'firestore_relay' | 'drive_app_properties' | 'cached' | 'none';
}

/**
 * Tự động dò tìm & kết nối tệp dữ liệu trung tâm đa thiết bị (Auto-Discovery Flow):
 * 1. Đọc ngầm fileId từ Firestore Relay (ưu tiên số 1 để đồng bộ tức thì trên thiết bị mới hoặc thiết bị đầu).
 * 2. Đọc __CONFIG__ của file nhận từ Firestore để xác thực trạng thái active và nhóm thành viên.
 * 3. Nếu chưa có trên Firestore, quét Google Drive tìm các file có gắn nhãn appProperties com.khosach.app.
 * 4. Đọc tab __CONFIG__ của các file gắn nhãn:
 *    - Tìm file có trạng thái liên kết (status = active) + nhóm thành viên phù hợp (Admin hoặc Member).
 *    - Nếu tìm thấy, lập tức thiết lập kết nối master cục bộ.
 *    - Nếu có nhiều file gắn nhãn nhưng chưa khớp thành viên -> trả về danh sách các file có gắn nhãn để người dùng chọn.
 */
export async function autoDiscoverCentralVault(
  accessToken: string,
  userEmail: string
): Promise<AutoDiscoverResult> {
  const cleanEmail = (userEmail || '').trim().toLowerCase();
  const taggedMap = new Map<string, SpreadsheetInfo>();

  // BƯỚC 1: Ưu tiên nhận fileId ngầm gửi qua Firestore Relay
  if (cleanEmail) {
    try {
      const relay = await consumeAssignedFileForMember(cleanEmail);
      if (relay && relay.assignedFileId && relay.status !== 'unlinked') {
        log.info(`[AutoDiscover] Đã lấy fileId ngầm từ Firestore Relay: ${relay.assignedFileId} cho ${cleanEmail}`);
        const driveStatus = await checkSpreadsheetStatusOnDrive(accessToken, relay.assignedFileId);
        
        // Chỉ từ chối nếu file thực sự bị đưa vào Thùng rác (trashed). Nếu không trashed, tiến hành liên kết!
        if (!driveStatus.trashed) {
          log.info(`[AutoDiscover] Relay có fileId (${relay.assignedFileId}), đang đọc cấu hình sheet để đồng bộ...`);
          
          let syncState = null;
          try {
            syncState = await readMasterSyncStateFromGoogleSheet(accessToken, relay.assignedFileId);
          } catch (e) {
            log.warn('[AutoDiscover] Không đọc được syncState qua Sheets API:', e);
          }
          
          // Ưu tiên:
          // 1. driveStatus.name (Tên thực tế trực tiếp từ Google Drive API hoặc Sheets API properties.title)
          // 2. relay.assignedFileName (Tên file chính xác mà Admin gửi qua Firestore Relay)
          // 3. meta?.activeFileName (Tên lưu trong sheet config nếu khác tên mặc định)
          // 4. Fallback 'Kho Sách Gia Đình'
          const meta = syncState?.metadata;
          const resolvedName =
            (driveStatus.name && driveStatus.name !== 'Kho Sách Gia Đình' ? driveStatus.name : null) ||
            (relay.assignedFileName && relay.assignedFileName !== 'Kho Sách Gia Đình' ? relay.assignedFileName : null) ||
            driveStatus.name ||
            relay.assignedFileName ||
            (meta?.activeFileName && meta.activeFileName !== 'Kho Sách Gia Đình' ? meta.activeFileName : null) ||
            meta?.activeFileName ||
            'Kho Sách Gia Đình';

          const matched: SpreadsheetInfo = {
            id: relay.assignedFileId,
            name: resolvedName,
            webViewLink: `https://docs.google.com/spreadsheets/d/${relay.assignedFileId}/edit`,
          };

          // Lưu danh bạ file và cache LocalStorage để sẵn sàng ngay
          tagSpreadsheetAsAppCreated(accessToken, matched.id).catch(() => {});
          saveKnownSpreadsheet(matched);
          try {
            localStorage.setItem('library_spreadsheet_info_v2', JSON.stringify(matched));
            localStorage.removeItem('unlinked_spreadsheet_explicitly');
            localStorage.removeItem('explicitly_unlinked');
          } catch {}
          
          // Xóa bản ghi relay trên Firestore CHỈ SAU KHI đã liên kết thành công trên máy
          await removeAssignedFileForMember(cleanEmail).catch((err) => {
            log.warn('[AutoDiscover] Không thể dọn dẹp bản ghi relay trên Firestore:', err);
          });

          log.info(`[AutoDiscover] Đã tự động liên kết thành công qua Firestore Relay: ${matched.name} (${matched.id})`);
          
          return {
            matchedSheet: matched,
            role: relay.role === 'Owner' ? 'ADMIN' : relay.role === 'Editor' ? 'EDITOR' : 'VIEWER',
            taggedSheets: [matched],
            allCandidates: [matched],
            source: 'firestore_relay',
          };
        } else {
          log.warn(`[AutoDiscover] File từ Firestore Relay (${relay.assignedFileId}) đã bị xóa vào thùng rác trên Drive.`);
        }
      }
    } catch (relayErr) {
      log.warn('[AutoDiscover] Lỗi kiểm tra Firestore Relay ngầm:', relayErr);
    }
  }

  // BƯỚC 2: Quét Google Drive tìm các file có gắn nhãn appProperties com.khosach.app
  try {
    const queries = [
      `appProperties has { key='khosach_app_id' and value='com.khosach.app' } and trashed = false`,
      `appProperties has { key='app_id' and value='com.khosach.app' } and trashed = false`,
      `appProperties has { key='app' and value='com.khosach.app' } and trashed = false`,
      `appProperties has { key='${APP_PROPERTY_KEY}' and value='${APP_PROPERTY_VALUE}' } and trashed = false`,
    ];

    await Promise.all(
      queries.map(async (q) => {
        try {
          const url = new URL('https://www.googleapis.com/drive/v3/files');
          url.searchParams.set('pageSize', '30');
          url.searchParams.set('fields', 'files(id,name,webViewLink,trashed,modifiedTime,appProperties,mimeType)');
          url.searchParams.set('orderBy', 'modifiedTime desc');
          url.searchParams.set('supportsAllDrives', 'true');
          url.searchParams.set('includeItemsFromAllDrives', 'true');
          url.searchParams.set('q', q);

          const resp = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!resp.ok) return;

          const data = await resp.json();
          for (const f of data.files || []) {
            if (!f.id || f.trashed) continue;
            taggedMap.set(f.id, {
              id: f.id,
              name: f.name || 'Kho Sách Gia Đình',
              webViewLink: f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
            });
          }
        } catch (scanErr) {
          log.warn('[AutoDiscover] Lỗi truy vấn Drive query:', scanErr);
        }
      })
    );
  } catch (err) {
    log.warn('[AutoDiscover] Lỗi quét nhãn appProperties:', err);
  }

  const taggedSheets = Array.from(taggedMap.values());
  log.info(`[AutoDiscover] Đã tìm thấy ${taggedSheets.length} file có gắn nhãn com.khosach.app`);

  // BƯỚC 3: Đọc sheet config __CONFIG__ của các file có gắn nhãn
  for (const sheet of taggedSheets) {
    try {
      const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, sheet.id);
      if (syncState && syncState.metadata) {
        const meta = syncState.metadata;
        if (meta.status === 'unlinked' || meta.lastAction === 'unlink') {
          continue;
        }

        const adminEmail = (meta.adminEmail || '').trim().toLowerCase();
        const isAdmin = adminEmail === cleanEmail;
        const members = syncState.members || [];
        const matchedMember = members.find((m) => m.email.trim().toLowerCase() === cleanEmail);
        const isMember = !!matchedMember;

        if (isAdmin || isMember) {
          const role: UserRole = isAdmin ? 'ADMIN' : (matchedMember?.role === 'Editor' ? 'EDITOR' : 'VIEWER');
          const resolvedName =
            (sheet.name && sheet.name !== 'Kho Sách Gia Đình' ? sheet.name : null) ||
            (meta.activeFileName && meta.activeFileName !== 'Kho Sách Gia Đình' ? meta.activeFileName : null) ||
            sheet.name ||
            meta.activeFileName ||
            'Kho Sách Gia Đình';

          const matched: SpreadsheetInfo = {
            id: sheet.id,
            name: resolvedName,
            webViewLink: sheet.webViewLink || `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`,
          };

          tagSpreadsheetAsAppCreated(accessToken, matched.id).catch(() => {});
          saveKnownSpreadsheet(matched);

          log.info(`[AutoDiscover] Đã tự động kết nối master cục bộ tới file: ${matched.name} (${matched.id})`);
          return {
            matchedSheet: matched,
            role,
            taggedSheets,
            allCandidates: taggedSheets,
            source: 'drive_app_properties',
          };
        }
      }
    } catch (confErr) {
      log.warn(`[AutoDiscover] Lỗi kiểm tra config file ${sheet.id}:`, confErr);
    }
  }

  // BƯỚC 4: Fallback mở rộng nếu chưa có file gắn nhãn nào thỏa mãn
  const broadSheets = await autoDiscoverSharedSpreadsheets(accessToken, userEmail);
  if (broadSheets.length > 0) {
    const matched = broadSheets[0];
    const role = await determineCurrentUserRole(accessToken, matched.id, userEmail).catch(() => 'VIEWER' as UserRole);
    tagSpreadsheetAsAppCreated(accessToken, matched.id).catch(() => {});
    return {
      matchedSheet: matched,
      role,
      taggedSheets,
      allCandidates: [...taggedSheets, ...broadSheets],
      source: 'drive_app_properties',
    };
  }

  // BƯỚC 5: Tự phục hồi siêu tốc (Self-Healing Shared File Fallback):
  // Nếu tài khoản thành viên chưa có relay Firestore và chưa có tag appProperties, 
  // tự động quét toàn bộ file Drive khả dụng (bao gồm file được chia sẻ) để nhận diện và kết nối tức thì.
  try {
    const allDriveSheets = await fetchUserSpreadsheetsFromDrive(accessToken);
    if (allDriveSheets.length > 0) {
      const fallbackSheet = allDriveSheets[0];
      log.info(`[AutoDiscover] Kích hoạt tự phục hồi Self-Healing với file Drive: ${fallbackSheet.name} (${fallbackSheet.id})`);
      
      tagSpreadsheetAsAppCreated(accessToken, fallbackSheet.id).catch(() => {});
      saveKnownSpreadsheet(fallbackSheet);

      let role: UserRole = 'VIEWER';
      try {
        role = await determineCurrentUserRole(accessToken, fallbackSheet.id, userEmail);
      } catch {
        try {
          const members = await fetchFamilyMembers(accessToken, fallbackSheet.id);
          if (!members.some((m) => m.email.toLowerCase() === cleanEmail)) {
            members.push({ email: cleanEmail, role: 'Viewer', addedAt: new Date().toISOString() });
            const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, fallbackSheet.id);
            await saveMasterSyncStateToGoogleSheet(accessToken, fallbackSheet.id, {
              ...(syncState?.metadata || { activeFileId: fallbackSheet.id, adminEmail: '' }),
              members,
              updatedAt: new Date().toISOString(),
            });
          }
        } catch {}
      }

      return {
        matchedSheet: fallbackSheet,
        role,
        taggedSheets,
        allCandidates: allDriveSheets,
        source: 'drive_app_properties',
      };
    }
  } catch (healErr) {
    log.warn('[AutoDiscover] Lỗi tự phục hồi Self-Healing:', healErr);
  }

  // BƯỚC 6: Không có file nào thỏa mãn tự động -> Trả về danh sách file có gắn nhãn để UI hiển thị cho người dùng
  return {
    matchedSheet: null,
    taggedSheets,
    allCandidates: taggedSheets,
    source: 'none',
  };
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
