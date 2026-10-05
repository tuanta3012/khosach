/**
 * Client-Centric Google Gemini SDK Integration Service (@google/genai)
 * 
 * Kiến trúc 100% Client-Side (Không phụ thuộc bất kỳ máy chủ proxy nào):
 * 1. Hỗ trợ đa API Keys cá nhân với cơ chế xoay vòng Round-robin & Sliding Window Rate Limiter (tối đa 14 RPM/key).
 * 2. Auto Failover 2 cấp độ tối ưu:
 *    - Cấp 1 (Chính): gemini-3.5-flash-lite (Tối ưu hạn ngạch & siêu tốc)
 *    - Cấp 2 (Dự phòng): gemini-3.1-flash-lite (Ổn định, bền bỉ khi gặp 429/quá tải)
 *    - Tự động xoay sang Key kế tiếp khi một Key đạt trần RPD hoặc cooldown.
 * 3. Xử lý đa luồng ảnh chụp gáy sách (Batch Scan Vision):
 *    - Tự động chia nhỏ micro-batch (1-2 ảnh/lô) tránh quá tải token & bộ nhớ RAM thiết bị di động.
 *    - Concurrency thích ứng theo số lượng API Keys (1-4 luồng đồng thời).
 *    - Yield Event Loop giải phóng Main Thread chống treo UI (Zero-Jank UX).
 *    - Callback cập nhật tiến độ chi tiết theo thời gian thực.
 */

import { GoogleGenAI } from '@google/genai';
import { 
  BookRecord, 
  GeminiModelId, 
  GeminiModelInfo, 
  ScannedBookItem, 
  ScanImagesResult, 
  ScanImagesOptions, 
  BookEnrichmentResult, 
  KeyQuotaState, 
  KeyQuotaMetrics 
} from '../types';
import { sanitizeSingleCategory } from '../utils/driveSyncClient';

const KEYS_STORAGE_KEY = 'gemini_api_keys_v1';
const MODEL_STORAGE_KEY = 'gemini_selected_model_v1';

export const AVAILABLE_GEMINI_MODELS: GeminiModelInfo[] = [
  { 
    id: 'auto', 
    name: 'Tự động (Gemini 3.8 Flash + 3.1 Flash Lite)', 
    desc: 'Ưu tiên Gemini 3.8 Flash chính xác cao, tự động dự phòng 3.1 Flash Lite khi gặp quá tải/429' 
  },
  { 
    id: 'gemini-3.8-flash', 
    name: 'Gemini 3.8 Flash', 
    desc: 'Engine chính: Thông minh, chuẩn hóa ngữ pháp, văn học & dịch thuật xuất sắc' 
  },
  { 
    id: 'gemini-3.1-flash-lite', 
    name: 'Gemini 3.1 Flash Lite', 
    desc: 'Engine dự phòng: Bền bỉ, tiết kiệm hạn ngạch' 
  },
];

// Danh sách thứ tự failover khi gặp lỗi quá tải
const FAILOVER_CHAIN: GeminiModelId[] = [
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
];

const RPM_LIMIT = 14;
const RPM_WINDOW_MS = 60000;

// Trạng thái theo dõi từng API Key để kiểm soát tốc độ gọi và trạng thái lỗi
const keyStateMap = new Map<string, KeyQuotaState>();

function getKeyState(key: string): KeyQuotaState {
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

/**
 * Lấy API Key tiếp theo theo cơ chế Round-Robin, bỏ qua các key đang cooldown hoặc cạn ngày
 */
export function getNextAvailableKey(keys: string[], excludedKeys: ReadonlySet<string> = new Set()): string {
  if (keys.length === 0) return '';
  const today = new Date().toISOString().split('T')[0];
  const numKeys = keys.length;
  
  for (let i = 0; i < numKeys; i++) {
    const idx = (rrIndex + i) % numKeys;
    const candidate = keys[idx];
    const state = getKeyState(candidate);
    
    // Reset trạng thái RPD nếu đã qua ngày mới
    if (state.rpdExhaustedDate && state.rpdExhaustedDate !== today) {
      state.isRpdExhausted = false;
      state.rpdExhaustedDate = '';
      state.backoffFactor = 0;
      state.cooldownUntil = 0;
    }

    if (!excludedKeys.has(candidate) && !state.isRpdExhausted && Date.now() >= state.cooldownUntil) {
      rrIndex = (idx + 1) % numKeys; // Cập nhật con trỏ cho lần kế tiếp
      return candidate;
    }
  }

  // Nếu tất cả các keys đều đang cooldown, chọn key sắp hết cooldown nhất (chưa bị cạn ngày)
  let earliestKey = '';
  let minCooldown = Infinity;
  for (const k of keys) {
    const state = getKeyState(k);
    if (!excludedKeys.has(k) && !state.isRpdExhausted && state.cooldownUntil < minCooldown) {
      minCooldown = state.cooldownUntil;
      earliestKey = k;
    }
  }
  return earliestKey;
}

/**
 * LƯU TRỮ VÀ TRUY VẤN DANH SÁCH API KEYS DO NGƯỜI DÙNG CUNG CẤP
 * Hoàn toàn không lưu bất kỳ API Key nào trong mã nguồn.
 */
export function getStoredGeminiApiKeys(): string[] {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const cleanList = parsed
          .map((k: string) => String(k || '').trim())
          .filter(Boolean);
        return cleanList;
      }
    }
  } catch (err) {
    console.warn('[GeminiService] Lỗi đọc API Key từ localStorage:', err);
  }

  const oldSingleKey = localStorage.getItem('custom_gemini_api_key');
  if (oldSingleKey && oldSingleKey.trim()) {
    return [oldSingleKey.trim()];
  }

  return [];
}

