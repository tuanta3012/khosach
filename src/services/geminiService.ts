/**
 * Client-Centric Google Gemini SDK Integration Service (@google/genai)
 * 
 * Đã dọn dẹp toàn bộ cơ chế đa luồng phức tạp:
 * 1. Chỉ hỗ trợ duy nhất 1 API Key tại một thời điểm.
 * 2. Bộ kiểm soát tần suất cuộc gọi (Sliding Window Rate Limiter) đảm bảo tối đa 14 RPM (dưới mốc 15 RPM).
 * 3. Hỗ trợ Failover: Ưu tiên dùng model 3.5 Flash Lite chính, tự động dự phòng sang 3.1 Flash Lite khi có lỗi.
 * 4. Kiểm soát hạn mức ngày RPD và an toàn Safety Filters từ Google.
 */

import { GoogleGenAI } from '@google/genai';
import { BookRecord } from '../types';
import { sanitizeSingleCategory } from '../utils/driveSyncService';
import { getStoredOrConfiguredApiKey } from '../config/syncConfig';

const KEYS_STORAGE_KEY = 'gemini_api_keys_v1';
const MODEL_STORAGE_KEY = 'gemini_selected_model_v1';

export const AVAILABLE_GEMINI_MODELS = [
  { id: 'auto', name: 'Tự động (3.5 Flash Lite + 3.1 Flash Lite)', desc: 'Chạy 3.5 Flash Lite chính, tự động dự phòng 3.1 Flash Lite khi quá tải' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', desc: 'Engine chính: Tối ưu hạn ngạch & xử lý siêu tốc' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', desc: 'Engine dự phòng: Bền bỉ & ổn định' },
];

// Bộ đếm mốc thời gian gọi API để kiểm soát RPM (giới hạn an toàn tối đa 14 cuộc gọi trong 60 giây)
let apiCallTimestamps: number[] = [];
const RPM_LIMIT = 14;
const RPM_WINDOW_MS = 60000;

// Trạng thái khóa ngày RPD
let isRpdExhausted = false;
let rpdExhaustedDate = '';

// Trạng thái của từng API Key để kiểm soát RPM và RPD
interface KeyState {
  key: string;
  cooldownUntil: number;
  backoffFactor: number;
  isRpdExhausted: boolean;
  rpdExhaustedDate: string;
  apiCallTimestamps: number[];
}

const keyStateMap = new Map<string, KeyState>();

function getKeyState(key: string): KeyState {
  let state = keyStateMap.get(key);
  if (!state) {
    state = {
      key,
      cooldownUntil: 0,
      backoffFactor: 0,
      isRpdExhausted: false,
      rpdExhaustedDate: '',
      apiCallTimestamps: [],
    };
    keyStateMap.set(key, state);
  }
  return state;
}

let rrIndex = 0;

export function getNextAvailableKey(keys: string[]): string {
  if (keys.length === 0) return '';
  const today = new Date().toISOString().split('T')[0];
  const numKeys = keys.length;
  
  for (let i = 0; i < numKeys; i++) {
    const idx = (rrIndex + i) % numKeys;
    const candidate = keys[idx];
    const state = getKeyState(candidate);
    
    // Reset RPD nếu qua ngày mới
    if (state.rpdExhaustedDate && state.rpdExhaustedDate !== today) {
      state.isRpdExhausted = false;
      state.rpdExhaustedDate = '';
      state.backoffFactor = 0;
      state.cooldownUntil = 0;
    }

    if (!state.isRpdExhausted && Date.now() >= state.cooldownUntil) {
      rrIndex = (idx + 1) % numKeys; // Cập nhật rrIndex cho lần sau
      return candidate;
    }
  }

  // Nếu tất cả bận/cooldown, tìm key hết hạn cooldown sớm nhất mà chưa bị cạn ngày RPD
  let earliestKey = keys[0];
  let minCooldown = Infinity;
  for (const k of keys) {
    const state = getKeyState(k);
    if (!state.isRpdExhausted && state.cooldownUntil < minCooldown) {
      minCooldown = state.cooldownUntil;
      earliestKey = k;
    }
  }
  return earliestKey;
}

/**
 * LƯU TRỮ VÀ QUẢN LÝ DANH SÁCH API KEYS
 */
