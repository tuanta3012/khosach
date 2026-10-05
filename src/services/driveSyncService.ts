import { BookRecord, UserRole } from '../types';
import { sanitizeDocId, sanitizeSingleCategory } from '../utils/driveSyncService';
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
  auditLog?: Array<{ action: string; timestamp: string; actor: string }>;
  customSettings?: Record<string, any>;
}

const KHOSACH_SHEET_TITLE = 'Khosach';
const CONFIG_SHEET_TITLE = 'Config';
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
 * Lấy danh sách các tệp Google Sheet thuộc ứng dụng Tủ Sách Gia Đình.
 * Lọc DUY NHẤT theo điều kiện: appProperties.app == 'khosach_app'
 */
export async function fetchUserSpreadsheetsFromDrive(
  accessToken: string
): Promise<SpreadsheetInfo[]> {
  const map = new Map<string, SpreadsheetInfo>();

  if (!accessToken) {
    return getKnownSpreadsheets();
  }

  // 1. Quét từ Google Drive API: Lọc DUY NHẤT các file có appProperties.app == 'khosach_app'
  try {
    const query = encodeURIComponent(
      `appProperties has { key='${APP_PROPERTY_KEY}' and value='${APP_PROPERTY_VALUE}' } and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`
    );
    const driveSearchUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,webViewLink,trashed,appProperties)&pageSize=100&orderBy=modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true`;

    const searchResp = await fetch(driveSearchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (searchResp.ok) {
      const data = await searchResp.json();
      const files: any[] = data.files || [];
      for (const f of files) {
        if (f.trashed) continue;
        // Kiểm tra độc lập bổ sung cho chắc chắn
        if (f.appProperties && f.appProperties[APP_PROPERTY_KEY] === APP_PROPERTY_VALUE) {
          map.set(f.id, {
            id: f.id,
            name: f.name || 'Tủ sách gia đình',
            webViewLink: f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
          });
        }
      }
    }
  } catch (err) {
    console.warn('[DriveSync] Quét danh sách Google Sheet từ Drive gặp lỗi:', err);
  }

  const verifiedList = Array.from(map.values());

  // Làm sạch bộ nhớ LocalStorage
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
 * Đảm bảo cả 2 Tab ("Khosach" và "Config") đều tồn tại trong Google Sheet
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
    const hasConfig = sheets.some((s) => s.properties?.title === CONFIG_SHEET_TITLE);

    const requests: any[] = [];

    // 1. Nếu chưa có Tab Khosach:
    if (!hasKhosach) {
      // Nếu có sheet mặc định (không phải Config), đổi tên sheet mặc định đó thành Khosach
      const defaultSheet = sheets.find((s) => s.properties?.title !== CONFIG_SHEET_TITLE);
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

    // 2. Nếu chưa có Tab Config, thêm Tab Config ẩn ở vị trí thứ 2
    if (!hasConfig) {
      requests.push({
        addSheet: {
          properties: {
            title: CONFIG_SHEET_TITLE,
            index: 1,
            hidden: true,
            gridProperties: { frozenRowCount: 1 },
          },
        },
      });
    } else {
      // Nếu đã có Tab Config nhưng chưa ẩn, tiến hành ẩn Tab Config để người dùng không xóa nhầm
      const configSheet = sheets.find((s) => s.properties?.title === CONFIG_SHEET_TITLE);
      if (configSheet && !configSheet.properties?.hidden && configSheet.properties?.sheetId !== undefined) {
        requests.push({
          updateSheetProperties: {
            properties: {
              sheetId: configSheet.properties.sheetId,
              hidden: true,
            },
            fields: 'hidden',
          },
        });
      }
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

    // 3. Quét lại để xóa hoàn toàn mọi Tab rác (như Sheet1, Trang tính 1, ...) không phải Khosach và Config
    const metaResp2 = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (metaResp2.ok) {
      const meta2 = await metaResp2.json();
      const sheets2: any[] = meta2.sheets || [];
      const extraSheets = sheets2.filter(
        (s) => s.properties?.title !== KHOSACH_SHEET_TITLE && s.properties?.title !== CONFIG_SHEET_TITLE
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
 * Khởi tạo tiêu đề các cột chuẩn tiếng Việt cho 2 Tab
 */
async function initializeSheetHeaders(
  accessToken: string,
  spreadsheetId: string,
  userEmail: string,
  fileName?: string
) {
  try {
    const cleanEmail = (userEmail && userEmail.trim().toLowerCase()) || 'tuanta3012@gmail.com';
    const activeFileName = fileName || 'Tu sach gia dinh';
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

    // 2. Tab Config (Thành viên gia đình & Cấu hình Metadata)
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
    });

    // 3. Tab Config Metadata (__METADATA_JSON__)
    const metaObj: SheetConfigMetadata = {
      schemaVersion: 2,
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
      appName: 'Tủ Sách Gia Đình',
      appVersion: '1.0.0',
      lastSyncBy: cleanEmail,
      ignoredDuplicatePairs: [],
      resolvedDuplicates: [],
      auditLog: [
        {
          action: 'CREATED_SPREADSHEET',
          timestamp: nowIso,
          actor: cleanEmail,
        },
      ],
    };

    const metaData = [
      ['Key', 'Value'],
      ['__METADATA_JSON__', JSON.stringify(metaObj)],
      ['status', 'active'],
      ['activeFileId', spreadsheetId],
      ['activeFileName', activeFileName],
      ['activeFileUrl', activeFileUrl],
      ['adminEmail', cleanEmail],
      ['linkedAccountEmail', cleanEmail],
      ['updatedAt', nowIso],
      ['updatedAtVi', timeVi],
    ];

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!E1:F10?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: metaData }),
    });
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
 * 4. Đọc danh sách thành viên gia đình từ Tab "Config"
 */
export async function fetchFamilyMembers(
  accessToken: string,
  spreadsheetId: string
): Promise<FamilyMember[]> {
  try {
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
      const email = String(row[0]).trim();
      const roleRaw = String(row[1] || 'Viewer').trim();
      const role = (roleRaw === 'Owner' || roleRaw === 'Editor') ? roleRaw : 'Viewer';
      const addedAt = row[2] ? String(row[2]) : new Date().toISOString();

      if (email.includes('@')) {
        members.push({ email, role, addedAt });
      }
    }
    return members;
  } catch (err) {
    console.warn('[DriveSync] Không đọc được Tab Config:', err);
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

  // 2. Ghi nhận thành viên vào Tab Config
  const existingMembers = await fetchFamilyMembers(accessToken, spreadsheetId);
  const updatedMembers = existingMembers.filter((m) => m.email.toLowerCase() !== cleanEmail);
  updatedMembers.push({
    email: cleanEmail,
    role,
    addedAt: new Date().toISOString(),
  });

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
}

/**
 * 6. Xóa thành viên khỏi gia đình
 */
export async function removeFamilyMember(
  accessToken: string,
  spreadsheetId: string,
  email: string
): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();

  // Đọc danh sách permissions từ Drive API để tìm permissionId tương ứng
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

  // Cập nhật lại Tab Config
  const existing = await fetchFamilyMembers(accessToken, spreadsheetId);
  const remaining = existing.filter((m) => m.email.toLowerCase() !== cleanEmail);

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
 * Dynamic Authorization Verification: Xác thực chéo vai trò dựa trên email đối chiếu với tab Config ẩn
 */
export async function determineCurrentUserRole(
  accessToken: string,
  spreadsheetId: string,
  userEmail: string
): Promise<UserRole> {
  try {
    const cleanEmail = userEmail.trim().toLowerCase();
    const members = await fetchFamilyMembers(accessToken, spreadsheetId);
    
    // Tìm kiếm email của chính mình trong danh sách thành viên của Google Sheet
    const matched = members.find((m) => m.email.toLowerCase() === cleanEmail);
    if (matched) {
      if (matched.role === 'Owner') return 'ADMIN';
      if (matched.role === 'Editor') return 'EDITOR';
      return 'VIEWER';
    }
  } catch (err) {
    console.warn('[DriveSync] determineCurrentUserRole error:', err);
  }
  // Mặc định ban đầu hoặc nếu là chủ sở hữu gốc (không có trong members) là ADMIN
  return 'ADMIN';
}

/**
 * Đọc Metadata cấu hình trạng thái (active / unlinked) từ Tab Config ẩn
 */
export async function fetchSheetConfigMetadata(
  accessToken: string,
  spreadsheetId: string
): Promise<SheetConfigMetadata | null> {
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!E1:F10`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const rows: any[][] = data.values || [];
    let fallbackStatus: 'active' | 'unlinked' = 'active';
    let fallbackAdmin = '';

    for (const row of rows) {
      if (row[0] === '__METADATA_JSON__' && row[1]) {
        try {
          return JSON.parse(row[1]) as SheetConfigMetadata;
        } catch {}
      }
      if (row[0] === 'Status' && row[1]) {
        fallbackStatus = row[1] === 'unlinked' ? 'unlinked' : 'active';
      }
      if (row[0] === 'AdminEmail' && row[1]) {
        fallbackAdmin = row[1];
      }
    }
    return {
      status: fallbackStatus,
      adminEmail: fallbackAdmin,
      appName: 'Tủ Sách Gia Đình',
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn('[DriveSync] fetchSheetConfigMetadata failed:', err);
  }
  return null;
}

