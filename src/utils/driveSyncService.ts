import { BookRecord } from '../types';

/**
 * Mã nguồn Google Apps Script mẫu để người dùng dán vào script.google.com
 */
export const GOOGLE_APPS_SCRIPT_CODE = `/**
 * GOOGLE APPS SCRIPT - CẦU NỐI ĐỒNG BỘ KHO SÁCH 2 CHIỀU
 * Hướng dẫn cấp quyền & triển khai:
 * 1. Mở https://script.google.com -> Tạo Dự án mới
 * 2. Dán toàn bộ mã này vào file Code.gs -> Bấm Lưu (Ctrl + S)
 * 3. QUAN TRỌNG (CẤP QUYỀN TRUY CẬP):
 *    - Ở thanh công cụ trên cùng, chọn hàm 'setupPermissions'
 *    - Bấm nút 'Chạy' (Run) -> Bấm 'Xem lại quyền' (Review Permissions) -> Chọn Tài khoản Google -> Bấm 'Nâng cao' (Advanced) -> Bấm 'Đi tới Kho sach (không an toàn)' -> Bấm 'Cho phép' (Allow).
 * 4. BẤM TRIỂN KHAI (DEPLOY):
 *    - Bấm 'Triển khai' -> 'Triển khai dưới dạng ứng dụng web'
 *    - Thực thi dưới dạng (Execute as): 'Tôi' (Me)
 *    - Ai có quyền truy cập (Who has access): 'Bất kỳ ai' (Anyone)
 * 5. Bấm Triển khai và Sao chép Web App URL dán vào ứng dụng Kho Sách!
 */

// DÁN LINK GOOGLE SHEET CỦA BẠN VÀO ĐÂY (NẾU CÓ):
const TARGET_FILE_URL = "";

const SHEET_NAME = "KhoSachClean";

/**
 * HÀM CẤP QUYỀN TRUY CẬP TRỰC TIẾP TRÊN EDITOR (BẮT BUỘC CHẠY 1 LẦN TRƯỚC KHI DEPLOY)
 */
function setupPermissions() {
  Logger.log("Đang kiểm tra & xin cấp quyền truy cập Google Sheets & Google Drive...");
  try {
    var ss = getSpreadsheet("");
    Logger.log("✅ CẤP QUYỀN THÀNH CÔNG! Tên file đang dùng: " + ss.getName());
    return "Cấp quyền thành công: " + ss.getName();
  } catch (err) {
    Logger.log("❌ Lỗi cấp quyền: " + err.toString());
    throw err;
  }
}

function getSpreadsheet(fileUrlParam) {
  var url = fileUrlParam || TARGET_FILE_URL;
  if (url && typeof url === 'string' && url.trim().length > 0) {
    var cleanUrl = url.trim();
    try {
      return SpreadsheetApp.openByUrl(cleanUrl);
    } catch(e1) {
      // Thử trích xuất Spreadsheet ID từ URL
      var match = cleanUrl.match(/\\/d\\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        try {
          return SpreadsheetApp.openById(match[1]);
        } catch(e2) {}
      }
    }
  }
  
  // Fallback 1: Active Spreadsheet nếu script đính kèm trực tiếp trong Sheet
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch(e3) {}
  
  // Fallback 2: Tìm hoặc Tạo file Google Sheet tên Kho_Sach_Clean_Database trong Drive
  try {
    var files = DriveApp.getFilesByName("Kho_Sach_Clean_Database");
    if (files.hasNext()) {
      return SpreadsheetApp.open(files.next());
    }
  } catch(e4) {}

  return SpreadsheetApp.create("Kho_Sach_Clean_Database");
}

function doGet(e) {
  try {
    var fileUrlParam = (e && e.parameter) ? e.parameter.fileUrl : "";
    var ss = getSpreadsheet(fileUrlParam);
    
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.getSheets()[0];
      sheet.setName(SHEET_NAME);
    }
    
    var data = sheet.getDataRange().getValues();
    if (!data || data.length <= 1) {
      return ContentService.createTextOutput(JSON.stringify({ status: "success", count: 0, books: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    var books = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row || (!row[0] && !row[1])) continue;
      
      var book = {
        id: row[0] ? String(row[0]) : 'book_' + Date.now() + '_' + i,
        title: String(row[1] || '').trim(),
        author: String(row[2] || '').trim(),
        category: String(row[3] || 'Chung').trim(),
        publisher: String(row[4] || '').trim(),
        updated_at: row[5] ? new Date(row[5]).getTime() : Date.now()
      };
      if (book.title) books.push(book);
    }
    
    return ContentService.createTextOutput(JSON.stringify({ status: "success", count: books.length, books: books }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Lỗi Google Apps Script: " + err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    var contents = {};
    if (e && e.postData && e.postData.contents) {
      contents = JSON.parse(e.postData.contents);
    }
    var books = contents.books || [];
    var fileUrlParam = contents.fileUrl || "";
    
    var ss = getSpreadsheet(fileUrlParam);
    
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.getSheets()[0];
      sheet.setName(SHEET_NAME);
    }
    
    // Ghi đè toàn bộ dữ liệu đã làm sạch
    sheet.clear();
    sheet.appendRow(["ID", "Tên Sách", "Tác Giả", "Thể Loại", "Nhà Xuất Bản", "Ngày Cập Nhật"]);
    
    // Đặt định dạng tiêu đề
    sheet.getRange(1, 1, 1, 6).setFontWeight("bold").setBackground("#e6f4ea");
    
    var rows = books.map(function(b) {
      return [
        b.id || '',
        b.title || '',
        b.author || '',
        b.category || 'Chung',
        b.publisher || '',
        b.updated_at ? new Date(b.updated_at).toLocaleString('vi-VN') : new Date().toLocaleString('vi-VN')
      ];
    });
    
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, 6).setValues(rows);
    }
    
    return ContentService.createTextOutput(JSON.stringify({ 
      status: "success", 
      message: "Đã cập nhật " + books.length + " cuốn sách sạch lên Google Sheet/Drive thành công!", 
      count: books.length 
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Lỗi Google Apps Script: " + err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
`;

