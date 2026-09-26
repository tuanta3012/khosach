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

    const book: BookRecord = {
      id: (idIdx !== -1 && idIdx < row.length && row[idIdx]) ? row[idIdx] : `sheet_import_${Date.now()}_${i}`,
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
 * Đẩy dữ liệu sạch từ App/Firestore lên Google Drive qua Web App Apps Script
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

  // Lần 1: Thử POST tiêu chuẩn
  try {
    const response = await fetch(cleanUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    const data = await response.json();
    if (data.status === 'success') {
      return {
        success: true,
        message: data.message || `Đã đẩy thành công ${books.length} cuốn sách lên Google Drive / Google Sheet!`,
        count: data.count || books.length,
      };
    } else {
      throw new Error(data.message || 'Lỗi không xác định từ Apps Script');
    }
  } catch (err: any) {
    console.warn('Standard POST failed, retrying with fallback mode...', err);
    
    // Lần 2: Thử POST khẩn cấp qua no-cors (Tránh tuyệt đối lỗi CORS Browser)
    try {
      await fetch(cleanUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body: JSON.stringify(payload),
      });

      return {
        success: true,
        message: `Đã phát lệnh đẩy ${books.length} cuốn sách lên Google Sheet/Drive thành công (chế độ bảo mật no-cors)!`,
        count: books.length,
      };
    } catch (fallbackErr: any) {
      throw new Error(
        'Không thể đẩy dữ liệu lên Google Drive.\n\n' +
        '👉 Bạn vui lòng kiểm tra lại URL Google Apps Script đã có dạng https://script.google.com/macros/s/.../exec chưa.'
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
  // 1. Thử Đọc Trực Tiếp Từ Google Sheet CSV (NẾU người dùng có dán link Google Sheet)
  if (targetFileUrl && targetFileUrl.trim()) {
    const sheetMatch = targetFileUrl.trim().match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (sheetMatch && sheetMatch[1]) {
      const spreadsheetId = sheetMatch[1];
      const directCsvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv`;
      
      try {
        const directResp = await fetch(directCsvUrl);
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
      } catch (directErr) {
        console.warn('Direct Google Sheet CSV fetch failed, falling back to Apps Script Web App...', directErr);
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

    const response = await fetch(reqUrl, { method: 'GET', redirect: 'follow' });
    const data = await response.json();

    if (data.status === 'success' || Array.isArray(data.books)) {
      const rawBooks = data.books || [];
      const parsedBooks: BookRecord[] = rawBooks.map((item: any, idx: number) => ({
        id: item.id || `drive_import_${Date.now()}_${idx}`,
        title: String(item.title || item.name || '').trim(),
        author: String(item.author || item.writer || 'Chưa rõ').trim(),
        category: String(item.category || item.genre || 'Chung').trim(),
        publisher: String(item.publisher || item.nxb || '').trim(),
        updated_at: item.updated_at || Date.now(),
        created_at: item.created_at || Date.now(),
      })).filter((b: BookRecord) => b.title.length > 0);

      return {
        success: true,
        books: parsedBooks,
        message: `Đã kéo thành công ${parsedBooks.length} cuốn sách từ Google Drive!`,
      };
    } else {
      throw new Error(data.message || 'Lỗi đọc file từ Apps Script');
    }
  } catch (err: any) {
    console.error('Pull from Drive error:', err);
    throw new Error(
      `Không thể kéo dữ liệu từ Google Drive: ${err.message || 'Lỗi kết nối'}\n\n` +
      '👉 MẸO DỄ NHẤT: Trong ô "Link File Google Sheet", đảm bảo file Google Sheet của bạn được đặt quyền "Bất kỳ ai có liên kết đều có thể xem" (Anyone with the link can view).'
    );
  }
}