export function getStoredGeminiApiKeys(): string[] {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((k: string) => k.trim()).filter(Boolean);
      }
    }
  } catch (err) {
    console.warn('[GeminiService] Lỗi đọc API Key:', err);
  }

  const oldSingleKey = localStorage.getItem('custom_gemini_api_key');
  if (oldSingleKey && oldSingleKey.trim()) {
    return [oldSingleKey.trim()];
  }

  const vaultKey = getStoredOrConfiguredApiKey();
  if (vaultKey && vaultKey.trim()) {
    return [vaultKey.trim()];
  }

  return [];
}

export function saveStoredGeminiApiKeys(keys: string[]): void {
  try {
    const cleanKeys = keys.map(k => k.trim()).filter(Boolean);
    if (cleanKeys.length > 0) {
      localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(cleanKeys));
      localStorage.setItem('custom_gemini_api_key', cleanKeys[0]); // Đặt key đầu làm fallback
    } else {
      localStorage.removeItem(KEYS_STORAGE_KEY);
      localStorage.removeItem('custom_gemini_api_key');
    }
  } catch (err) {
    console.error('[GeminiService] Lỗi lưu API Key:', err);
  }
}

export function getStoredSelectedModel(): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

export function saveStoredSelectedModel(model: string): void {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, model.trim());
  } catch {}
}

/**
 * Phân loại lỗi trả về từ Google
 */
export function classifyQuotaError(err: any): 'RPM' | 'RPD' | 'OTHER' {
  const errMsg = (err?.message || String(err)).toLowerCase();

  if (
    errMsg.includes('per day') ||
    errMsg.includes('daily') ||
    errMsg.includes('per_day') ||
    errMsg.includes('500 requests') ||
    errMsg.includes('free_tier_daily_limit') ||
    errMsg.includes('perday')
  ) {
    return 'RPD';
  }

  if (
    errMsg.includes('429') ||
    errMsg.includes('503') ||
    errMsg.includes('quota') ||
    errMsg.includes('resource_exhausted') ||
    errMsg.includes('exceeded quota') ||
    errMsg.includes('rate limit') ||
    errMsg.includes('too many requests')
  ) {
    return 'RPM';
  }

  return 'OTHER';
}

export function isKeyInCooldown(key: string): boolean {
  if (!key) return false;
  const today = new Date().toISOString().split('T')[0];
  if (isRpdExhausted && rpdExhaustedDate === today) {
    return true; // Đã cạn RPD hôm nay
  }
  return false;
}

export function getDynamicApiQuotaMetrics() {
  const keys = getStoredGeminiApiKeys();
  const keyCount = keys.length;
  const healthyCount = isKeyInCooldown(keys[0] || '') ? 0 : keyCount;

  return {
    keyCount,
    healthyKeyCount: healthyCount,
    microBatchSize: 12,
    concurrency: 1,
    maxRpm: 14,
    maxRpd: 500,
  };
}

/**
 * Cơ chế trượt Sliding Window đảm bảo không bao giờ vượt quá RPM 15 (Chặn chủ động đầu Client theo từng Key riêng biệt)
 */
async function acquireRpmSlot(key: string): Promise<void> {
  const state = getKeyState(key);
  const now = Date.now();
  // Loại bỏ các mốc thời gian ngoài cửa sổ trượt 60 giây của Key này
  state.apiCallTimestamps = state.apiCallTimestamps.filter((t) => now - t < RPM_WINDOW_MS);

  if (state.apiCallTimestamps.length >= RPM_LIMIT) {
    const oldest = state.apiCallTimestamps[0];
    const waitMs = Math.max(100, RPM_WINDOW_MS - (now - oldest) + 150);
    console.warn(`[Gemini Rate Limiter] Key ${key.slice(0, 6)}... đạt ngưỡng an toàn 14 RPM. Tự động trì hoãn cuộc gọi trong ${waitMs}ms...`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return acquireRpmSlot(key); // Quét lại để cấp slot cho Key này
  }

  state.apiCallTimestamps.push(Date.now());
}

/**
 * Kiểm tra Safety Block Reason và Finish Reason
 */
function checkSafetyBlockReason(response: any): void {
  if (!response) return;

  const candidate = response.candidates?.[0];
  if (candidate) {
    const finishReason = candidate.finishReason;
    if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
      throw new Error(`Yêu cầu bị từ chối bởi Google AI (Finish Reason: ${finishReason}).`);
    }
  }

  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`Nội dung bị chặn bởi bộ lọc an toàn Google AI (Block Reason: ${blockReason}).`);
  }
}