/**
 * Sanitize và chuẩn hóa URL Google Apps Script Web App
 */
export function sanitizeAppsScriptUrl(url: string): string {
  if (!url) return '';
  let cleaned = url.trim();
  
  // Nếu dán link trang chỉnh sửa Apps Script (/edit, /dev, /view) -> Đổi thành /exec
  cleaned = cleaned.replace(/\/edit(\?.*)?$/i, '/exec');
  cleaned = cleaned.replace(/\/dev(\?.*)?$/i, '/exec');
  cleaned = cleaned.replace(/\/view(\?.*)?$/i, '/exec');
  
  // Nếu dán link dạng https://script.google.com/macros/s/AKfyc... mà thiếu /exec ở cuối
  if (cleaned.includes('/macros/s/') && !cleaned.endsWith('/exec')) {
    cleaned = cleaned.replace(/\/+$/, '') + '/exec';
  }
  
  return cleaned;
}

/**
 * Chuẩn hóa Book ID hợp lệ
 */
export function sanitizeDocId(id: string): string {
  if (!id) return '';
  // Chỉ giữ lại chữ cái, chữ số, gạch nối, gạch dưới. Loại bỏ khoảng trắng và mọi ký tự đặc biệt bao gồm cả dấu '/'
  return id.replace(/[^a-zA-Z0-9_\-]/g, '').trim();
}

/**
 * Parse CSV text từ Google Sheet gviz/tq?tqx=out:csv
 */
