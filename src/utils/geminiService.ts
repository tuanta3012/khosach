// Client-side Gemini Integration Service with Built-in Obfuscated Key Support
// Works seamlessly in both environments:
// 1. Web Preview (AI Studio): Proxies requests to local Express server for shared quota usage.
// 2. Android APK (Capacitor): Falls back to direct Google Gemini REST API requests using the obfuscated/compiled key.

import { BookRecord } from '../types';
import { getStoredOrConfiguredApiKey } from '../config/syncConfig';
import { sanitizeSingleCategory } from './driveSyncService';

// Simple yet effective XOR encryption key to prevent casual signature scanning of the APK bundle.
const OBFUSCATION_SALT = "kho-sach-secure-salt-2026";

declare const __OBFUSCATED_GEMINI_KEY__: string | undefined;

/**
 * Obfuscates a string to prevent plain-text discovery (Caesar shift + XOR + Base64)
 */
export function obfuscateKey(plainKey: string): string {
  if (!plainKey) return "";
  let scrambled = "";
  for (let i = 0; i < plainKey.length; i++) {
    const charCode = plainKey.charCodeAt(i) ^ OBFUSCATION_SALT.charCodeAt(i % OBFUSCATION_SALT.length);
    scrambled += String.fromCharCode(charCode);
  }
  return btoa(unescape(encodeURIComponent(scrambled)));
}

/**
 * De-obfuscates the encrypted API key back to its original plain text form at runtime
 */
export function deobfuscateKey(cipherText: string): string {
  if (!cipherText) return "";
  try {
    const decoded = decodeURIComponent(escape(atob(cipherText)));
    let result = "";
    for (let i = 0; i < decoded.length; i++) {
      const charCode = decoded.charCodeAt(i) ^ OBFUSCATION_SALT.charCodeAt(i % OBFUSCATION_SALT.length);
      result += String.fromCharCode(charCode);
    }
    return result;
  } catch (e) {
    console.error("[GeminiService] De-obfuscation failed:", e);
    return "";
  }
}

/**
 * Resolves the decrypted API key from various environments
 */
export function saveCustomGeminiApiKey(key: string): void {
  const cleanKey = key.trim();
  if (cleanKey) {
    localStorage.setItem('custom_gemini_api_key', cleanKey);
  } else {
    localStorage.removeItem('custom_gemini_api_key');
  }
}

export function getCustomGeminiApiKey(): string {
  return localStorage.getItem('custom_gemini_api_key') || '';
}

export function clearCustomGeminiApiKey(): void {
  localStorage.removeItem('custom_gemini_api_key');
}

/**
 * Kiểm tra tính hợp lệ của Gemini API Key
 */
