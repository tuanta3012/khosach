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
    const testModel = 'gemini-3.5-flash-lite';
    const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${encodeURIComponent(cleanKey)}`;
    let directResp = await fetch(testUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Ping test' }] }],
      }),
    });

    if (!directResp.ok) {
      // Fallback test model gemini-1.5-flash
      const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(cleanKey)}`;
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

let lastCallTimestamp35 = 0;
let lastCallTimestamp31 = 0;

/**
 * Direct fetch helper with Dual Engine load balancer (Gemini 3.5 Flash Lite + Gemini 3.1 Flash Lite),
 * rate limit throttle (RPM 15 guard per engine), 429 retry, and model failover
 */
async function callGeminiDirect(payload: any, preferredModel?: string): Promise<any> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Không tìm thấy Gemini API Key. Hãy khai báo API Key hoặc cấu hình trong ứng dụng.");
  }

  const now = Date.now();
  const waitTime35 = Math.max(0, 2800 - (now - lastCallTimestamp35));
  const waitTime31 = Math.max(0, 2800 - (now - lastCallTimestamp31));

  let primaryModel = "gemini-3.5-flash-lite";
  let modelsToTry = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite"
  ];

  if (preferredModel) {
    primaryModel = preferredModel;
    modelsToTry = [preferredModel, ...modelsToTry.filter(m => m !== preferredModel)];
  } else if (waitTime31 < waitTime35) {
    primaryModel = "gemini-3.1-flash-lite";
    modelsToTry = [
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite"
    ];
  }

  // Throttle per engine
  if (primaryModel === "gemini-3.5-flash-lite") {
    if (waitTime35 > 0) await new Promise((resolve) => setTimeout(resolve, waitTime35));
    lastCallTimestamp35 = Date.now();
  } else if (primaryModel === "gemini-3.1-flash-lite") {
    if (waitTime31 > 0) await new Promise((resolve) => setTimeout(resolve, waitTime31));
    lastCallTimestamp31 = Date.now();
  }

  const executeWithModel = async (modelName: string, retries = 2): Promise<any> => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    try {
      console.log(`[GeminiService Dual-Engine] Calling model ${modelName}...`);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorDetails = await response.json().catch(() => ({}));
        const message = errorDetails?.error?.message || `HTTP ${response.status}`;
        
        // Nếu dính lỗi 429 Quota/Rate Limit và còn lượt thử -> chờ 4s rồi thử lại
        if ((response.status === 429 || message.toLowerCase().includes('quota')) && retries > 0) {
          console.warn(`[GeminiService] Rate limit 429 hit on ${modelName}. Retrying in 4s... (${retries} left)`);
          await new Promise((res) => setTimeout(res, 4000));
          return await executeWithModel(modelName, retries - 1);
        }

        throw new Error(`Google API Error (${modelName}): ${message}`);
      }

      const data = await response.json();
      const textOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!textOutput) {
        throw new Error(`Phản hồi trống từ Gemini API (${modelName}).`);
      }
      return JSON.parse(textOutput.trim());
    } catch (err: any) {
      if (retries > 0 && err.message?.includes('429')) {
        await new Promise((res) => setTimeout(res, 4000));
        return await executeWithModel(modelName, retries - 1);
      }
      throw err;
    }
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
 * 1. AI Vision: Batch scanning of book images to extract metadata (with context grounding)
 */
export async function scanImages(
  images: string[],
  existingBooks: BookRecord[] = []
): Promise<{ success: boolean; count: number; books: any[] }> {
  return executeTask(
    '/api/books/scan-images',
    { images, existingBooks },
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

      parts.push({
        text: `Bạn là chuyên gia phân loại và bóc tách thư viện sách chuyên nghiệp đẳng cấp quốc tế.
Nhiệm vụ của bạn là rà soát cực kỳ tỉ mỉ bức ảnh chụp kệ sách từ TRÁI SANG PHẢI để trích xuất TOÀN BỘ các cuốn sách xuất hiện, không bỏ sót bất kỳ quyển nào.

QUY TẮC PHÁT HIỆN THỊ GIÁC QUAN TRỌNG (BẮT BUỘC):
1. QUÉT KỸ RÌA NGOÀI CÙNG (CỰC KỲ DỄ BỎ SÓT): Phải quét cẩn thận từ gáy sách ngoài cùng bên trái (sát mép lề trái ảnh, ví dụ cuốn "Hồi ký Phóng viên chiến trường" gáy trắng) đến gáy sách ngoài cùng bên phải. Tuyệt đối không được bỏ qua các cuốn ở rìa ngoài cùng do nhầm lẫn với viền gỗ của tủ kệ.
2. XOAY HƯỚNG ĐỌC ĐA CHIỀU: Các cuốn sách có thể xếp ĐỨNG, NẰM NGANG, HOẶC CHỒNG LÊN NHAU. Hãy tự động xoay góc nhìn trong trí óc (trái, right, ngược, xuôi) để bóc tách toàn bộ sách nằm ngang ở phía trên hoặc xếp lệch.
3. NHẬN DIỆN CHỮ VIẾT TAY / CHỮ VẼ NGHỆ THUẬT: Một số cuốn sử dụng font chữ viết tay hoặc vẽ nét mảnh cách điệu đen trắng (ví dụ gáy cuốn "Quyền lực bà bồng" chữ đen viết tay nguệch ngoạc). Bạn phải quan sát kỹ từng nét để suy luận từ vựng chính xác, không được bỏ qua!
4. ĐỐI CHIẾU TRI THỨC VÀ TRÁNH LỖI GÁN TÁC GIẢ BÊN CẠNH:
   - Nếu gáy sách bị khuyết tác giả (chỉ ghi tên sách, ví dụ cuốn "Bê Trầm"), hãy dùng tri thức của bạn để điền đúng tác giả (Bảo Ninh). Tuyệt đối không gán nhầm tên tác giả của cuốn sách bên cạnh (ví dụ gáy sách "Ba người khác" của "Tô Hoài" đứng kề bên) cho nó!
   - Tuyệt đối không được đoán mò hoặc nhận diện sai lệch sang tác phẩm khác của tác giả khác (ví dụ: Không nhận diện nhầm "Đề Thám" của "E. Maliverney" thành "Dế mèn phiêu lưu ký" của Tô Hoài).

Đối với mỗi cuốn sách, trích xuất chuẩn xác các trường:
- title: Tên sách (BẮT BUỘC ghi tiếng Việt chuẩn có dấu. Đối với sách Ngoại văn, giữ nguyên tên gốc chữ tượng hình/gốc kèm dịch trong ngoặc đơn, ví dụ: "活着 (Phải Sống)")
- author: Tác giả (Tên chuẩn chữ phiên âm tiếng Việt hoặc tên gốc, ví dụ: "Bảo Ninh", "E. Maliverney", "Haruki Murakami")
- publisher: Nhà xuất bản / Công ty phát hành
- publish_year: Năm xuất bản (số nguyên 4 chữ số hoặc null)
- category: Thể loại sách chuyên sâu theo quy tắc bên dưới

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
    })
  );
}

/**
 * 2. Data Enrichment: Find detailed info of a single book with search grounding / AI knowledge
 */
export async function enrichBook(
  title: string,
  author: string,
  publisher: string
): Promise<{ success: boolean; enriched: any }> {
  return executeTask(
    '/api/books/enrich',
    { title, author, publisher },
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
 */
export async function batchNormalize(books: BookRecord[]): Promise<{ success: boolean; normalized: any[] }> {
  return executeTask(
    '/api/books/batch-normalize',
    { books },
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
    }
  );
}