export function parseGoogleSheetCsvText(csvText: string): BookRecord[] {
  if (!csvText || !csvText.trim()) return [];
  
  const lines: string[] = [];
  let currentLine = '';
  let inQuotes = false;
  
  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      currentLine += char;
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && csvText[i + 1] === '\n') i++;
      if (currentLine.trim()) lines.push(currentLine);
      currentLine = '';
    } else {
      currentLine += char;
    }
  }
  if (currentLine.trim()) lines.push(currentLine);
  if (lines.length === 0) return [];

  const parseCsvLine = (line: string): string[] => {
    const result: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (c === ',' && !inQ) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    result.push(cur.trim());
    return result;
  };

  const headerCells = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/^"|"$/g, '').trim());
  
  let idIdx = headerCells.findIndex(h => h.includes('id'));
  let titleIdx = headerCells.findIndex(h => h.includes('tên') || h.includes('title') || h.includes('sách'));
  let authorIdx = headerCells.findIndex(h => h.includes('tác giả') || h.includes('author') || h.includes('người viết'));
  let categoryIdx = headerCells.findIndex(h => h.includes('thể loại') || h.includes('category') || h.includes('loại'));
  let publisherIdx = headerCells.findIndex(h => h.includes('nhà xuất bản') || h.includes('nxb') || h.includes('publisher'));

  if (titleIdx === -1 && headerCells.length > 1) titleIdx = 1;
  if (titleIdx === -1 && headerCells.length > 0) titleIdx = 0;
  if (authorIdx === -1 && headerCells.length > 2) authorIdx = 2;
  if (categoryIdx === -1 && headerCells.length > 3) categoryIdx = 3;
  if (publisherIdx === -1 && headerCells.length > 4) publisherIdx = 4;

  const books: BookRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]).map(c => c.replace(/^"|"$/g, '').trim());
    const title = titleIdx !== -1 && titleIdx < row.length ? row[titleIdx] : '';
    if (!title || title.toLowerCase() === 'tên sách' || title.toLowerCase() === 'title') continue;

    const rawId = (idIdx !== -1 && idIdx < row.length && row[idIdx]) ? row[idIdx] : '';
    const bookId = sanitizeDocId(rawId) || `sheet_import_${Date.now()}_${i}`;

    const book: BookRecord = {
      id: bookId,
      title: title,
      author: (authorIdx !== -1 && authorIdx < row.length && row[authorIdx]) ? row[authorIdx] : 'Chưa rõ',
      category: (categoryIdx !== -1 && categoryIdx < row.length && row[categoryIdx]) ? row[categoryIdx] : 'Chung',
      publisher: (publisherIdx !== -1 && publisherIdx < row.length && row[publisherIdx]) ? row[publisherIdx] : '',
      updated_at: Date.now(),
      created_at: Date.now(),
    };
    books.push(book);
  }

  return books;
}

/**
 * Helper để lấy URL Proxy tránh lỗi CORS tuyệt đối
 */
export function getProxyUrl(targetUrl: string): string {
  const path = `/api/drive/proxy?url=${encodeURIComponent(targetUrl)}`;
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    if (origin.includes('localhost') || origin.includes('127.0.0.1') || origin.startsWith('file:')) {
      // Dành cho môi trường di động local/Capacitor hoặc localhost dev, gọi qua máy chủ AI Studio preview
      return `https://ais-pre-6xd4hn5ourvlmjugqheam6-546075383474.asia-southeast1.run.app${path}`;
    }
    return `${origin}${path}`;
  }
  return path;
}

/**
 * Đẩy dữ liệu sạch từ App/Bộ nhớ máy lên Google Drive qua Web App Apps Script
 */