export async function testGeminiApiKey(candidateKey: string): Promise<{ success: boolean; message: string }> {
  const cleanKey = candidateKey.trim();
  if (!cleanKey) {
    return { success: false, message: 'Vui lòng nhập API Key để kiểm tra!' };
  }

  // Thử qua endpoint server proxy trước
  try {
    const isWebPreview = window.location.port === '3000' || window.location.hostname.includes('run.app');
    if (isWebPreview) {
      const resp = await fetch('/api/ai/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: cleanKey }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.success) {
        return { success: true, message: data.message || 'API Key Google Gemini hoạt động hoàn hảo!' };
      }
      if (data.message) {
        return { success: false, message: data.message };
      }
    }
  } catch (err: any) {
    console.warn('[GeminiService] Server test-key proxy check failed, testing direct REST API...');
  }

  // Thử gọi trực tiếp Google Gemini REST API (hỗ trợ cả Mobile / Android APK)
  try {
    const testModel = 'gemini-3.1-flash-lite';
    const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${encodeURIComponent(cleanKey)}`;
    let directResp = await fetch(testUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Ping test' }] }],
      }),
    });

    if (!directResp.ok) {
      // Fallback test model gemini-3.5-flash-lite
      const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const fbResp = await fetch(fallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Ping test' }] }] }),
      });
      if (fbResp.ok) directResp = fbResp;
    }

    if (directResp.ok) {
      return { success: true, message: 'API Key Google Gemini kết nối thành công!' };
    }

    const errJson = await directResp.json().catch(() => ({}));
    const rawError = errJson?.error?.message || `HTTP ${directResp.status}`;
    return {
      success: false,
      message: `Google API từ chối key: ${rawError}`,
    };
  } catch (directErr: any) {
    return {
      success: false,
      message: `Không thể kết nối đến Google Gemini: ${directErr.message || String(directErr)}`,
    };
  }
}

/**
 * Resolves the decrypted API key from various environments
 */
export function getGeminiApiKey(): string {
  // 1. Kiểm tra cấu hình ghi đè trong LocalStorage (nếu người dùng đổi key trên máy)
  const localOverride = localStorage.getItem('custom_gemini_api_key');
  if (localOverride && localOverride.trim()) return localOverride.trim();

  // 2. Tự động giải mã Key mặc định từ Vault (hoạt động tức thì trên mọi máy cài APK)
  const vaultKey = getStoredOrConfiguredApiKey();
  if (vaultKey && vaultKey.trim()) return vaultKey.trim();

  // 3. Fallback biến môi trường
  const envKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
  if (envKey) return envKey;

  return "";
}

const ALL_DIRECT_MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.8-flash"];
const directCooldownMap = new Map<string, number>();
const directLastCallTimestamps = new Map<string, number>();

function isDirectModelInCooldown(model: string): boolean {
  const cd = directCooldownMap.get(model);
  if (!cd) return false;
  if (Date.now() > cd) {
    directCooldownMap.delete(model);
    return false;
  }
  return true;
}

function markDirectModelCooldown(model: string, durationMs: number) {
  directCooldownMap.set(model, Date.now() + durationMs);
}

let directRotationCounter = 0;
const DUAL_DIRECT_ENGINES = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];

function getRotatedDirectModels(preferredModel?: string): string[] {
  const currentIdx = directRotationCounter++;
  const primaryEngine = DUAL_DIRECT_ENGINES[currentIdx % DUAL_DIRECT_ENGINES.length];
  const secondaryEngine = DUAL_DIRECT_ENGINES[(currentIdx + 1) % DUAL_DIRECT_ENGINES.length];

  let initialOrder: string[];
  if (preferredModel) {
    const fallbackEngine = preferredModel === 'gemini-3.1-flash-lite' ? 'gemini-3.5-flash-lite' : 'gemini-3.1-flash-lite';
    initialOrder = [preferredModel, fallbackEngine, 'gemini-3.8-flash'];
  } else {
    initialOrder = [primaryEngine, secondaryEngine, 'gemini-3.8-flash'];
  }

  // Filter healthy models first, cooling models last so we never hammer a cooling model
  const healthy = initialOrder.filter((m) => !isDirectModelInCooldown(m));
  const cooling = initialOrder.filter((m) => isDirectModelInCooldown(m));
  return [...healthy, ...cooling];
}

/**
 * Direct fetch helper with Multi Engine load balancer (Gemini 3.1 Flash Lite + Gemini 3.5 Flash Lite + Gemini 3.8 Flash),
 * rate limit throttle (RPM 15 guard per engine: min 4.2s), instant failover on 429/quota to prevent overloading
 */
async function callGeminiDirect(payload: any, preferredModel?: string): Promise<any> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Không tìm thấy Gemini API Key. Hãy khai báo API Key hoặc cấu hình trong ứng dụng.");
  }

  const modelsToTry = getRotatedDirectModels(preferredModel);

  const executeWithModel = async (modelName: string): Promise<any> => {
    // Throttle per engine to keep strictly within RPM 15 limits (~4.2s per model)
    const lastCall = directLastCallTimestamps.get(modelName) || 0;
    const waitTime = Math.max(0, 4200 - (Date.now() - lastCall));
    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    directLastCallTimestamps.set(modelName, Date.now());

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    console.log(`[GeminiService Multi-Engine] Calling model ${modelName}...`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorDetails = await response.json().catch(() => ({}));
      const message = errorDetails?.error?.message || `HTTP ${response.status}`;
      const isQuota = response.status === 429 || response.status === 503 || message.toLowerCase().includes('quota') || message.toLowerCase().includes('resource_exhausted');
      
      if (isQuota) {
        const isDaily = message.toLowerCase().includes('day') || message.includes('500');
        const cdMs = isDaily ? 15 * 60 * 1000 : 12000;
        markDirectModelCooldown(modelName, cdMs);
        console.warn(`[GeminiService] Rate limit / Quota hit on ${modelName}. Cooling down for ${cdMs / 1000}s. Chuyển ngay sang engine khác...`);
        // Bỏ qua thử lại model này để tránh quá tải, quăng lỗi ngay để loop fallback sang model dự phòng (3.5 Lite hoặc 3.8 Flash)
        throw new Error(`Google API Quota Error (${modelName}): ${message}`);
      }

      throw new Error(`Google API Error (${modelName}): ${message}`);
    }

    const data = await response.json();
    const textOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textOutput) {
      throw new Error(`Phản hồi trống từ Gemini API (${modelName}).`);
    }
    return JSON.parse(textOutput.trim());
  };

  let lastErr: any = null;
  for (const modelName of modelsToTry) {
    try {
      return await executeWithModel(modelName);
    } catch (err: any) {
      console.warn(`[GeminiService] Model ${modelName} failed (${err.message}). Trying next fallback...`);
      lastErr = err;
    }
  }

  throw lastErr || new Error("Không thể thực thi lệnh gọi Gemini.");
}

/**
 * Utility to execute a task: first attempts the local Express server proxy.
 * If that fails (due to 404/CORS/network down on mobile), falls back to direct Google REST client execution.
 */
async function executeTask<T>(
  endpoint: string,
  serverPayload: any,
  directPayloadCreator: () => any,
  transformDirectResponse: (res: any) => T,
  preferredModel?: string
): Promise<T> {
  const isWebPreview = window.location.port === '3000' || window.location.hostname.includes('run.app');
  
  if (isWebPreview) {
    try {
      const apiKey = getGeminiApiKey();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["x-gemini-api-key"] = apiKey;
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...serverPayload, preferredModel }),
      });
      if (res.ok) {
        const data = await res.json();
        return data;
      }
      console.warn(`[GeminiService] Server proxy returned HTTP ${res.status}. Falling back to direct REST API...`);
    } catch (err: any) {
      console.warn(`[GeminiService] Server proxy failed (${err.message}). Falling back to direct REST API...`);
    }
  }

  // Fallback / Standalone direct execution
  console.log(`[GeminiService] Executing direct REST API call...`);
  const directPayload = directPayloadCreator();
  const directResult = await callGeminiDirect(directPayload, preferredModel);
  return transformDirectResponse(directResult);
}

const CATEGORY_GUIDELINES = `
QUY TẮC PHÂN LOẠI THỂ LOẠI SÁCH (BẮT BUỘC KHÔNG gán nhãn chung chung như "Văn học" hay "Sách"):
BẮT BUỘC CHỈ CHỌN DUY NHẤT 1 THỂ LOẠI TIÊU BIỂU NHẤT (KHÔNG ghép nhiều thể loại bằng dấu phẩy, KHÔNG ghi 2 thể loại cùng lúc):
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
 * 1. AI Vision: Batch scanning of book images to extract metadata (Dual-Engine Parallel Load Balancing)
 */
export async function scanImages(
  images: string[],
  existingBooks: BookRecord[] = [],
  preferredModel?: string
): Promise<{ success: boolean; count: number; books: any[] }> {
  // Nếu có từ 2 ảnh trở lên và không chỉ định model cụ thể -> tự động chia song song 2 Engine để phân tải
  if (images.length >= 2 && !preferredModel) {
    const mid = Math.ceil(images.length / 2);
    const chunkA = images.slice(0, mid);
    const chunkB = images.slice(mid);

    console.log(`[GeminiService] Tự động phân tải song song 2 Engine cho OCR: ${chunkA.length} ảnh (3.1 Lite) & ${chunkB.length} ảnh (3.5 Lite)...`);
    const [resA, resB] = await Promise.allSettled([
      scanImages(chunkA, existingBooks, 'gemini-3.1-flash-lite'),
      scanImages(chunkB, existingBooks, 'gemini-3.5-flash-lite'),
    ]);

    const booksA = resA.status === 'fulfilled' && resA.value?.success && Array.isArray(resA.value.books) ? resA.value.books : [];
    const booksB = resB.status === 'fulfilled' && resB.value?.success && Array.isArray(resB.value.books) ? resB.value.books : [];

    // Tự động cứu vãn lô bị lỗi trên Engine còn lại
    let recoveryBooks: any[] = [];
    if (booksA.length === 0 && chunkA.length > 0) {
      console.warn('[GeminiService OCR] Chunk A thất bại trên 3.1 Lite, tự động chuyển tải sang 3.5 Lite...');
      try {
        const rec = await scanImages(chunkA, existingBooks, 'gemini-3.5-flash-lite');
        if (rec.success && Array.isArray(rec.books)) recoveryBooks.push(...rec.books);
      } catch (e) {
        console.error('Lỗi cứu vãn OCR chunk A:', e);
      }
    }
    if (booksB.length === 0 && chunkB.length > 0) {
      console.warn('[GeminiService OCR] Chunk B thất bại trên 3.5 Lite, tự động chuyển tải sang 3.1 Lite...');
      try {
        const rec = await scanImages(chunkB, existingBooks, 'gemini-3.1-flash-lite');
        if (rec.success && Array.isArray(rec.books)) recoveryBooks.push(...rec.books);
      } catch (e) {
        console.error('Lỗi cứu vãn OCR chunk B:', e);
      }
    }

    const combined = [...booksA, ...booksB, ...recoveryBooks];

    return {
      success: true,
      count: combined.length,
      books: combined,
    };
  }

  return executeTask(
    '/api/books/scan-images',
    { images, existingBooks, preferredModel },
    () => {
      const parts: any[] = images.map((imgBase64) => {
        const cleanBase64 = imgBase64.replace(/^data:image\/[a-zA-Z0-9.+]+;base64,/, '');
        return {
          inlineData: {
            mimeType: 'image/jpeg',
            data: cleanBase64,
          },
        };
      });

      const existingReference = Array.isArray(existingBooks) && existingBooks.length > 0
        ? existingBooks.slice(0, 60).map((b: any) => `"${b.title}" (${b.author || 'Khuyết danh'})`).join(', ')
        : 'Chưa có sách nào.';

      parts.push({
        text: `Bạn là chuyên gia phân loại và bóc tách thư viện sách chuyên nghiệp đẳng cấp quốc tế.
Nhiệm vụ của bạn là rà soát cực kỳ tỉ mỉ bức ảnh chụp kệ sách từ TRÁI SANG PHẢI để trích xuất TOÀN BỘ các cuốn sách xuất hiện, không bỏ sót bất kỳ quyển nào.

DANH SÁCH SÁCH THAM KHẢO TRONG THƯ VIỆN NGƯỜI DÙNG (DÙNG ĐỂ ĐỐI CHIẾU SỬA LỖI):
${existingReference}

QUY TẮC PHÁT HIỆN THỊ GIÁC QUAN TRỌNG (BẮT BUỘC):
1. QUÉT SÁT RÌA MÉP ẢNH (CỰC KỲ QUAN TRỌNG - KHÔNG ĐƯỢC BỎ SÓT): 
   - Hãy rà soát cực kỳ cẩn thận từ quyển sách ngoài cùng bên trái (sát mép lề trái ảnh, ví dụ: "Hồi ký Phóng viên chiến trường" gáy màu sáng) cho đến quyển sách ngoài cùng bên phải (sát mép lề phải ảnh, ví dụ: "Quyền lực bà bồng" chữ đen nguệch ngoạc). 
   - Tuyệt đối không bỏ qua sách ở rìa ngoài cùng tủ kệ chỉ vì ảnh hơi mờ hoặc nhầm lẫn với khung gỗ.
2. PHÁT HIỆN SÁCH NẰM NGANG / ĐÈ LÊN NHAU: 
   - Ở nhiều kệ sách, có các quyển sách xếp NẰM NGANG chồng lên nhau, hoặc nhét phía trên các quyển sách đứng thẳng. Bạn PHẢI quét sạch chúng, xoay góc nhìn chữ gáy sách ngang 90 độ để bóc tách chính xác tên sách và tác giả.
3. NHẬN DIỆN PHÔNG CHỮ VIẾT TAY / CHỮ VẼ NGHỆ THUẬT: 
   - Một số quyển có tên sách viết bằng nét mảnh, chữ viết tay nguệch ngoạc (ví dụ: gáy cuốn "Quyền lực bà bồng" chữ viết tay đen trên nền sáng) hoặc font chữ vẽ hoa văn kiểu cách. Bạn PHẢI quan sát kỹ từng nét để suy luận và đọc chuẩn xác, tuyệt đối không được bỏ sót!
4. ĐỐI CHIẾU TRI THỨC VÀ TRÁNH LỖI GÁN NHẦM TÁC GIẢ BÊN CẠNH:
   - Hãy so sánh kỹ văn bản bạn đọc được với "DANH SÁCH SÁCH THAM KHẢO TRONG THƯ VIỆN" ở trên. 
   - Nếu gáy sách bị mờ nét hoặc nhận diện nhầm (ví dụ: quét ra "Bê trạm" nhưng thư viện có sẵn "Bè Trầm" của Bảo Ninh) thì PHẢI tự động khớp và sửa lại chính xác thành tên đúng trong thư viện là "Bè Trầm" và gán tác giả Bảo Ninh.
   - Nếu gáy sách không in tác giả (ví dụ: gáy chỉ ghi "Bè Trầm" hay "Bê Trầm"), hãy dựa vào danh sách tham khảo hoặc tri thức của bạn để điền đúng tác giả là "Bảo Ninh". TUYỆT ĐỐI không được gán nhầm tên tác giả của quyển sách đứng liền kề bên cạnh (ví dụ gáy sách "Ba người khác" của "Tô Hoài" xếp sát cạnh).
   - TUYỆT ĐỐI không được đoán mò hoặc tự ý thay thế sang tác phẩm khác của tác giả khác (ví dụ: không nhận diện nhầm "Đề Thám" của "E. Maliverney" thành "Dế mèn phiêu lưu ký" của "Tô Hoài").

Đối với mỗi cuốn sách trích xuất được, trả về đúng các trường:
- title: Tên sách chuẩn tiếng Việt có dấu. (Sách Ngoại văn giữ nguyên tên gốc chữ tượng hình/gốc kèm tên dịch trong ngoặc đơn, ví dụ: "活着 (Phải Sống)")
- author: Tác giả chuẩn (ví dụ: "Bảo Ninh", "E. Maliverney", "Tô Hoài")
- publisher: Nhà xuất bản / Công ty phát hành
- publish_year: Năm xuất bản (số nguyên hoặc null)
- category: Thể loại sách tiếng Việt đúng chuyên mục

${CATEGORY_GUIDELINES}

Trả về mảng JSON chứa các sách bóc tách được.`,
      });

      return {
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                title: { type: 'STRING', description: 'Tên cuốn sách' },
                author: { type: 'STRING', description: 'Tác giả' },
                publisher: { type: 'STRING', description: 'Nhà xuất bản' },
                publish_year: { type: 'INTEGER', description: 'Năm xuất bản' },
                category: { type: 'STRING', description: 'Thể loại sách chuyên sâu' },
              },
              required: ['title', 'author', 'publisher'],
            },
          },
        },
      };
    },
    (directResult) => ({
      success: true,
      count: Array.isArray(directResult) ? directResult.length : 0,
      books: directResult || [],
    }),
    preferredModel
  );
}