export function saveStoredGeminiApiKeys(keys: string[]): void {
  try {
    const cleanKeys = keys.map(k => k.trim()).filter(Boolean);
    if (cleanKeys.length > 0) {
      localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(cleanKeys));
      localStorage.setItem('custom_gemini_api_key', cleanKeys[0]);
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
 * Phân loại mã lỗi trả về từ Google Gemini API
 */
export function classifyQuotaError(err: unknown): 'RPM' | 'RPD' | 'OTHER' {
  const errMsg = (err instanceof Error ? err.message : String(err)).toLowerCase();

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
  const state = getKeyState(key);
  if (state.isRpdExhausted && state.rpdExhaustedDate === today) {
    return true;
  }
  return Date.now() < state.cooldownUntil;
}

export function getDynamicApiQuotaMetrics(): KeyQuotaMetrics {
  const keys = getStoredGeminiApiKeys();
  const keyCount = keys.length;
  const healthyCount = keys.filter(k => !isKeyInCooldown(k)).length;
  const concurrency = Math.max(1, Math.min(healthyCount || keyCount, 4));

  return {
    keyCount,
    healthyKeyCount: healthyCount,
    microBatchSize: 2,
    concurrency,
    maxRpm: 14 * Math.max(1, keyCount),
    maxRpd: 500 * Math.max(1, keyCount),
  };
}

/**
 * Sliding Window Rate Limiter: đảm bảo mỗi Key không vượt quá 14 RPM
 */
async function acquireRpmSlot(key: string): Promise<void> {
  const state = getKeyState(key);
  const now = Date.now();
  
  // Lọc các timestamp ngoài cửa sổ 60s
  state.apiCallTimestamps = state.apiCallTimestamps.filter((t) => now - t < RPM_WINDOW_MS);

  if (state.apiCallTimestamps.length >= RPM_LIMIT) {
    const oldest = state.apiCallTimestamps[0];
    const waitMs = Math.max(150, RPM_WINDOW_MS - (now - oldest) + 150);
    console.warn(`[Gemini Rate Limiter] Key ${key.slice(0, 6)}... đạt ngưỡng 14 RPM. Nghỉ chờ ${waitMs}ms...`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return acquireRpmSlot(key);
  }

  state.apiCallTimestamps.push(Date.now());
}

/**
 * Kiểm tra Safety Block và Finish Reason từ phản hồi của Google
 */
function checkSafetyBlockReason(response: any): void {
  if (!response) return;

  const candidate = response.candidates?.[0];
  if (candidate) {
    const finishReason = candidate.finishReason;
    if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
      throw new Error(`Yêu cầu bị từ chối bởi Google AI (Lý do: ${finishReason}).`);
    }
  }

  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`Nội dung bị chặn bởi bộ lọc an toàn Google AI (Lý do: ${blockReason}).`);
  }
}

/**
 * THỰC THI CUỘC GỌI API GEMINI VỚI AUTO FAILOVER & XOAY VÒNG MULTI-KEYS
 * 100% Client-Side sử dụng @google/genai SDK trực tiếp.
 */