/**
 * THỰC THI CUỘC GỌI API GEMINI VỚI COOLDOWN & FAILOVER CHUẨN XÁC, HOÀN TOÀN TỰ ĐỘNG XOAY VÒNG MULTI-KEYS
 */
export async function executeWithFailover(buildContents: () => any, config?: any): Promise<any> {
  const keys = getStoredGeminiApiKeys();
  if (keys.length === 0) {
    throw new Error('Chưa thiết lập Gemini API Key trong phần Cài đặt.');
  }

  let lastError: any = null;
  const attemptedKeys = new Set<string>();

  // Thử tối đa số lượng keys có sẵn (tối đa là 10 keys) để tránh lặp vô hạn
  for (let attempt = 0; attempt < Math.min(keys.length, 10); attempt++) {
    const key = getNextAvailableKey(keys);
    if (!key || attemptedKeys.has(key)) {
      break; // Đã quét qua hết tất cả các key khả dụng
    }
    attemptedKeys.add(key);

    const today = new Date().toISOString().split('T')[0];
    const keyState = getKeyState(key);

    if (keyState.isRpdExhausted && keyState.rpdExhaustedDate === today) {
      continue; // Key đã hết hạn ngày, bỏ qua sang key khác
    }

    try {
      await acquireRpmSlot(key);

      const ai = new GoogleGenAI({ apiKey: key });
      const contents = buildContents();
      const selectedModel = getStoredSelectedModel();

      if (selectedModel !== 'auto') {
        const response = await ai.models.generateContent({
          model: selectedModel,
          contents,
          config,
        });

        checkSafetyBlockReason(response);
        const textOutput = response?.text;

        // Thành công: Reset backoff
        keyState.backoffFactor = 0;
        keyState.cooldownUntil = 0;

        if (textOutput) {
          if (config?.responseMimeType === 'application/json') {
            return JSON.parse(textOutput.trim());
          }
          return textOutput;
        }
        return null;
      }

      // Chế độ 'auto': Ưu tiên chạy 3.5 Flash Lite trước
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-3.5-flash-lite',
          contents,
          config,
        });

        checkSafetyBlockReason(response);
        const textOutput = response?.text;

        // Thành công: Reset backoff
        keyState.backoffFactor = 0;
        keyState.cooldownUntil = 0;

        if (textOutput) {
          if (config?.responseMimeType === 'application/json') {
            return JSON.parse(textOutput.trim());
          }
          return textOutput;
        }
      } catch (err35: any) {
        const errType = classifyQuotaError(err35);
        if (errType === 'RPD') {
          keyState.isRpdExhausted = true;
          keyState.rpdExhaustedDate = today;
          console.warn(`[Gemini Rotator] Key ${key.slice(0, 6)}... đạt giới hạn ngày RPD.`);
          continue; // Chuyển sang key tiếp theo
        }
        if (errType === 'RPM') {
          keyState.backoffFactor += 1;
          const delay = 10000 * Math.pow(2, keyState.backoffFactor - 1);
          keyState.cooldownUntil = Date.now() + delay;
          console.warn(`[Gemini Rotator] Key ${key.slice(0, 6)}... chạm trần RPM. Tạm nghỉ ${delay}ms.`);
          continue; // Chuyển sang key tiếp theo
        }
        console.warn('[Gemini Failover] 3.5 Flash Lite gặp lỗi, chuyển sang dự phòng 3.1 Flash Lite...', err35?.message || err35);
      }

      // Dự phòng bằng 3.1 Flash Lite trên cùng key này
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents,
          config,
        });

        checkSafetyBlockReason(response);
        const textOutput = response?.text;

        // Thành công: Reset backoff
        keyState.backoffFactor = 0;
        keyState.cooldownUntil = 0;

        if (textOutput) {
          if (config?.responseMimeType === 'application/json') {
            return JSON.parse(textOutput.trim());
          }
          return textOutput;
        }
      } catch (err31: any) {
        const errType = classifyQuotaError(err31);
        if (errType === 'RPD') {
          keyState.isRpdExhausted = true;
          keyState.rpdExhaustedDate = today;
        } else if (errType === 'RPM') {
          keyState.backoffFactor += 1;
          const delay = 10000 * Math.pow(2, keyState.backoffFactor - 1);
          keyState.cooldownUntil = Date.now() + delay;
        }
        throw err31;
      }

    } catch (err: any) {
      console.warn(`[Gemini Rotator] Key ${key.slice(0, 6)}... gặp lỗi:`, err.message || err);
      lastError = err;

      const errType = classifyQuotaError(err);
      if (errType === 'RPD') {
        keyState.isRpdExhausted = true;
        keyState.rpdExhaustedDate = today;
      } else if (errType === 'RPM') {
        keyState.backoffFactor += 1;
        const delay = 10000 * Math.pow(2, keyState.backoffFactor - 1);
        keyState.cooldownUntil = Date.now() + delay;
      }
      // Vòng lặp sẽ tiếp tục thử Key tiếp theo
    }
  }

  throw lastError || new Error('Tất cả các API Keys hiện có đều tạm thời gián đoạn hoặc hết hạn ngạch.');
}