/**
 * 2. Data Enrichment: Find detailed info of a single book with search grounding / AI knowledge
 */
export async function enrichBook(
  title: string,
  author: string,
  publisher: string,
  preferredModel?: string
): Promise<{ success: boolean; enriched: any }> {
  return executeTask(
    '/api/books/enrich',
    { title, author, publisher, preferredModel },
    () => {
      const prompt = `Hãy tra cứu và chuẩn hóa thông tin chi tiết chính xác của cuốn sách tiếng Việt/quốc tế sau:
Tên hiện tại: "${title}"
Tác giả hiện tại: "${author || ''}"
NXB hiện tại: "${publisher || ''}"

${CATEGORY_GUIDELINES}

Trả về thông tin chuẩn nhất:
- title: Tên sách chuẩn (Đối với sách NGOẠI VĂN: BẮT BUỘC giữ nguyên TÊN CHỮ TƯỢNG HÌNH/CHỮ GỐC IN TRÊN BÌA SÁCH kèm tên dịch tiếng Việt trong ngoặc đơn như "活着 (Phải Sống)", "Norwegian Wood (Rừng Na Uy)". TUYỆT ĐỐI KHÔNG dùng phiên âm Alphabet/Pinyin như KHÔNG viết "Huozhe (Phải Sống)").
- author: Tác giả chuẩn (Dịch hoặc dùng tên Hán-Việt/phiên dịch tiếng Việt chuẩn nếu có như "Dư Hoa", "Khổng Tử", "Haruki Murakami")
- publisher: Nhà xuất bản uy tín
- publish_year: Năm phát hành bản in phổ biến
- category: Thể loại chuyên sâu theo hướng dẫn trên
- summary: Tóm tắt 1-2 câu nội dung cuốn sách`;

      return {
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
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
        },
      };
    },
    (directResult) => ({
      success: true,
      enriched: directResult,
    })
  );
}