/**
 * Cập nhật trạng thái liên kết (active hoặc unlinked) trực tiếp lên Tab Config ẩn của Google Sheet
 */
export async function updateSheetConfigStatus(
  accessToken: string,
  spreadsheetId: string,
  status: 'active' | 'unlinked',
  adminEmail?: string,
  fileName?: string
): Promise<void> {
  try {
    const existing = await fetchSheetConfigMetadata(accessToken, spreadsheetId);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const timeVi = formatVietnameseFullDate(nowMs);
    const currentAdmin = adminEmail || existing?.adminEmail || '';
    const currentFileName = fileName || existing?.activeFileName || 'Tu sach gia dinh';
    const fileUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?usp=drivesdk`;

    const updatedAuditLog = [
      ...(existing?.auditLog || []),
      {
        action: status === 'active' ? 'LINKED_ACTIVE' : 'UNLINKED',
        timestamp: nowIso,
        actor: currentAdmin,
      },
    ];

    const meta: SheetConfigMetadata = {
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
      appName: existing?.appName || 'Tủ Sách Gia Đình',
      appVersion: existing?.appVersion || '1.0.0',
      lastSyncBy: currentAdmin,
      ignoredDuplicatePairs: existing?.ignoredDuplicatePairs || [],
      resolvedDuplicates: existing?.resolvedDuplicates || [],
      auditLog: updatedAuditLog,
    };

    const rows = [
      ['Key', 'Value'],
      ['__METADATA_JSON__', JSON.stringify(meta)],
      ['status', status],
      ['activeFileId', spreadsheetId],
      ['activeFileName', currentFileName],
      ['activeFileUrl', fileUrl],
      ['adminEmail', currentAdmin],
      ['linkedAccountEmail', currentAdmin],
      ['updatedAt', nowIso],
      ['updatedAtVi', timeVi],
    ];

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!E1:F10?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: rows }),
    });
    console.log(`[DriveSync] Đã cập nhật trạng thái sheet (${spreadsheetId}) thành: ${status}`);
  } catch (err) {
    console.warn('[DriveSync] updateSheetConfigStatus error:', err);
  }
}

/**
 * Ghi nhận nhật ký xử lý sách trùng lặp (ví dụ: gộp/sửa/bỏ qua) vào Metadata Config
 */
export async function recordDuplicateResolutionRecord(
  accessToken: string,
  spreadsheetId: string,
  logItem: Omit<DuplicateResolutionLog, 'resolvedAt'>
): Promise<void> {
  try {
    const existing = await fetchSheetConfigMetadata(accessToken, spreadsheetId);
    if (!existing) return;

    const fullLogItem: DuplicateResolutionLog = {
      ...logItem,
      resolvedAt: new Date().toISOString(),
    };

    const updatedResolved = [...(existing.resolvedDuplicates || []), fullLogItem];
    const meta: SheetConfigMetadata = {
      ...existing,
      updatedAt: new Date().toISOString(),
      resolvedDuplicates: updatedResolved,
    };

    const rows = [
      ['Key', 'Value'],
      ['__METADATA_JSON__', JSON.stringify(meta)],
      ['Status', meta.status],
      ['AdminEmail', meta.adminEmail || ''],
      ['AppName', meta.appName || 'Tủ Sách Gia Đình'],
      ['UpdatedAt', meta.updatedAt],
    ];

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!E1:F6?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: rows }),
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
 * Đồng bộ danh sách các cặp sách đã xác nhận không trùng với Google Sheet (Tab Config ẩn)
 */
export async function syncIgnoredDuplicatePairsWithDrive(
  accessToken: string,
  spreadsheetId: string,
  newPairsToAdd?: string[]
): Promise<string[]> {
  try {
    const local = getLocalIgnoredDuplicatePairs();
    const existingMeta = await fetchSheetConfigMetadata(accessToken, spreadsheetId);
    const remote = existingMeta?.ignoredDuplicatePairs || [];

    const mergedSet = new Set<string>([...local, ...remote, ...(newPairsToAdd || [])]);
    const mergedList = Array.from(mergedSet);

    saveLocalIgnoredDuplicatePairs(mergedList);

    // Nếu có thay đổi hoặc cặp mới cần lưu lên Google Sheet Tab Config
    if (mergedList.length !== remote.length || (newPairsToAdd && newPairsToAdd.length > 0)) {
      const meta: SheetConfigMetadata = {
        ...existingMeta,
        status: existingMeta?.status || 'active',
        adminEmail: existingMeta?.adminEmail || '',
        updatedAt: new Date().toISOString(),
        ignoredDuplicatePairs: mergedList,
      };

      const rows = [
        ['Key', 'Value'],
        ['__METADATA_JSON__', JSON.stringify(meta)],
        ['Status', meta.status],
        ['AdminEmail', meta.adminEmail || ''],
        ['AppName', meta.appName || 'Tủ Sách Gia Đình'],
        ['UpdatedAt', meta.updatedAt],
      ];

      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG_SHEET_TITLE}!E1:F6?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: rows }),
      });
      console.log(`[DriveSync] Đã lưu ${mergedList.length} cặp không trùng lặp lên Google Drive Config!`);
    }

    return mergedList;
  } catch (err) {
    console.warn('[DriveSync] syncIgnoredDuplicatePairsWithDrive error:', err);
    return getLocalIgnoredDuplicatePairs();
  }
}

/**
 * Tự động tìm kiếm các tệp Google Sheet trên Drive theo đúng tab Config ẩn:
 * - Chỉ chấp nhận các file có status == "active"
 * - Bỏ qua hoàn toàn các file có status == "unlinked"
 * - Luồng khám phá file thông minh (Auto-Discovery)
 */
export async function autoDiscoverSharedSpreadsheets(
  accessToken: string,
  userEmail: string
): Promise<SpreadsheetInfo[]> {
  try {
    const cleanEmail = userEmail.trim().toLowerCase();
    const spreadsheets = await fetchUserSpreadsheetsFromDrive(accessToken);
    const discovered: SpreadsheetInfo[] = [];

    // Quét tối đa 15 file gần nhất để kiểm tra tab Config ẩn và trạng thái active
    const limit = Math.min(spreadsheets.length, 15);
    for (let i = 0; i < limit; i++) {
      const sheet = spreadsheets[i];
      try {
        const meta = await fetchSheetConfigMetadata(accessToken, sheet.id);
        
        // 1. Nếu file đã bị Admin chủ động hủy liên kết (status == "unlinked") -> BỎ QUA NGAY!
        if (meta && meta.status === 'unlinked') {
          console.log(`[AutoDiscover] File "${sheet.name}" có status unlinked -> Bỏ qua.`);
          continue;
        }

        // 2. Nếu file có Tab Config với trạng thái active -> Bắt buộc nhận diện ngay!
        if (meta?.status === 'active') {
          console.log(`[AutoDiscover] Tìm thấy file active do app tạo: "${sheet.name}" (${sheet.id})`);
          saveKnownSpreadsheet(sheet);
          if (meta.adminEmail) {
            synchronizeDrivePermissionsWithJsonMembers(accessToken, sheet.id, meta.adminEmail).catch(() => {});
          }
          discovered.push(sheet);
        } else {
          // Hoặc kiểm tra xem tài khoản có nằm trong danh sách thành viên không
          const members = await fetchFamilyMembers(accessToken, sheet.id).catch(() => []);
          const hasMember = members.some((m) => m.email.toLowerCase() === cleanEmail);
          const isAdmin = meta?.adminEmail?.toLowerCase() === cleanEmail || 
                          members.some(m => m.email.toLowerCase() === cleanEmail && m.role === 'Owner');

          if (isAdmin || hasMember || members.length === 0) {
            saveKnownSpreadsheet(sheet);
            discovered.push(sheet);
          }
        }
      } catch {
        // Nếu đọc tab Config gặp lỗi tạm thời nhưng là file của ứng dụng -> vẫn ưu tiên thêm vào
        saveKnownSpreadsheet(sheet);
        discovered.push(sheet);
      }
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