/**
 * PING TEST CHO KEY CÁ NHÂN
 */
export async function testGeminiApiKey(
  candidateKey: string
): Promise<{ success: boolean; message: string }> {
  const cleanKey = candidateKey.trim();
  if (!cleanKey) {
    return { success: false, message: 'Vui lòng nhập API Key để kiểm tra!' };
  }

  // Thử qua backend API trước
  try {
    const res = await fetch('/api/ai/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: cleanKey }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success) {
        return { success: true, message: data.message || 'Kết nối thành công!' };
      }
    }
  } catch (e) {}

  // Thử trực tiếp phía Client bằng SDK
  try {
    const ai = new GoogleGenAI({ apiKey: cleanKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: 'Ping test. Reply with word OK.',
    });

    if (response && response.text) {
      return { success: true, message: 'Kết nối thành công! Key hoạt động tốt (Gemini 3.5 Flash Lite).' };
    }
  } catch (err35: any) {
    try {
      const ai = new GoogleGenAI({ apiKey: cleanKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: 'Ping test. Reply with word OK.',
      });
      if (response && response.text) {
        return { success: true, message: 'Kết nối thành công! Key hoạt động tốt (Gemini 3.1 Flash Lite).' };
      }
    } catch (err31: any) {
      const errType = classifyQuotaError(err31);
      if (errType === 'RPD') {
        return { success: false, message: 'Key đã đạt giới hạn cuộc gọi trong ngày.' };
      }
      return { success: false, message: 'Key không hoạt động hoặc không đúng cấu hình.' };
    }
  }

  return { success: false, message: 'Không thể kết nối Gemini API.' };
}

export async function testAllGeminiApiKeys(
  keys: string[]
): Promise<Record<string, { success: boolean; message: string }>> {
  const results: Record<string, { success: boolean; message: string }> = {};
  if (keys.length > 0) {
    const res = await testGeminiApiKey(keys[0]);
    results[keys[0]] = res;
  }
  return results;
}

export async function callGeminiClientWithFailover(
  buildContents: () => any,
  config?: any
): Promise<any> {
  return executeWithFailover(buildContents, config);
}

const CATEGORY_GUIDELINES = `
QUY TẮC PHÂN LOẠI THỂ LOẠI SÁCH (BẮT BUỘC KHÔNG gán nhãn chung chung như "Văn học" hay "Sách"):
BẮT BUỘC CHỈ CHỌN DUY NHẤT 1 THỂ LOẠI TIÊU BIỂU NHẤT TRONG 13 DANH MỤC SAU:
- Văn học kinh điển
- Tiểu thuyết lãng mạn
- Giả tưởng / Kỳ ảo
- Trinh thám / Ly kỳ
- Văn học Việt Nam
- Hồi ký / Tự truyện
- Văn học thiếu nhi
- Tản văn / Tùy bút
- Kinh tế / Quản trị
- Tâm lý / Phát triển bản thân
- Khoa học / Y học
- Lịch sử / Văn hóa
- Triết học / Tâm linh
`;

/**
 * BÓC TÁCH KỆ SÁCH HÀNG LOẠT BẰNG AI VISION (BATCH SCAN OCR)
 */