export async function pushCleanDataToDriveWebApp(
  webAppUrl: string,
  books: BookRecord[],
  targetFileUrl?: string
): Promise<{ success: boolean; message: string; count?: number }> {
  const cleanUrl = sanitizeAppsScriptUrl(webAppUrl);
  if (!cleanUrl || !cleanUrl.startsWith('http')) {
    throw new Error('URL Google Apps Script không hợp lệ. Vui lòng cấu hình URL dạng https://script.google.com/macros/s/.../exec');
  }

  const payload = {
    action: 'PUSH_CLEAN_BOOKS',
    timestamp: Date.now(),
    totalCount: books.length,
    fileUrl: targetFileUrl ? targetFileUrl.trim() : '',
    books: books,
  };

  const proxyUrl = getProxyUrl(cleanUrl);
  console.log(`[pushCleanDataToDriveWebApp] Posting via proxy: ${proxyUrl}`);

  // Thử POST qua Server Proxy trước (Tránh lỗi CORS 100% và nhận được kết quả chính xác)
  try {
    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const data = await response.json();
      if (data.status === 'success') {
        addSyncLog({
          type: 'PUSH',
          url: proxyUrl,
          payload: { totalCount: books.length, booksSample: books.slice(0, 3) },
          status: response.status,
          success: true,
          responseBody: data,
        });
        return {
          success: true,
          message: data.message || `Đã đồng bộ thành công ${books.length} cuốn sách lên Google Sheet/Drive!`,
          count: data.count || books.length,
        };
      } else {
        addSyncLog({
          type: 'PUSH',
          url: proxyUrl,
          payload: { totalCount: books.length, booksSample: books.slice(0, 3) },
          status: response.status,
          success: false,
          responseBody: data,
          error: data.message || 'Lỗi trả về từ Apps Script',
        });
        throw new Error(data.message || 'Lỗi trả về từ Apps Script');
      }
    } else {
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      let parsedError = errorText;
      let parsedJson: any = null;
      try {
        parsedJson = JSON.parse(errorText);
        if (parsedJson && parsedJson.error) {
          parsedError = parsedJson.error;
        }
      } catch {}
      addSyncLog({
        type: 'PUSH',
        url: proxyUrl,
        payload: { totalCount: books.length, booksSample: books.slice(0, 3) },
        status: response.status,
        success: false,
        responseBody: parsedJson || errorText,
        error: `Proxy trả về lỗi: ${parsedError}`,
      });
      throw new Error(`Proxy trả về lỗi: ${parsedError}`);
    }
  } catch (err: any) {
    console.warn('[pushCleanDataToDriveWebApp] Proxy POST failed:', err);
    
    // Fallback: Thử POST trực tiếp bằng no-cors đề phòng trường hợp Proxy gặp sự cố kết nối,
    // nhưng thông báo rõ cho người dùng đây là lệnh mù (unconfirmed) để tránh nhầm lẫn dữ liệu.
    try {
      await fetch(cleanUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body: JSON.stringify(payload),
      });

      addSyncLog({
        type: 'PUSH',
        url: cleanUrl,
        payload: { totalCount: books.length, booksSample: books.slice(0, 3) },
        status: 0,
        success: true,
        fallbackUsed: true,
        responseBody: { message: 'Opaque response (no-cors mode: response body is protected by browsers)' },
      });

      return {
        success: true,
        message: `⚠️ Đã gửi lệnh cập nhật (${books.length} cuốn) lên Google Sheet qua no-cors. (Chú ý: Chưa thể xác nhận ghi file thành công, vui lòng kiểm tra lại cấu hình Web App nếu file Sheet chưa đổi).`,
        count: books.length,
      };
    } catch (fallbackErr: any) {
      addSyncLog({
        type: 'PUSH',
        url: cleanUrl,
        payload: { totalCount: books.length, booksSample: books.slice(0, 3) },
        status: 0,
        success: false,
        fallbackUsed: true,
        error: fallbackErr.message || String(fallbackErr),
      });
      throw new Error(
        'Không thể đẩy dữ liệu lên Google Drive.\n\n' +
        `Chi tiết lỗi: ${err.message || String(err)}\n\n` +
        '👉 MẸO: Hãy kiểm tra xem bạn đã chạy hàm setupPermissions và Triển khai lại Apps Script dưới dạng Web App (Execute as: Tôi, Who has access: Bất kỳ ai) chưa!'
      );
    }
  }
}

/**
 * Kéo dữ liệu từ Google Drive / Google Sheet về App
 */
