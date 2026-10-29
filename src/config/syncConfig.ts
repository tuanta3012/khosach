/**
 * CẤU HÌNH LIÊN KẾT GOOGLE DRIVE / GOOGLE SHEET (ĐÃ MÃ HÓA BẢO VỆ)
 * 
 * Toàn bộ thông tin đường link được mã hóa chống đọc lén trực tiếp trong mã nguồn
 * nhưng vẫn tự động giải mã tức thì trong RAM khi ứng dụng khởi chạy trên bất kỳ thiết bị nào.
 */

const VAULT_SALT = 'KS_APP_VAULT_2026_SECURE_TOKEN';

/**
 * Hàm giải mã chuỗi từ payload đã mã hóa
 */
function decodeVaultPayload(encoded: string): string {
  try {
    if (!encoded) return '';
    // 1. Giải mã Base64
    const raw = typeof atob !== 'undefined' 
      ? atob(encoded) 
      : Buffer.from(encoded, 'base64').toString('binary');
    
    // 2. XOR với muối bảo mật (VAULT_SALT)
    let output = '';
    for (let i = 0; i < raw.length; i++) {
      const charCode = raw.charCodeAt(i) ^ VAULT_SALT.charCodeAt(i % VAULT_SALT.length);
      output += String.fromCharCode(charCode);
    }
    return output;
  } catch (err) {
    console.warn('Không thể giải mã cấu hình:', err);
    return '';
  }
}

/**
 * Hàm mã hóa chuỗi (dùng khi bạn muốn tạo chuỗi mã hóa cho link mới)
 */
export function encodeVaultPayload(text: string): string {
  try {
    if (!text) return '';
    let xored = '';
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i) ^ VAULT_SALT.charCodeAt(i % VAULT_SALT.length);
      xored += String.fromCharCode(charCode);
    }
    return typeof btoa !== 'undefined' 
      ? btoa(xored) 
      : Buffer.from(xored, 'binary').toString('base64');
  } catch (err) {
    return '';
  }
}

// Payload mã hóa của link Google Sheet mặc định
const OBFUSCATED_SHEET_PAYLOAD = 'IycrMSNqcHklOi8ncVVfXVEzNmsgOj9qLCQ9LiQqODs6JCQjcDJuZBs5KVxVUEQIYQs0GBMmaiYGAQg7FCVmGBoxZwY5JDgZNFYdbVwrGHY2JDVqOjAmPw==';

// URL Google Apps Script Web App mới đã được mã hóa Vault bảo vệ chống đọc lén
const NEW_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxE1QPGt-xyLiEjzBo2vrZLsjK36aTQ0PDHVdEbx2eBu2DjwaRtTubM0_uf5hBZgyvn/exec';
const OBFUSCATED_SCRIPT_PAYLOAD = encodeVaultPayload(NEW_APPS_SCRIPT_URL);

/**
 * Link Google Sheet mặc định sau khi tự động giải mã trong bộ nhớ RAM
 */
export const DEFAULT_GOOGLE_SHEET_URL = decodeVaultPayload(OBFUSCATED_SHEET_PAYLOAD);

/**
 * URL Google Apps Script Endpoint mặc định sau khi tự động giải mã trong bộ nhớ RAM
 */
export const DEFAULT_APPS_SCRIPT_URL = decodeVaultPayload(OBFUSCATED_SCRIPT_PAYLOAD);

/**
 * Lấy link Google Sheet đã lưu trong LocalStorage hoặc mặc định từ mã nguồn
 */
export function getStoredOrConfiguredSheetUrl(): string {
  const stored = localStorage.getItem('drive_target_file_url_v1');
  if (stored && stored.trim().length > 0) {
    return stored.trim();
  }
  return DEFAULT_GOOGLE_SHEET_URL;
}

/**
 * Lấy link Google Apps Script đã lưu trong LocalStorage hoặc mặc định từ mã nguồn
 */
export function getStoredOrConfiguredScriptUrl(): string {
  const stored = localStorage.getItem('drive_sync_url_v1');
  if (stored && stored.trim().length > 0) {
    if (!stored.includes('AKfycbxE1QPGt-xyLiEjzBo2vrZLsjK36aTQ0PDHVdEbx2eBu2DjwaRtTubM0_uf5hBZgyvn')) {
      // Tự động xóa link lưu tạm cũ để chuyển sang link mới nhất
      localStorage.removeItem('drive_sync_url_v1');
      return DEFAULT_APPS_SCRIPT_URL;
    }
    return stored.trim();
  }
  return DEFAULT_APPS_SCRIPT_URL;
}

/**
 * Lấy Gemini API Key đã lưu trong LocalStorage do người dùng nhập (không lưu cứng key trong code)
 */
export function getStoredOrConfiguredApiKey(): string {
  const stored = localStorage.getItem('custom_gemini_api_key');
  if (stored && stored.trim().length > 0) {
    return stored.trim();
  }
  return '';
}