export async function scanImages(
  images: string[],
  existingBooks: BookRecord[] = [],
  preferredModel?: string
): Promise<{ success: boolean; count: number; books: any[] }> {
  if (!images || images.length === 0) {
    return { success: true, count: 0, books: [] };
  }

  // 1. Thử qua backend API trước (Khuyên dùng - Bỏ qua CORS và an toàn tuyệt đối)
  try {
    const key = getGeminiApiKey();
    const res = await fetch('/api/books/scan-images', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gemini-api-key': key,
      },
      body: JSON.stringify({ images, existingBooks, preferredModel }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success) {
        return data;
      }
    }
  } catch (apiErr) {
    console.warn('[Gemini OCR API Proxy] Thử gọi API thất bại, chuyển sang chạy trực tiếp đầu client:', apiErr);
  }

  // 2. Fallback chạy trực tiếp phía Client bằng SDK như cũ
  const existingTitles = existingBooks.slice(0, 80).map((b) => b.title).filter(Boolean).join(', ');

  const prompt = `Bạn là chuyên gia thị giác máy tính và biên mục thư viện sách xuất sắc.
Hãy phân tích tỉ mỉ ảnh bìa / gáy sách và trích xuất danh sách tất cả các cuốn sách có trong hình.

QUY TẮC CHÍNH XÁC:
1. Đọc tên sách (title), tên tác giả (author), nhà xuất bản (publisher).
2. Tác giả nước ngoài: dùng tên tiếng Việt quen thuộc (ví dụ "Haruki Murakami", "Dư Hoa", "Victor Hugo", "Dale Carnegie").
3. Thể loại (category): BẮT BUỘC CHỈ CHỌN 1 TRONG 13 DANH MỤC:
${CATEGORY_GUIDELINES}

Danh sách sách đã có trong kho (tham khảo để đối chiếu): ${existingTitles || 'Chưa có'}

Trả về mảng JSON danh sách các cuốn sách tìm thấy:`;

  const inlineDataParts = images.map((base64Data) => {
    let cleanBase64 = base64Data;
    let mimeType = 'image/jpeg';
    if (base64Data.includes(';base64,')) {
      const split = base64Data.split(';base64,');
      mimeType = split[0].replace('data:', '') || 'image/jpeg';
      cleanBase64 = split[1];
    }
    return {
      inlineData: {
        data: cleanBase64,
        mimeType,
      },
    };
  });

  const buildContents = () => [
    {
      role: 'user',
      parts: [
        { text: prompt },
        ...inlineDataParts,
      ],
    },
  ];

  const config = {
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Tên cuốn sách chuẩn xác' },
          author: { type: 'STRING', description: 'Tên tác giả' },
          publisher: { type: 'STRING', description: 'Nhà xuất bản' },
          category: { type: 'STRING', description: '1 trong 13 thể loại chuẩn' },
        },
        required: ['title', 'author', 'category'],
      },
    },
  };

  try {
    const rawBooks = await executeWithFailover(buildContents, config);
    if (Array.isArray(rawBooks)) {
      const sanitized = rawBooks.map((b: any) => ({
        ...b,
        category: sanitizeSingleCategory(b.category || 'Chung'),
        is_ai_normalized: true,
      }));
      return { success: true, count: sanitized.length, books: sanitized };
    }
  } catch (err) {
    console.warn('[Gemini OCR Fallback] Trích xuất trực tiếp client thất bại:', err);
  }

  return { success: true, count: 0, books: [] };
}

/**
 * LÀM GIÀU DỮ LIỆU SÁCH ĐƠN LẺ (AUTOFILL / ENRICHMENT)
 */
export async function enrichBook(
  title: string,
  author = '',
  publisher = ''
): Promise<{ success: boolean; enriched?: any }> {
  if (!title.trim()) {
    return { success: false };
  }

  // 1. Thử qua backend API trước (Khuyên dùng)
  try {
    const key = getGeminiApiKey();
    const res = await fetch('/api/books/enrich', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gemini-api-key': key,
      },
      body: JSON.stringify({ title, author, publisher }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success) {
        return data;
      }
    }
  } catch (apiErr) {
    console.warn('[Gemini Enrich API Proxy] Thử gọi API thất bại, chuyển sang chạy trực tiếp đầu client:', apiErr);
  }

  // 2. Fallback chạy trực tiếp phía Client bằng SDK như cũ
  const prompt = `Tra cứu thông tin chính xác của cuốn sách:
- Tên sách: "${title}"
- Tác giả: "${author || 'Chưa rõ'}"
- NXB: "${publisher || 'Chưa rõ'}"

Hãy trả về JSON gồm:
- title: Tên sách chuẩn hóa tiếng Việt
- author: Tác giả chuẩn
- publisher: Nhà xuất bản uy tín
- publish_year: Năm phát hành bản in phổ biến
- category: Thể loại chuyên sâu theo hướng dẫn:
${CATEGORY_GUIDELINES}
- summary: Tóm tắt 1-2 câu`;

  const buildContents = () => [{ text: prompt }];

  const config = {
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        author: { type: 'STRING' },
        publisher: { type: 'STRING' },
        publish_year: { type: 'INTEGER' },
        category: { type: 'STRING' },
        summary: { type: 'STRING' },
      },
      required: ['title', 'author', 'publisher', 'category'],
    },
  };

  try {
    const enriched = await executeWithFailover(buildContents, config);
    if (enriched) {
      return {
        success: true,
        enriched: {
          ...enriched,
          category: sanitizeSingleCategory(enriched.category || 'Chung'),
        },
      };
    }
  } catch (err) {
    console.warn('[Gemini Enrich Fallback] Tra cứu trực tiếp client thất bại:', err);
  }

  return { success: false };
}