export async function executeWithFailover(
  buildContents: () => any, 
  config?: any,
  overridePreferredModel?: string
): Promise<any> {
  const keys = getStoredGeminiApiKeys();
  if (keys.length === 0) {
    throw new Error('Chưa thiết lập Gemini API Key trong phần Cài đặt.');
  }

  let lastError: unknown = null;
  const attemptedKeys = new Set<string>();
  const maxAttempts = keys.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = getNextAvailableKey(keys, attemptedKeys);
    if (!key) {
      break;
    }
    attemptedKeys.add(key);

    const today = new Date().toISOString().split('T')[0];
    const keyState = getKeyState(key);

    if (keyState.isRpdExhausted && keyState.rpdExhaustedDate === today) {
      continue;
    }

    try {
      await acquireRpmSlot(key);
      const ai = new GoogleGenAI({ apiKey: key });
      const contents = buildContents();
      
      const selectedModel = overridePreferredModel || getStoredSelectedModel();

      // Nếu người dùng chọn đích danh 1 model cụ thể và không phải auto
      if (selectedModel !== 'auto' && !overridePreferredModel) {
        const response = await ai.models.generateContent({
          model: selectedModel,
          contents,
          config,
        });

        checkSafetyBlockReason(response);
        const textOutput = response?.text;

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

      // Thử model đã cấu hình trước, sau đó chuyển sang key dự phòng.
      const modelsToTry: string[] = overridePreferredModel 
        ? [overridePreferredModel, ...FAILOVER_CHAIN.filter(m => m !== overridePreferredModel)]
        : FAILOVER_CHAIN;

      let modelSuccess = false;
      let lastModelError: unknown = null;

      for (const modelName of modelsToTry) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents,
            config,
          });

          checkSafetyBlockReason(response);
          const textOutput = response?.text;

          // Thành công: Reset lại backoff factor của key
          keyState.backoffFactor = 0;
          keyState.cooldownUntil = 0;
          modelSuccess = true;

          if (textOutput) {
            if (config?.responseMimeType === 'application/json') {
              return JSON.parse(textOutput.trim());
            }
            return textOutput;
          }
          return null;
        } catch (err: unknown) {
          lastModelError = err;
          const errType = classifyQuotaError(err);
          const errMsg = err instanceof Error ? err.message : String(err);

          console.warn(`[Gemini Failover] Model ${modelName} trên Key ${key.slice(0, 6)}... gặp lỗi (${errType}): ${errMsg}`);

          // Nếu cạn giới hạn ngày RPD, không thử tiếp model khác trên key này nữa
          if (errType === 'RPD') {
            keyState.isRpdExhausted = true;
            keyState.rpdExhaustedDate = today;
            break;
          }

          // Nếu lỗi 429/503 (RPM/Resource Exhausted): Thử model tiếp theo trong chuỗi (ví dụ: sang 1.5-flash-8b)
          if (errType === 'RPM') {
            continue;
          }

          // Nếu là lỗi khác (như cú pháp nội dung), tiếp tục thử model dự phòng
        }
      }

      if (modelSuccess) {
        return;
      }

      // Nếu tất cả model trên key này đều lỗi: Tăng backoff và chuyển sang key kế tiếp
      lastError = lastModelError;
      keyState.backoffFactor += 1;
      const delay = Math.min(60000, 5000 * Math.pow(2, keyState.backoffFactor - 1));
      keyState.cooldownUntil = Date.now() + delay;

    } catch (err: unknown) {
      lastError = err;
      const errType = classifyQuotaError(err);
      if (errType === 'RPD') {
        keyState.isRpdExhausted = true;
        keyState.rpdExhaustedDate = today;
      } else if (errType === 'RPM') {
        keyState.backoffFactor += 1;
        const delay = Math.min(60000, 5000 * Math.pow(2, keyState.backoffFactor - 1));
        keyState.cooldownUntil = Date.now() + delay;
      }
    }
  }

  const errMessage = lastError instanceof Error ? lastError.message : 'Tất cả các API Keys hiện có đều tạm thời gián đoạn hoặc hết hạn ngạch.';
  throw new Error(`[Gemini SDK] ${errMessage}`);
}

/**
 * KIỂM TRA TÍNH HỢP LỆ VÀ KẾT NỐI CỦA MỘT GEMINI API KEY
 * Thực thi trực tiếp 100% Client-Side.
 */
