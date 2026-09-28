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
const TARGET_FILE_URL = "https://docs.google.com/spreadsheets/d/1WmvnebrW2NwMAc5rIJMu_v9YJa8PxqtMkd-_jtK3uqg/edit";

const SHEET_NAME = "KhoSachClean";

/**
 * HÀM CẤP QUYỀN TRUY CẬP TRỰC TIẾP TRÊN EDITOR (BẮT BUỘC CHẠY 1 LẦN TRƯỚC KHI DEPLOY)
 */
function setupPermissions() {
  Logger.log("Đang kiểm tra & xin cấp quyền truy cập Google Sheets & Google Drive...");
  try {
    var ss = getSpreadsheet("");
    if (ss) {
      Logger.log("✅ CẤP QUYỀN THÀNH CÔNG! Tên file đang dùng: " + ss.getName());
      return "Cấp quyền thành công: " + ss.getName();
    }
    Logger.log("✅ Cấp quyền cơ bản thành công.");
    return "Cấp quyền thành công.";
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
      var match = cleanUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        try {
          return SpreadsheetApp.openById(match[1]);
        } catch(e2) {}
      }
    }
  }
  
  // Fallback: Active Spreadsheet nếu script đính kèm trực tiếp trong Sheet
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch(e3) {}

  throw new Error("Không tìm thấy Google Sheet. Vui lòng kiểm tra link file Sheet đã dán trong cấu hình.");
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
 * Universal smart fetch helper:
 * - Trong môi trường Web Preview: Gọi qua backend proxy /api/drive/proxy để tránh CORS
 * - Trong môi trường Mobile Android APK / Standalone: Gọi trực tiếp Google Apps Script / Sheet
 */
export async function smartDriveFetch(targetUrl: string, options?: RequestInit): Promise<Response> {
  const isWebPreview = typeof window !== 'undefined' && (
    window.location.port === '3000' || 
    window.location.hostname.includes('run.app')
  );

  // 1. Thử Proxy trên Web Preview
  if (isWebPreview) {
    try {
      const proxyUrl = `/api/drive/proxy?url=${encodeURIComponent(targetUrl)}`;
      const proxyResp = await fetch(proxyUrl, options);
      if (proxyResp.ok) {
        return proxyResp;
      }
    } catch (err) {
      console.warn('[smartDriveFetch] Proxy preview failed, fallback to direct fetch...', err);
    }
  }

  // 2. Gọi Trực Tiếp (Dùng cho Mobile Android APK, Capacitor hoặc khi Proxy lỗi)
  const fetchOptions: RequestInit = {
    ...options,
    redirect: 'follow',
  };

  // Nếu là POST gửi lên Google Apps Script, dùng text/plain để tránh preflight CORS OPTIONS
  if (options?.method === 'POST') {
    fetchOptions.headers = {
      'Content-Type': 'text/plain;charset=utf-8',
      ...(options.headers || {}),
    };
  }

  return await fetch(targetUrl, fetchOptions);
}

/**
 * Đẩy dữ liệu sách lên Google Sheet qua Apps Script Web App
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

  try {
    const response = await smartDriveFetch(cleanUrl, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const rawText = await response.text().catch(() => '');
    let data: any = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }

    if (response.ok && data && data.status === 'success') {
      return {
        success: true,
        message: data.message || `Đã đồng bộ thành công ${books.length} cuốn sách lên Google Sheet!`,
        count: data.count || books.length,
      };
    } else {
      let parsedError = (data && (data.error || data.message)) || rawText || `HTTP ${response.status}`;
      if (rawText.includes('<!DOCTYPE') || rawText.includes('<html')) {
        parsedError = 'Google Apps Script trả về trang web HTML. Vui lòng kiểm tra quyền Web App (Who has access: Anyone).';
      }
      throw new Error(parsedError);
    }
  } catch (err: any) {
    console.warn('[pushCleanDataToDriveWebApp] Primary push failed, attempting no-cors fallback:', err);
    try {
      // Fallback cho trình duyệt có chính sách CORS nghiêm ngặt
      await fetch(cleanUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
      });

      return {
        success: true,
        message: `Đã gửi ${books.length} cuốn sách lên Google Sheet!`,
        count: books.length,
      };
    } catch (fallbackErr: any) {
      throw new Error(`Lỗi kết nối Apps Script: ${err.message || String(err)}`);
    }
  }
}

/**
 * Kéo dữ liệu từ Google Sheet / Google Drive về App
 */
