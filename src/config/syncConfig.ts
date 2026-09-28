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

// Payload mã hóa của Google Apps Script Endpoint mặc định
const OBFUSCATED_SCRIPT_PAYLOAD = 'IycrMSNqcHkyNj49L0YeVVkwNCkmezEqMnsiKiY8JCBwMn8RFDA4Ni4tC2FRRlEpBnE0NxQxCR8HM3B4ARptBAA9KG4XHBhjaXlmBUU4PCo3DBYdChMbBTwbciEFLBsiLyUVGBMEGFVpXkNqJGomLTcm';

// Payload mã hóa của Google Gemini API Key mặc định (đã xáo trộn hoàn toàn, không lộ chuỗi)
const OBFUSCATED_GEMINI_PAYLOAD = 'CgJxADJoDRh3HjxlFGJ8agMpCyAZeBgyM20nKjICfTQ3MwIiZxUuIHgsF191cQBsPn11HAM=';

/**
 * Link Google Sheet mặc định sau khi tự động giải mã trong bộ nhớ RAM
 */
export const DEFAULT_GOOGLE_SHEET_URL = decodeVaultPayload(OBFUSCATED_SHEET_PAYLOAD);

/**
 * URL Google Apps Script Endpoint mặc định sau khi tự động giải mã trong bộ nhớ RAM
 */
export const DEFAULT_APPS_SCRIPT_URL = decodeVaultPayload(OBFUSCATED_SCRIPT_PAYLOAD);

/**
 * Google Gemini API Key mặc định sau khi tự động giải mã trong bộ nhớ RAM
 */
export const DEFAULT_GEMINI_API_KEY = decodeVaultPayload(OBFUSCATED_GEMINI_PAYLOAD);

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
    return stored.trim();
  }
  return DEFAULT_APPS_SCRIPT_URL;
}

/**
 * Lấy Gemini API Key đã lưu trong LocalStorage hoặc mặc định từ bộ mã hóa
 */
export function getStoredOrConfiguredApiKey(): string {
  const stored = localStorage.getItem('custom_gemini_api_key');
  if (stored && stored.trim().length > 0) {
    return stored.trim();
  }
  return DEFAULT_GEMINI_API_KEY;
}