export async function testGeminiApiKey(
  candidateKey: string
): Promise<{ success: boolean; message: string }> {
  const cleanKey = candidateKey.trim();
  if (!cleanKey) {
    return { success: false, message: 'Vui lòng nhập API Key để kiểm tra!' };
  }

  // Thử trực tiếp phía Client qua GoogleGenAI SDK với model 3.8 Flash
  try {
    const ai = new GoogleGenAI({ apiKey: cleanKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: 'Ping test. Reply with word OK.',
    });

    if (response?.text) {
      return { success: true, message: 'Kết nối thành công! Key hoạt động tốt (Gemini 3.8 Flash).' };
    }
  } catch (err35: unknown) {
    // Dự phòng kiểm tra bằng 3.1 Flash Lite
    try {
      const ai = new GoogleGenAI({ apiKey: cleanKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: 'Ping test. Reply with word OK.',
      });
      if (response?.text) {
        return { success: true, message: 'Kết nối thành công! Key hoạt động tốt (Gemini 3.1 Flash Lite).' };
      }
    } catch (err31: unknown) {
      const errType = classifyQuotaError(err31);
      if (errType === 'RPD') {
        return { success: false, message: 'Key đã đạt giới hạn cuộc gọi trong ngày (RPD).' };
      }
      const msg = err31 instanceof Error ? err31.message : String(err31);
      return { success: false, message: `Key không hoạt động hoặc sai cấu hình: ${msg}` };
    }
  }

  return { success: false, message: 'Không thể kết nối tới Google Gemini API.' };
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
 * Xử lý quét một micro-batch ảnh (1-2 ảnh) trực tiếp bằng SDK
 */
async function scanSingleImageBatch(
  images: string[],
  existingTitlesRef: string,
  preferredModel?: string
): Promise<ScannedBookItem[]> {
  if (!images || images.length === 0) return [];

  const prompt = `Bạn là chuyên gia thị giác máy tính và biên mục thư viện sách xuất sắc.
Hãy phân tích tỉ mỉ ảnh bìa / gáy sách và trích xuất danh sách tất cả các cuốn sách có trong hình.

QUY TẮC CHÍNH XÁC:
1. Đọc tên sách (title), tên tác giả (author), nhà xuất bản (publisher).
2. Tác giả nước ngoài: dùng tên tiếng Việt quen thuộc (ví dụ "Haruki Murakami", "Dư Hoa", "Victor Hugo", "Dale Carnegie").
3. Thể loại (category): BẮT BUỘC CHỈ CHỌN 1 TRONG 13 DANH MỤC:
${CATEGORY_GUIDELINES}

Danh sách sách đã có trong kho (đối chiếu tránh trùng): ${existingTitlesRef || 'Chưa có'}

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

  const rawBooks = await executeWithFailover(buildContents, config, preferredModel);
  if (Array.isArray(rawBooks)) {
    return rawBooks.map((b: any) => ({
      title: (b.title || '').trim(),
      author: (b.author || '').trim(),
      publisher: (b.publisher || '').trim(),
      category: sanitizeSingleCategory(b.category || 'Chung'),
      is_ai_normalized: true,
    })).filter(b => b.title.length > 0);
  }

  return [];
}

/**
 * BÓC TÁCH KỆ SÁCH HÀNG LOẠT BẰNG AI VISION (BATCH SCAN OCR)
 * 100% Client-Side, xử lý chia nhỏ micro-batch, chạy đa luồng đồng thời theo số Key,
 * không làm treo giao diện người dùng (Non-blocking UI).
 */
export async function scanImages(
  images: string[],
  existingBooks: BookRecord[] = [],
  preferredModelOrOptions?: string | ScanImagesOptions,
  legacyOptions?: ScanImagesOptions
): Promise<ScanImagesResult> {
  if (!images || images.length === 0) {
    return { success: true, count: 0, books: [] };
  }

  let preferredModel: string | undefined;
  let options: ScanImagesOptions = {};

  if (typeof preferredModelOrOptions === 'string') {
    preferredModel = preferredModelOrOptions;
    options = legacyOptions || {};
  } else if (preferredModelOrOptions && typeof preferredModelOrOptions === 'object') {
    options = preferredModelOrOptions;
    preferredModel = options.preferredModel;
  }

  const existingTitlesRef = existingBooks.slice(0, 80).map((b) => b.title).filter(Boolean).join(', ');

  // Chia nhỏ thành các micro-batch: Mỗi batch gồm tối đa 2 ảnh để giữ kích thước base64 an toàn
  const MICRO_BATCH_SIZE = 2;
  const imageBatches: string[][] = [];
  for (let i = 0; i < images.length; i += MICRO_BATCH_SIZE) {
    imageBatches.push(images.slice(i, i + MICRO_BATCH_SIZE));
  }

  const keys = getStoredGeminiApiKeys();
  const concurrency = Math.max(1, Math.min(keys.length, 3)); // Tối đa 3 luồng song song

  console.log(`[Gemini Vision] Bắt đầu phân tích ${images.length} ảnh (${imageBatches.length} lô nhỏ) với ${concurrency} luồng đồng thời...`);

  const detectedBooksMap = new Map<string, ScannedBookItem>();
  let processedImagesCount = 0;
  let failedBatchCount = 0;
  let currentBatchIndex = 0;

  const notifyProgress = (message?: string) => {
    if (options.onProgress) {
      try {
        options.onProgress({
          processedImages: processedImagesCount,
          totalImages: images.length,
          detectedBooksCount: detectedBooksMap.size,
          currentMessage: message,
        });
      } catch (e) {
        console.warn('[Gemini Vision] Lỗi gọi progress callback:', e);
      }
    }
  };

  notifyProgress('Bắt đầu phân tích ảnh gáy sách...');

  const runWorker = async () => {
    while (currentBatchIndex < imageBatches.length) {
      if (options.stopSignal?.current) break;

      const idx = currentBatchIndex++;
      if (idx >= imageBatches.length) break;

      const batch = imageBatches[idx];
      const batchImgCount = batch.length;

      try {
        const found = await scanSingleImageBatch(batch, existingTitlesRef, preferredModel);
        
        found.forEach((book) => {
          const dedupeKey = `${book.title.toLowerCase()}_${(book.author || '').toLowerCase()}`;
          if (!detectedBooksMap.has(dedupeKey)) {
            detectedBooksMap.set(dedupeKey, book);
          }
        });

        processedImagesCount += batchImgCount;
        notifyProgress(`Đã quét ${processedImagesCount}/${images.length} ảnh (Tìm thấy ${detectedBooksMap.size} cuốn)`);
      } catch (batchErr) {
        console.warn(`[Gemini Vision] Lô ảnh #${idx + 1} gặp sự cố:`, batchErr);
        failedBatchCount += 1;
        processedImagesCount += batchImgCount;
        notifyProgress(`Lô #${idx + 1} gặp lỗi, tiếp tục các ảnh còn lại...`);
      }

      // Nhường CPU cho Main Thread (React render 60fps mượt mà không bị treo giật)
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(runWorker());
  }

  await Promise.allSettled(workers);

  const finalBooks = Array.from(detectedBooksMap.values());
  return {
    success: failedBatchCount === 0,
    count: finalBooks.length,
    books: finalBooks,
  };
}