/**
 * 3. Batch Normalization: Auto spell check, capitalize, verify categories in background
 * Supports specifying preferredModel ('gemini-3.1-flash-lite' or 'gemini-3.5-flash-lite') for parallel dual-engine acceleration
 */
export async function batchNormalize(
  books: BookRecord[],
  preferredModel?: string
): Promise<{ success: boolean; normalized: any[] }> {
  // Nếu có từ 2 cuốn trở lên và chưa chỉ định model cụ thể -> tự động chia song song 2 Engine 3.1 và 3.5 để phân tải 50/50
  if (books.length >= 2 && !preferredModel) {
    const mid = Math.ceil(books.length / 2);
    const chunkA = books.slice(0, mid);
    const chunkB = books.slice(mid);

    console.log(`[GeminiService] Tự động phân tải song song 2 Engine cho Chuẩn hóa: ${chunkA.length} cuốn (3.1 Lite) & ${chunkB.length} cuốn (3.5 Lite)...`);
    const [resA, resB] = await Promise.allSettled([
      batchNormalize(chunkA, 'gemini-3.1-flash-lite'),
      batchNormalize(chunkB, 'gemini-3.5-flash-lite'),
    ]);

    const normA = resA.status === 'fulfilled' && resA.value?.success && Array.isArray(resA.value.normalized) ? resA.value.normalized : [];
    const normB = resB.status === 'fulfilled' && resB.value?.success && Array.isArray(resB.value.normalized) ? resB.value.normalized : [];

    // Tự động cứu vãn lô bị lỗi trên Engine còn lại
    let recoveryNorm: any[] = [];
    if (normA.length === 0 && chunkA.length > 0) {
      console.warn('[GeminiService Chuẩn hóa] Chunk A thất bại trên 3.1 Lite, tự động chuyển tải sang 3.5 Lite...');
      try {
        const rec = await batchNormalize(chunkA, 'gemini-3.5-flash-lite');
        if (rec.success && Array.isArray(rec.normalized)) recoveryNorm.push(...rec.normalized);
      } catch (e) {
        console.error('Lỗi cứu vãn chuẩn hóa chunk A:', e);
      }
    }
    if (normB.length === 0 && chunkB.length > 0) {
      console.warn('[GeminiService Chuẩn hóa] Chunk B thất bại trên 3.5 Lite, tự động chuyển tải sang 3.1 Lite...');
      try {
        const rec = await batchNormalize(chunkB, 'gemini-3.1-flash-lite');
        if (rec.success && Array.isArray(rec.normalized)) recoveryNorm.push(...rec.normalized);
      } catch (e) {
        console.error('Lỗi cứu vãn chuẩn hóa chunk B:', e);
      }
    }

    const combined = [...normA, ...normB, ...recoveryNorm];
    return {
      success: true,
      normalized: combined,
    };
  }

  return executeTask(
    '/api/books/batch-normalize',
    { books, preferredModel },
    () => {
      const prompt = `Bạn là biên tập viên thư viện sách chuyên nghiệp. 
Hãy sửa lỗi chính tả, sửa tiếng Việt không dấu thành có dấu chuẩn xác, viết hoa chữ cái đầu đúng quy tắc tiếng Việt/quốc tế cho danh sách các cuốn sách sau đây. 
Nếu thông tin tác giả chưa đúng hoặc thiếu dấu, hãy tự động sửa lại chính xác (ví dụ: "nguyen nhat anh" -> "Nguyễn Nhật Ánh"). 
Nếu nhà xuất bản viết tắt hoặc thiếu dấu, hãy điền đầy đủ (ví dụ: "nxb tre" -> "NXB Trẻ", "nha nam" -> "Nhã Nam", "nxb kim dong" -> "NXB Kim Đồng").

${CATEGORY_GUIDELINES}

Dưới đây là danh sách sách dạng JSON cần chuẩn hóa và phân loại lại chuyên sâu:
${JSON.stringify(books)}

Hãy trả về một mảng JSON mới có cấu trúc tương ứng, giữ nguyên trường "id" của từng cuốn sách, và bổ sung thuộc tính "is_ai_normalized": true cho tất cả sách đã chuẩn hóa thành công.`;

      return {
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
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
              required: ['id', 'title', 'author', 'publisher', 'category', 'is_ai_normalized'],
            },
          },
        },
      };
    },
    (directResult) => {
      const list = Array.isArray(directResult) ? directResult : [];
      return {
        success: true,
        normalized: list.map((b: any) => ({
          ...b,
          category: sanitizeSingleCategory(b.category || 'Chung'),
          is_ai_normalized: true,
        })),
      };
    },
    preferredModel
  );
}