export async function pullDataFromDriveWebApp(
  webAppUrl: string,
  targetFileUrl?: string
): Promise<{ success: boolean; books: BookRecord[]; message?: string }> {
  // 1. Thử Đọc Trực Tiếp Từ Google Sheet CSV
  if (targetFileUrl && targetFileUrl.trim()) {
    const sheetMatch = targetFileUrl.trim().match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (sheetMatch && sheetMatch[1]) {
      const spreadsheetId = sheetMatch[1];
      const directCsvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv`;
      
      try {
        const directResp = await smartDriveFetch(directCsvUrl);
        if (directResp.ok) {
          const csvText = await directResp.text();
          if (csvText && !csvText.includes('<!DOCTYPE html>') && !csvText.includes('<html>')) {
            const parsed = parseGoogleSheetCsvText(csvText);
            if (parsed.length > 0) {
              return {
                success: true,
                books: parsed,
                message: `Đã nạp trực tiếp ${parsed.length} cuốn sách từ Google Sheet thành công!`,
              };
            }
          }
        }
      } catch (directErr: any) {
        console.warn('[pullDataFromDriveWebApp] Direct sheet CSV fetch failed, fallback to Apps Script...', directErr);
      }
    }
  }

  // 2. Thử Đọc Qua Apps Script Web App Endpoint
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

    const response = await smartDriveFetch(reqUrl);
    const rawText = await response.text().catch(() => '');
    
    let data: any = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      let htmlError = 'Phản hồi từ Google không phải dữ liệu JSON hợp lệ.';
      if (rawText.includes('<!DOCTYPE') || rawText.includes('<html')) {
        if (rawText.includes('Page not found') || rawText.includes('does not exist')) {
          htmlError = 'URL Google Apps Script không tồn tại hoặc chưa triển khai (404 Not Found).';
        } else if (rawText.includes('accounts.google.com') || rawText.includes('Sign in')) {
          htmlError = 'URL Google Apps Script yêu cầu đăng nhập. Cần cấp quyền "Who has access: Anyone".';
        } else {
          htmlError = 'Google Apps Script trả về HTML thay vì JSON. Vui lòng kiểm tra lại Web App.';
        }
      }
      return {
        success: false,
        books: [],
        message: htmlError,
      };
    }

    if (data && (data.status === 'success' || Array.isArray(data.books))) {
      const rawBooks = data.books || [];
      const parsedBooks: BookRecord[] = rawBooks.map((item: any, idx: number) => {
        const rawId = String(item.id || '');
        const bookId = sanitizeDocId(rawId) || `drive_import_${Date.now()}_${idx}`;
        return {
          id: bookId,
          title: String(item.title || item.name || item['Tên Sách'] || '').trim(),
          author: String(item.author || item.writer || item['Tác Giả'] || 'Chưa rõ').trim(),
          category: String(item.category || item.genre || item['Thể Loại'] || 'Chung').trim(),
          publisher: String(item.publisher || item.nxb || item['Nhà Xuất Bản'] || '').trim(),
          updated_at: item.updated_at ? Number(item.updated_at) : Date.now(),
          created_at: item.created_at ? Number(item.created_at) : Date.now(),
        };
      }).filter((b: BookRecord) => b.title.length > 0);

      return {
        success: true,
        books: parsedBooks,
        message: `Đã kéo thành công ${parsedBooks.length} cuốn sách từ Google Drive!`,
      };
    } else {
      const errMsg = data?.error || data?.message || 'Lỗi đọc file từ Apps Script';
      return {
        success: false,
        books: [],
        message: errMsg,
      };
    }
  } catch (err: any) {
    throw new Error(`Lỗi kết nối Apps Script: ${err.message || String(err)}`);
  }
}