export async function pullDataFromDriveWebApp(
  webAppUrl: string,
  targetFileUrl?: string
): Promise<{ success: boolean; books: BookRecord[]; message?: string }> {
  // 1. Thử Đọc Trực Tiếp Từ Google Sheet CSV qua CORS-Free Server Proxy
  if (targetFileUrl && targetFileUrl.trim()) {
    const sheetMatch = targetFileUrl.trim().match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (sheetMatch && sheetMatch[1]) {
      const spreadsheetId = sheetMatch[1];
      const directCsvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv`;
      const proxyCsvUrl = getProxyUrl(directCsvUrl);
      
      try {
        console.log(`[pullDataFromDriveWebApp] Fetching direct sheet CSV via proxy: ${proxyCsvUrl}`);
        const directResp = await fetch(proxyCsvUrl);
        if (directResp.ok) {
          const csvText = await directResp.text();
          if (csvText && !csvText.includes('<!DOCTYPE html>') && !csvText.includes('<html>')) {
            const parsed = parseGoogleSheetCsvText(csvText);
            if (parsed.length > 0) {
              addSyncLog({
                type: 'PULL',
                url: proxyCsvUrl,
                success: true,
                status: directResp.status,
                responseBody: { message: `Đọc CSV trực tiếp thành công. Tìm thấy ${parsed.length} cuốn sách.` },
              });
              return {
                success: true,
                books: parsed,
                message: `Đã nạp trực tiếp ${parsed.length} cuốn sách từ Google Sheet thành công!`,
              };
            }
          }
        }
      } catch (directErr: any) {
        console.warn('[pullDataFromDriveWebApp] Direct proxy CSV fetch failed, falling back to Apps Script Web App...', directErr);
      }
    }
  }

  // 2. Thử Đọc Qua Apps Script Web App Endpoint bằng Server Proxy
  const cleanUrl = sanitizeAppsScriptUrl(webAppUrl);
  if (!cleanUrl || !cleanUrl.startsWith('http')) {
    throw new Error('URL Google Apps Script không hợp lệ. Vui lòng cấu hình URL dạng https://script.google.com/macros/s/.../exec');
  }

  try {
    let reqUrl = cleanUrl;
    if (targetFileUrl && targetFileUrl.trim()) {
      const sep = reqUrl.includes('?') ? '&' : '?';
      reqUrl += `${sep}fileUrl=${encodeURIComponent(targetFileUrl.trim())}`;
    }

    const proxyAppScriptUrl = getProxyUrl(reqUrl);
    console.log(`[pullDataFromDriveWebApp] Fetching Apps Script via proxy: ${proxyAppScriptUrl}`);

    const response = await fetch(proxyAppScriptUrl);
    const data = await response.json();

    if (data.status === 'success' || Array.isArray(data.books)) {
      const rawBooks = data.books || [];
      const parsedBooks: BookRecord[] = rawBooks.map((item: any, idx: number) => {
        const rawId = String(item.id || '');
        const bookId = sanitizeDocId(rawId) || `drive_import_${Date.now()}_${idx}`;
        return {
          id: bookId,
          title: String(item.title || item.name || '').trim(),
          author: String(item.author || item.writer || 'Chưa rõ').trim(),
          category: String(item.category || item.genre || 'Chung').trim(),
          publisher: String(item.publisher || item.nxb || '').trim(),
          updated_at: item.updated_at || Date.now(),
          created_at: item.created_at || Date.now(),
        };
      }).filter((b: BookRecord) => b.title.length > 0);

      addSyncLog({
        type: 'PULL',
        url: proxyAppScriptUrl,
        success: true,
        status: response.status,
        responseBody: data,
      });

      return {
        success: true,
        books: parsedBooks,
        message: `Đã kéo thành công ${parsedBooks.length} cuốn sách từ Google Drive!`,
      };
    } else {
      addSyncLog({
        type: 'PULL',
        url: proxyAppScriptUrl,
        success: false,
        status: response.status,
        responseBody: data,
        error: data.message || 'Lỗi đọc file từ Apps Script',
      });
      throw new Error(data.message || 'Lỗi đọc file từ Apps Script');
    }
  } catch (err: any) {
    console.error('[pullDataFromDriveWebApp] Pull from Drive via proxy error:', err);
    addSyncLog({
      type: 'PULL',
      url: cleanUrl,
      success: false,
      error: err.message || String(err),
    });
    throw new Error(
      `Không thể kéo dữ liệu từ Google Drive: ${err.message || 'Lỗi kết nối proxy'}\n\n` +
      '👉 MẸO DỄ NHẤT: Trong ô "Link File Google Sheet", đảm bảo file Google Sheet của bạn được đặt quyền "Bất kỳ ai có liên kết đều có thể xem" (Anyone with the link can view).'
    );
  }
}

/**
 * HỆ THỐNG GHI LOG ĐỒNG BỘ ĐỂ DEBUG
 */
export interface SyncLogEntry {
  timestamp: number;
  type: 'PUSH' | 'PULL' | 'TEST';
  url: string;
  payload?: any;
  status?: number;
  success: boolean;
  responseBody?: any;
  error?: string;
  fallbackUsed?: boolean;
}

let syncLogs: SyncLogEntry[] = [];

export function addSyncLog(entry: Omit<SyncLogEntry, 'timestamp'>) {
  syncLogs.unshift({
    ...entry,
    timestamp: Date.now(),
  });
  if (syncLogs.length > 50) {
    syncLogs.pop();
  }
}

export function getSyncLogs(): SyncLogEntry[] {
  return syncLogs;
}

export function clearSyncLogs() {
  syncLogs = [];
}