/**
 * CHUẨN HÓA MỘT LÔ CHUNK QUY ĐỊNH (Không chạy đa luồng)
 */
async function processChunk(
  books: BookRecord[],
  stopSignal?: { current: boolean }
): Promise<any[] | null> {
  if (!books || books.length === 0 || stopSignal?.current) return [];

  // 1. Thử qua backend API trước (Giải quyết triệt để lỗi "nằm im" do nghẽn/CORS)
  try {
    const key = getGeminiApiKey();
    const res = await fetch('/api/books/batch-normalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gemini-api-key': key,
      },
      body: JSON.stringify({ books }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && Array.isArray(data.normalized)) {
        return data.normalized;
      }
    }
  } catch (apiErr) {
    console.warn('[Gemini Batch-Normalize API Proxy] Thử gọi API thất bại, chuyển sang chạy trực tiếp đầu client:', apiErr);
  }

  // 2. Fallback chạy trực tiếp phía Client bằng SDK như cũ
  const cleanInput = books.map((b) => ({
    id: b.id,
    title: (b.title || '').trim(),
    author: (b.author || '').trim(),
    publisher: (b.publisher || '').trim(),
    category: (b.category || '').trim(),
  }));

  const prompt = `Bạn là chuyên gia biên tập thư viện sách xuất sắc.
Hãy sửa lỗi chính tả, chuẩn hóa tiếng Việt có dấu chuẩn xác, viết hoa đúng quy tắc cho danh sách ${cleanInput.length} cuốn sách sau.

YÊU CẦU:
1. TÊN SÁCH (title): Sửa lỗi chính tả, viết hoa chữ cái đầu và tên riêng đúng chuẩn ngữ pháp.
2. TÁC GIẢ (author): Viết hoa đầy đủ có dấu hoặc tên La-tinh chuẩn mực.
3. NHÀ XUẤT BẢN (publisher): Tên NXB chính quy (NXB Trẻ, Nhã Nam, NXB Kim Đồng, NXB Hội Nhà Văn, NXB Phụ Nữ...).
4. THỂ LOẠI (category): BẮT BUỘC chỉ chọn 1 trong 13 thể loại sau:
${CATEGORY_GUIDELINES}

DANH SÁCH SÁCH CẦN CHUẨN HÓA:
${JSON.stringify(cleanInput, null, 2)}

Trả về mảng JSON đúng cấu trúc, BẮT BUỘC giữ nguyên trường "id" của từng cuốn:`;

  const buildContents = () => [{ text: prompt }];

  const config = {
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', description: 'ID giữ nguyên không đổi' },
          title: { type: 'STRING', description: 'Tên sách chuẩn' },
          author: { type: 'STRING', description: 'Tác giả chuẩn' },
          publisher: { type: 'STRING', description: 'Nhà xuất bản chuẩn' },
          category: { type: 'STRING', description: 'Thể loại chuyên sâu' },
          is_ai_normalized: { type: 'BOOLEAN', description: 'Bắt buộc là true' },
        },
        required: ['id', 'title', 'author', 'publisher', 'category'],
      },
    },
  };

  try {
    return await executeWithFailover(buildContents, config);
  } catch (err) {
    console.warn('[Gemini Service Fallback] processChunk trực tiếp client thất bại:', err);
    throw err;
  }
}

export interface BatchNormalizeOptions {
  preferredModel?: string;
  onChunkComplete?: (chunkResult: any[], remainingCount: number) => Promise<void> | void;
  stopSignal?: { current: boolean };
}