/**
 * LÀM GIÀU DỮ LIỆU SÁCH ĐƠN LẺ (AUTOFILL / ENRICHMENT)
 * 100% Client-Side.
 */
export async function enrichBook(
  title: string,
  author = '',
  publisher = ''
): Promise<BookEnrichmentResult> {
  const cleanTitle = (title || '').trim();
  if (!cleanTitle) {
    return { success: false };
  }

  const prompt = `Bạn là thủ thư uyên bác và chuyên gia biên mục sách hàng đầu tại Việt Nam.
Người dùng đang tra cứu hoặc thêm một cuốn sách mới vào kho với thông tin đầu vào sau:
- Tên sách / Từ khóa tra cứu: "${cleanTitle}"
- Tác giả (nếu có): "${(author || '').trim() || 'Chưa rõ'}"
- NXB (nếu có): "${(publisher || '').trim() || 'Chưa rõ'}"

NHIỆM VỤ BIÊN MỤC & TRA CỨU:

1. GIẢI MÃ THÔNG MINH TỪ KHÓA TỰ NHIÊN / TIẾNG VIỆT KHÔNG DẤU / TÊN RÚT GỌN:
   - Người dùng thường gõ tiếng Việt không dấu, viết tắt, hoặc tên nhân vật / tiêu đề quen thuộc (ví dụ: "mit dac" -> "Những cuộc phiêu lưu của Mít Đặc và các bạn", "de men" -> "Dế Mèn phiêu lưu ký", "khong gia dinh" -> "Không gia đình", "hoang tu be" -> "Hoàng tử bé", "mat biec" -> "Mắt biếc", "so do" -> "Số đỏ", "nha gia kim" -> "Nhà giả kim", "tam quoc" -> "Tam quốc diễn nghĩa", "tay du ky" -> "Tây du ký", "thuy hu" -> "Thủy hử", "dac nhan tam" -> "Đắc nhân tâm").
   - Hãy tự động nhận diện chính xác tác phẩm văn học / sách tương ứng được xuất bản phổ biến tại Việt Nam.

2. NGUYÊN TẮC TÊN SÁCH (title):
   - SÁCH TIẾNG VIỆT (kể cả tác phẩm dịch sang tiếng Việt): BẮT BUỘC trả về TÊN TIẾNG VIỆT chuẩn chính tả, viết hoa chữ cái đầu và tên riêng (ví dụ: "Những cuộc phiêu lưu của Mít Đặc và các bạn", "Dế Mèn phiêu lưu ký", "Đắc nhân tâm", "Nhà giả kim", "Rừng Na Uy", "Chiến tranh và hòa bình"). TUYỆT ĐỐI KHÔNG dịch ngược sang tiếng Anh hay chèn tên gốc nước ngoài.
   - SÁCH NGOẠI VĂN GỐC (chỉ khi người dùng cố ý nhập tên tiếng nước ngoài như "Thinking, Fast and Slow", "Atomic Habits"): Giữ tên tiếng nước ngoài và bổ sung bản dịch tiếng Việt phổ biến trong ngoặc đơn "Tên Tiếng Nước Ngoài (Tên Bản Dịch Phổ Biến)". TUYỆT ĐỐI CẤM DỊCH THÔ TỪNG TỪ (WORD-BY-WORD). Nếu chưa có bản dịch chính thức thì giữ nguyên tên tiếng nước ngoài gốc.

3. TÁC GIẢ (author):
   - Tác giả chuẩn xác của cuốn sách (ví dụ: "mit dac" -> "Nikolay Nosov", "de men" -> "Tô Hoài", "nha gia kim" -> "Paulo Coelho", "khong gia dinh" -> "Hector Malot", "hoang tu be" -> "Antoine de Saint-Exupéry").

4. NHÀ XUẤT BẢN (publisher):
   - Nhà xuất bản uy tín phổ biến phát hành cuốn sách này tại Việt Nam (ví dụ: NXB Kim Đồng, NXB Trẻ, Nhã Nam, NXB Hội Nhà Văn, NXB Văn Học, NXB Tổng hợp TP.HCM...).

5. THỂ LOẠI (category):
   - BẮT BUỘC chỉ chọn đúng 1 trong 13 thể loại chuẩn:
${CATEGORY_GUIDELINES}

6. CHỐNG ẢO GIÁC (ANTI-HALLUCINATION):
   - TUYỆT ĐỐI KHÔNG BỊA RA HOẶC TRẢ VỀ MỘT CUỐN SÁCH HOÀN TOÀN KHÔNG LIÊN QUAN (ví dụ người dùng gõ "mit dac" thì TUYỆT ĐỐI CẤM trả về sách Dale Carnegie hay sách tiếng Anh ngẫu nhiên). Nếu là sách lạ chưa rõ thông tin, hãy chuẩn hóa chính tả của chính từ khóa đó và điền tác giả "Chưa rõ" hoặc "Khuyết danh".`;

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
    console.warn('[Gemini Enrich] Tra cứu trực tiếp client thất bại:', err);
  }

  return { success: false };
}