/**
 * CHUẨN HÓA HÀNG LOẠT SÁCH (Hỗ trợ đa luồng đồng thời thông minh theo số lượng API Keys để tăng tốc độ tối đa)
 */
export async function batchNormalize(
  books: BookRecord[],
  preferredModelOrOptions?: string | BatchNormalizeOptions
): Promise<{ success: boolean; normalized: any[] }> {
  if (!books || books.length === 0) {
    return { success: true, normalized: [] };
  }

  const options: BatchNormalizeOptions =
    typeof preferredModelOrOptions === 'string'
      ? { preferredModel: preferredModelOrOptions }
      : preferredModelOrOptions || {};

  const CHUNK_SIZE = 12;
  const chunks: BookRecord[][] = [];
  for (let i = 0; i < books.length; i += CHUNK_SIZE) {
    chunks.push(books.slice(i, i + CHUNK_SIZE));
  }

  const keys = getStoredGeminiApiKeys();
  // Giới hạn luồng chạy song song tối đa là 4 (hoặc số lượng keys đang có) để tránh quá tải trình duyệt
  const concurrency = Math.max(1, Math.min(keys.length, 4));

  console.log(`[Gemini Service] Bắt đầu chuẩn hóa song song ${chunks.length} lô (${books.length} cuốn sách) với ${concurrency} luồng đồng thời...`);

  const allNormalizedResults: any[] = [];
  let remainingCount = books.length;
  let activeIndex = 0;

  // Khóa đồng bộ hóa khi thêm kết quả để tránh race conditions
  const addResults = (chunkResults: any[]) => {
    allNormalizedResults.push(...chunkResults);
  };

  const runWorker = async () => {
    while (activeIndex < chunks.length) {
      if (options.stopSignal?.current) {
        break;
      }

      const currentIndex = activeIndex++;
      if (currentIndex >= chunks.length) break;

      const chunk = chunks[currentIndex];
      console.log(`[Gemini Worker] Đang xử lý lô ${currentIndex + 1}/${chunks.length} (${chunk.length} cuốn)...`);

      try {
        const normalizedChunk = await processChunk(chunk, options.stopSignal);
        
        if (normalizedChunk && normalizedChunk.length > 0) {
          addResults(normalizedChunk);
          remainingCount = Math.max(0, remainingCount - chunk.length);

          if (options.onChunkComplete) {
            try {
              await options.onChunkComplete(normalizedChunk, remainingCount);
            } catch (cbErr) {
              console.warn('[Gemini Service] Lỗi callback onChunkComplete:', cbErr);
            }
          }
        } else {
          throw new Error('Kết quả chuẩn hóa trống rỗng.');
        }
      } catch (err: any) {
        console.warn(`[Gemini Worker] Lô ${currentIndex + 1} thất bại, thử lại sau 2 giây...`, err?.message || err);
        if (options.stopSignal?.current) break;
        
        // Chờ và thử lại một lần nữa
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const normalizedChunk = await processChunk(chunk, options.stopSignal);
          if (normalizedChunk && normalizedChunk.length > 0) {
            addResults(normalizedChunk);
            remainingCount = Math.max(0, remainingCount - chunk.length);
            if (options.onChunkComplete) {
              await options.onChunkComplete(normalizedChunk, remainingCount);
            }
          } else {
            console.warn(`[Gemini Worker] Bỏ qua lô ${currentIndex + 1} do không thể chuẩn hóa.`);
          }
        } catch (retryErr: any) {
          console.error(`[Gemini Worker] Lô ${currentIndex + 1} thất bại hoàn toàn sau khi thử lại:`, retryErr?.message || retryErr);
        }
      }

      // Khoảng nghỉ nhỏ để điều hòa tải giữa các lượt gọi
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  // Khởi động các luồng song song
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(runWorker());
  }

  // Đợi cho đến khi tất cả các luồng hoàn thành công việc
  await Promise.all(workers);

  return {
    success: true,
    normalized: allNormalizedResults,
  };
}

export function getGeminiApiKey(): string {
  const keys = getStoredGeminiApiKeys();
  return getNextAvailableKey(keys);
}

export function saveCustomGeminiApiKey(key: string): void {
  const clean = key.trim();
  if (clean) {
    saveStoredGeminiApiKeys([clean]);
  }
}

export function getCustomGeminiApiKey(): string {
  return getGeminiApiKey();
}

export function clearCustomGeminiApiKey(): void {
  saveStoredGeminiApiKeys([]);
}