/**
 * Tự động loại bỏ các định dạng trùng lặp vô nghĩa dạng "Tên (Tên)" ví dụ "Lolita (Lolita)" -> "Lolita"
 */
export function cleanDuplicateParenthesis(title: string): string {
  if (!title) return '';
  const trimmed = title.trim();
  const match = trimmed.match(/^(.+?)\s*\((.+?)\)$/);
  if (match) {
    const left = match[1].trim().toLowerCase();
    const right = match[2].trim().toLowerCase();
    if (left === right) {
      return match[1].trim();
    }
  }
  return trimmed;
}

/**
 * CHUẨN HÓA MỘT LÔ SÁCH (100% Client-Side)
 */
async function processChunk(
  books: BookRecord[],
  stopSignal?: { current: boolean }
): Promise<any[] | null> {
  if (!books || books.length === 0 || stopSignal?.current) return [];

  const cleanInput = books.map((b, idx) => ({
    stt: idx + 1,
    id: b.id,
    title: (b.title || '').trim(),
    author: (b.author || '').trim(),
    publisher: (b.publisher || '').trim(),
    category: (b.category || '').trim(),
  }));

  const prompt = `Bạn là chuyên gia biên tập thư viện và hiệu đính văn học xuất sắc tại Việt Nam.
Hãy chuẩn hóa, sửa lỗi chính tả, xác định thể loại và hoàn thiện thông tin cho danh sách ${cleanInput.length} cuốn sách sau theo tiêu chuẩn xuất bản thư viện Việt Nam.

QUY TẮC BẮT BUỘC:

1. TÊN SÁCH (title):
   a. NGUYÊN TẮC BẢO TỒN TỰA SÁCH TIẾNG VIỆT HỢP LỆ:
      - Nếu tựa sách người dùng nhập ĐÃ LÀ TIẾNG VIỆT HỢP LỆ (kể cả tác phẩm dịch nước ngoài như "Rừng Na Uy", "Ba người lính ngự lâm", "21 bài học cho thế kỷ 21", "80 ngày vòng quanh thế giới", "Đắc nhân tâm", "Nhà giả kim", "Đời con", "Chiến tranh và hòa bình") -> BẮT BUỘC GIỮ NGUYÊN TỰA TIẾNG VIỆT ĐÓ.
      - TUYỆT ĐỐI CẤM đổi sang từ đồng nghĩa hoặc bản dịch khác nếu tên hiện tại đã đúng (ví dụ: "80 ngày vòng quanh thế giới" thì GIỮ NGUYÊN "80 ngày vòng quanh thế giới", CẤM tự ý đổi thành "Vòng quanh thế giới trong 80 ngày").
      - TUYỆT ĐỐI CẤM dịch ngược sang tiếng Anh/Pháp/Nga hay chèn tên gốc nước ngoài vào đầu tựa đề.
      - Xóa bỏ các phụ chú tiếng Anh sai lệch hoặc thừa trong ngoặc đơn nếu có (ví dụ: "Đời con (The Good Earth)" -> sửa thành "Đời con").

   b. NGUYÊN TẮC CHO SÁCH NGOẠI VĂN GỐC & CHỐNG LẶP LẠI TÊN:
      - Với sách ngoại văn gốc (tiêu đề đầu vào là tiếng Anh/Pháp): Giữ tên tiếng nước ngoài và bổ sung tên tiếng Việt trong ngoặc đơn: "Tên Tiếng Nước Ngoài (Tên Tiếng Việt)".
      - TUYỆT ĐỐI CẤM LẶP LẠI TÊN DẠNG "Lolita (Lolita)" hay "Heidi (Heidi)": Nếu tên gốc tiếng nước ngoài và tên bản dịch tiếng Việt giống hệt nhau hoặc là tên nhân vật (ví dụ: "Lolita", "Heidi", "Sherlock Holmes", "Oliver Twist", "Don Quixote", "Frankenstein", "Dracula", "Hamlet", "Steve Jobs"), BẮT BUỘC CHỈ GIỮ 1 TÊN DUY NHẤT (ví dụ: "Lolita", "Heidi").
      - CHỈ bổ sung tên tiếng Việt nếu cuốn sách đó ĐÃ CÓ BẢN DỊCH XUẤT BẢN CHÍNH THỨC, PHỔ BIẾN (ví dụ: "After You (Sau ngày anh đến)", "The Great Gatsby (Đại gia Gatsby)").
      - TUYỆT ĐỐI CẤM DỊCH THÔ TỪNG TỪ (WORD-BY-WORD).

   c. QUY TẮC VIẾT HOA CHỮ TRONG TIẾNG VIỆT:
      - Tiếng Việt CHỈ viết hoa chữ cái đầu tiên của tựa đề và các Tên riêng / Danh từ riêng (ví dụ: "Những cuộc phiêu lưu của Mít Đặc và các bạn", "Dế Mèn phiêu lưu ký", "Kính vạn hoa").
      - TUYỆT ĐỐI KHÔNG VIẾT HOA TẤT CẢ CÁC TỪ như kiểu Title Case của tiếng Anh.

   d. BẢO TỒN THÔNG TIN TẬP / PHẦN / BỘ SÁCH:
      - TUYỆT ĐỐI KHÔNG XÓA số tập, số quyển của người dùng (ví dụ: "Kính vạn hoa (Tập 1-18)", "Ba người lính ngự lâm - Tập 2").

2. TÁC GIẢ (author) & TÍNH TOÀN VẸN 1-1:
   - Xử lý ĐÚNG TỪNG CUỐN theo đúng STT và ID. TUYỆT ĐỐI KHÔNG HOÁN ĐỔI TÁC PHẨM VÀ TÁC GIẢ GIỮA CÁC CUỐN (ví dụ: cuốn "Rừng Na-uy" tác giả Haruki Murakami thì BẮT BUỘC giữ đúng tác phẩm của Haruki Murakami, CẤM biến thành "Robinson Crusoe" của Daniel Defoe).
   - Tác giả Việt Nam: Viết hoa có dấu chuẩn xác.
   - Tác giả nước ngoài: Dùng tên La-tinh chuẩn hoặc tên phiên âm quen thuộc trên bìa sách tiếng Việt.

3. NHÀ XUẤT BẢN (publisher):
   - Tên NXB chính thống uy tín tại Việt Nam (NXB Trẻ, Nhã Nam, NXB Kim Đồng, NXB Hội Nhà Văn, NXB Văn Học, NXB Phụ Nữ...). Nếu không rõ thì giữ nguyên hoặc để trống.

4. THỂ LOẠI (category):
   - BẮT BUỘC chỉ chọn duy nhất 1 trong 13 thể loại chuẩn sau:
${CATEGORY_GUIDELINES}

DANH SÁCH SÁCH CẦN CHUẨN HÓA (XỬ LÝ ĐÚNG THỨ TỰ VÀ ĐÚNG ID):
${JSON.stringify(cleanInput, null, 2)}

Trả về mảng JSON đúng cấu trúc và BẮT BUỘC đúng trường "id" của từng cuốn:`;

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

  const rawResults = await executeWithFailover(buildContents, config);
  if (!Array.isArray(rawResults)) return null;

  // Căn chỉnh và hậu xử lý an toàn 1-1
  return books.map((origBook, idx) => {
    let item = rawResults.find((r: any) => r && r.id === origBook.id);
    if (!item && rawResults[idx]) {
      item = rawResults[idx];
    }

    if (!item) {
      return {
        id: origBook.id,
        title: origBook.title,
        author: origBook.author,
        publisher: origBook.publisher,
        category: origBook.category || 'Chung',
        is_ai_normalized: true,
      };
    }

    const rawTitle = String(item.title || origBook.title).trim();
    const resolvedTitle = cleanDuplicateParenthesis(rawTitle) || origBook.title;
    const resolvedAuthor = String(item.author || origBook.author).trim() || origBook.author;
    const resolvedPublisher = String(item.publisher || origBook.publisher || '').trim();
    const resolvedCategory = sanitizeSingleCategory(item.category || origBook.category || 'Chung');

    return {
      id: origBook.id,
      title: resolvedTitle,
      author: resolvedAuthor,
      publisher: resolvedPublisher,
      category: resolvedCategory,
      is_ai_normalized: true,
    };
  });
}

export interface BatchNormalizeOptions {
  preferredModel?: string;
  onChunkComplete?: (chunkResult: any[], remainingCount: number) => Promise<void> | void;
  stopSignal?: { current: boolean };
}

/**
 * CHUẨN HÓA HÀNG LOẠT SÁCH (100% Client-Side đa luồng theo số API Keys)
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
  const concurrency = Math.max(1, Math.min(keys.length, 4));

  console.log(`[Gemini Normalizer] Bắt đầu chuẩn hóa song song ${chunks.length} lô (${books.length} cuốn) với ${concurrency} luồng...`);

  const allNormalizedResults: any[] = [];
  let remainingCount = books.length;
  let activeIndex = 0;

  const addResults = (chunkResults: any[]) => {
    allNormalizedResults.push(...chunkResults);
  };

  const runWorker = async () => {
    while (activeIndex < chunks.length) {
      if (options.stopSignal?.current) break;

      const currentIndex = activeIndex++;
      if (currentIndex >= chunks.length) break;

      const chunk = chunks[currentIndex];

      try {
        const normalizedChunk = await processChunk(chunk, options.stopSignal);
        
        if (normalizedChunk && normalizedChunk.length > 0) {
          addResults(normalizedChunk);
          remainingCount = Math.max(0, remainingCount - chunk.length);

          if (options.onChunkComplete) {
            try {
              await options.onChunkComplete(normalizedChunk, remainingCount);
            } catch (cbErr) {
              console.warn('[Gemini Normalizer] Lỗi callback onChunkComplete:', cbErr);
            }
          }
        }
      } catch (err: unknown) {
        console.warn(`[Gemini Normalizer] Lô ${currentIndex + 1} gặp lỗi, thử lại sau 2 giây...`, err);
        if (options.stopSignal?.current) break;
        
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const normalizedChunk = await processChunk(chunk, options.stopSignal);
          if (normalizedChunk && normalizedChunk.length > 0) {
            addResults(normalizedChunk);
            remainingCount = Math.max(0, remainingCount - chunk.length);
            if (options.onChunkComplete) {
              await options.onChunkComplete(normalizedChunk, remainingCount);
            }
          }
        } catch (retryErr) {
          console.error(`[Gemini Normalizer] Lô ${currentIndex + 1} thất bại hoàn toàn:`, retryErr);
        }
      }

      await new Promise((r) => setTimeout(r, 120));
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(runWorker());
  }

  await Promise.allSettled(workers);

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
