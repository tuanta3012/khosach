import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const defaultAi = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

function getAiClient(customKey?: string) {
  if (customKey && typeof customKey === 'string' && customKey.trim().length > 0) {
    return new GoogleGenAI({
      apiKey: customKey.trim(),
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return defaultAi;
}

function sanitizeSingleCategory(rawCategory: string): string {
  if (!rawCategory || !rawCategory.trim()) return 'Chung';
  const first = rawCategory.split(/[,/|+\\]/)[0].trim();
  return first || 'Chung';
}

const ALL_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const modelCooldownMap = new Map<string, number>();
const lastCallTimestamps = new Map<string, number>();

function isModelInCooldown(model: string): boolean {
  const cd = modelCooldownMap.get(model);
  if (!cd) return false;
  if (Date.now() > cd) {
    modelCooldownMap.delete(model);
    return false;
  }
  return true;
}

function markModelCooldown(model: string, durationMs: number) {
  modelCooldownMap.set(model, Date.now() + durationMs);
}

function getAvailableModels(preferredModel?: string): string[] {
  let initialOrder: string[];
  if (preferredModel === 'gemini-3.1-flash-lite') {
    initialOrder = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
  } else {
    initialOrder = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  }

  const healthy = initialOrder.filter((m) => !isModelInCooldown(m));
  const cooling = initialOrder.filter((m) => isModelInCooldown(m));
  return [...healthy, ...cooling];
}

async function generateContentWithFallback(params: { contents: any; config?: any; apiKey?: string; preferredModel?: string }) {
  const aiClient = getAiClient(params.apiKey);
  const modelsToTry = getAvailableModels(params.preferredModel);

  let lastError: any = null;
  for (const modelName of modelsToTry) {
    try {
      // Throttle per model to keep strictly within RPM 15 limits (~4.2s per model)
      const lastCall = lastCallTimestamps.get(modelName) || 0;
      const waitTime = Math.max(0, 4200 - (Date.now() - lastCall));
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      lastCallTimestamps.set(modelName, Date.now());

      console.log(`[Server AI Multi-Engine] Requesting model: ${modelName}`);
      const res = await aiClient.models.generateContent({
        model: modelName,
        contents: params.contents,
        config: params.config,
      });
      return res;
    } catch (err: any) {
      console.warn(`[Server AI Multi-Engine] Model ${modelName} failed (${err.message || err}).`);
      lastError = err;

      // Handle 429 quota exhaustion, 503 high demand, and rate limiting
      const errMsg = (err.message || String(err)).toLowerCase();
      const isQuotaOrLimit = err.status === 429 || err.status === 503 || errMsg.includes('429') || errMsg.includes('503') || errMsg.includes('quota') || errMsg.includes('resource_exhausted') || errMsg.includes('high demand');

      if (isQuotaOrLimit) {
        const isDailyOrExhausted = errMsg.includes('day') || errMsg.includes('500') || errMsg.includes('tokens_per_model') || errMsg.includes('25000000') || errMsg.includes('high demand');
        const cdMs = isDailyOrExhausted ? 30 * 60 * 1000 : 8000;
        markModelCooldown(modelName, cdMs);
        console.warn(`[Server AI Multi-Engine] ${modelName} cooldown for ${cdMs / 1000}s. Trying next available model...`);
      }
    }
  }

  throw lastError || new Error("Tất cả các AI models đều tạm thời gián đoạn.");
}

// API: Kiểm tra tính hợp lệ của Gemini API Key (Có Tự động Fallback sang các Model dự phòng)
app.post('/api/ai/test-key', async (req, res) => {
  try {
    const customKey = (req.body?.apiKey || req.headers['x-gemini-api-key'] || process.env.GEMINI_API_KEY) as string;
    if (!customKey || !customKey.trim()) {
      return res.status(400).json({ success: false, message: 'Vui lòng cung cấp API Key để kiểm tra.' });
    }
    
    const aiClient = getAiClient(customKey.trim());
    let response: any = null;
    let lastErr: any = null;

    // Thử lần lượt các model tối ưu
    const testModels = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
    for (const m of testModels) {
      try {
        response = await aiClient.models.generateContent({
          model: m,
          contents: 'Ping',
        });
        if (response && response.text) break;
      } catch (e: any) {
        lastErr = e;
      }
    }

    if (response && response.text) {
      return res.json({ success: true, message: 'Kết nối Google Gemini thành công! Key hoạt động tốt.' });
    }

    throw lastErr || new Error('Không nhận được phản hồi từ AI.');
  } catch (err: any) {
    console.warn('[Server AI] Test API Key failed:', err.message || err);
    let readableError = 'API Key không hợp lệ hoặc đã hết hạn mức.';
    try {
      const parsed = JSON.parse(err.message);
      readableError = parsed?.error?.message || readableError;
    } catch {
      readableError = err.message || readableError;
    }

    const lower = readableError.toLowerCase();
    if (lower.includes('api key not valid') || lower.includes('api_key_invalid')) {
      readableError = 'API Key không hợp lệ. Vui lòng kiểm tra lại mã Key.';
    } else if (lower.includes('quota') || lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('exceeded')) {
      readableError = 'API Key này đã chạm hạn ngạch (429 Quota). Hãy kiểm tra lại gói dịch vụ trên Google AI Studio.';
    } else if (lower.includes('permission_denied') || lower.includes('403')) {
      readableError = 'API Key không có quyền truy cập Gemini API.';
    }

    return res.status(400).json({
      success: false,
      message: readableError,
    });
  }
});

// API: Batch OCR & Book Extraction from images (Dual Engine Parallel Acceleration)
app.post('/api/books/scan-images', async (req, res) => {
  try {
    const { images, existingBooks } = req.body;
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Không có ảnh nào được gửi lên để phân tích.' });
    }

    const apiKey = (req.headers['x-gemini-api-key'] || req.body?.apiKey) as string | undefined;

    const processImageChunk = async (chunkImages: string[], preferredModel?: string) => {
      const parts: any[] = [];
      for (const imgBase64 of chunkImages) {
        const cleanBase64 = imgBase64.replace(/^data:image\/[a-zA-Z0-9.+]+;base64,/, '');
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: cleanBase64,
          },
        });
      }

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

Trả về mảng JSON chứa các sách bóc tách được.`,
      });

      const response = await generateContentWithFallback({
        contents: { parts },
        apiKey,
        preferredModel,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING, description: 'Tên cuốn sách' },
                author: { type: Type.STRING, description: 'Tác giả' },
                publisher: { type: Type.STRING, description: 'Nhà xuất bản' },
                publish_year: { type: Type.INTEGER, description: 'Năm xuất bản' },
                category: { type: Type.STRING, description: 'Thể loại sách' },
              },
              required: ['title', 'author', 'publisher'],
            },
          },
        },
      });

      const textOutput = response.text || '[]';
      return JSON.parse(textOutput);
    };

    let allExtractedBooks: any[] = [];
    const preferredModel = req.body?.preferredModel as string | undefined;

    if (preferredModel) {
      allExtractedBooks = await processImageChunk(images, preferredModel);
    } else if (images.length >= 2) {
      // Nếu gửi từ 2 ảnh trở lên, chia đều song song 2 luồng Engine: 3.1 Lite & 3.5 Lite
      const mid = Math.ceil(images.length / 2);
      const chunkA = images.slice(0, mid);
      const chunkB = images.slice(mid);

      const engineA = 'gemini-3.1-flash-lite';
      const engineB = 'gemini-3.5-flash-lite';

      console.log(`[Server AI] Executing parallel multi-engine scan: ${chunkA.length} images on ${engineA}, ${chunkB.length} images on ${engineB}`);
      const [resA, resB] = await Promise.all([
        processImageChunk(chunkA, engineA).catch(() => processImageChunk(chunkA, engineB)).catch(() => []),
        processImageChunk(chunkB, engineB).catch(() => processImageChunk(chunkB, engineA)).catch(() => []),
      ]);
      allExtractedBooks = [...(resA || []), ...(resB || [])];
    } else {
      allExtractedBooks = await processImageChunk(images);
    }

    return res.json({ success: true, count: allExtractedBooks.length, books: allExtractedBooks });
  } catch (err: any) {
    console.error('Error scanning book images with Gemini:', err);
    return res.status(500).json({
      error: 'Không thể bóc tách dữ liệu sách từ ảnh.',
      message: err?.message || String(err),
    });
  }
});

// API: Enrich single book info with Google / Gemini search grounding
app.post('/api/books/enrich', async (req, res) => {
  try {
    const { title, author, publisher, preferredModel } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Tên sách là bắt buộc để làm giàu dữ liệu.' });
    }

    const prompt = `Hãy tra cứu và chuẩn hóa thông tin chi tiết chính xác của cuốn sách tiếng Việt/quốc tế sau:
Tên hiện tại: "${title}"
Tác giả hiện tại: "${author || ''}"
NXB hiện tại: "${publisher || ''}"

Trả về thông tin chuẩn nhất:
- title: Tên sách chuẩn (Đối với sách NGOẠI VĂN: BẮT BUỘC giữ nguyên TÊN CHỮ TƯỢNG HÌNH/CHỮ GỐC IN TRÊN BÌA SÁCH kèm tên dịch tiếng Việt trong ngoặc đơn như "活着 (Phải Sống)", "Norwegian Wood (Rừng Na Uy)". TUYỆT ĐỐI KHÔNG dùng phiên âm Alphabet/Pinyin như KHÔNG viết "Huozhe (Phải Sống)").
- author: Tác giả chuẩn (Dịch hoặc dùng tên Hán-Việt/phiên dịch tiếng Việt chuẩn nếu có như "Dư Hoa", "Khổng Tử", "Haruki Murakami")
- publisher: Nhà xuất bản uy tín
- publish_year: Năm phát hành bản in phổ biến
- category: Thể loại chuẩn (Văn học, Kinh tế, Lịch sử, Tâm lý, Khoa học...)
- summary: Tóm tắt 1-2 câu nội dung cuốn sách`;

    const apiKey = (req.headers['x-gemini-api-key'] || req.body?.apiKey) as string | undefined;
    const response = await generateContentWithFallback({
      contents: prompt,
      apiKey,
      preferredModel,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            author: { type: Type.STRING },
            publisher: { type: Type.STRING },
            publish_year: { type: Type.INTEGER },
            category: { type: Type.STRING },
            summary: { type: Type.STRING },
          },
          required: ['title', 'author', 'publisher', 'category'],
        },
      },
    });

    const data = JSON.parse(response.text || '{}');
    return res.json({ success: true, enriched: data });
  } catch (err: any) {
    console.error('Error enriching book info:', err);
    return res.status(500).json({
      error: 'Lỗi tra cứu làm giàu thông tin sách.',
      message: err?.message || String(err),
    });
  }
});

// API: Batch Normalize book metadata using Dual Engine Parallel Acceleration
app.post('/api/books/batch-normalize', async (req, res) => {
  try {
    const { books, preferredModel } = req.body;
    if (!books || !Array.isArray(books) || books.length === 0) {
      return res.status(400).json({ error: 'Không có danh sách sách để chuẩn hóa.' });
    }

    const apiKey = (req.headers['x-gemini-api-key'] || req.body?.apiKey) as string | undefined;

    const processNormalizeChunk = async (chunkBooks: any[], modelChoice?: string) => {
      const prompt = `Bạn là biên tập viên thư viện sách chuyên nghiệp. 
Hãy sửa lỗi chính tả, sửa tiếng Việt không dấu thành có dấu chuẩn xác, viết hoa chữ cái đầu đúng quy tắc tiếng Việt/quốc tế cho danh sách các cuốn sách sau đây. 
Nếu thông tin tác giả chưa đúng hoặc thiếu dấu, hãy tự động sửa lại chính xác (ví dụ: "nguyen nhat anh" -> "Nguyễn Nhật Ánh"). 
Nếu nhà xuất bản viết tắt hoặc thiếu dấu, hãy điền đầy đủ (ví dụ: "nxb tre" -> "NXB Trẻ", "nha nam" -> "Nhã Nam", "nxb kim dong" -> "NXB Kim Đồng").
Nếu thể loại chưa chuẩn, hãy phân loại và đưa về các thể loại chuẩn tiếng Việt phù hợp (như: Văn học, Kinh tế, Lịch sử, Tâm lý học, Khoa học, Thiếu nhi, Kỹ năng sống, Triết học, Mỹ thuật...).

Dưới đây là danh sách sách dạng JSON cần chuẩn hóa:
${JSON.stringify(chunkBooks)}

Hãy trả về một mảng JSON mới có cấu trúc tương ứng, giữ nguyên trường "id" của từng cuốn sách, và bổ sung thuộc tính "is_ai_normalized": true cho tất cả sách đã chuẩn hóa thành công.`;

      const response = await generateContentWithFallback({
        contents: prompt,
        apiKey,
        preferredModel: modelChoice,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING, description: 'ID giữ nguyên không đổi' },
                title: { type: Type.STRING, description: 'Tên sách chuẩn' },
                author: { type: Type.STRING, description: 'Tác giả chuẩn' },
                publisher: { type: Type.STRING, description: 'Nhà xuất bản chuẩn' },
                category: { type: Type.STRING, description: 'Thể loại chuẩn' },
                is_ai_normalized: { type: Type.BOOLEAN, description: 'Bắt buộc là true' }
              },
              required: ['id', 'title', 'author', 'publisher', 'category', 'is_ai_normalized']
            }
          }
        }
      });

      const output = JSON.parse(response.text || '[]');
      return Array.isArray(output) ? output : [];
    };

    let normalizedResults: any[] = [];

    if (preferredModel) {
      // Nếu client chỉ định cụ thể model (ví dụ phân luồng worker)
      normalizedResults = await processNormalizeChunk(books, preferredModel);
    } else if (books.length >= 2) {
      // Chia đều 2 luồng Engine: 1 luồng Gemini 3.1 Flash Lite & 1 luồng Gemini 3.5 Flash Lite
      const mid = Math.ceil(books.length / 2);
      const chunkA = books.slice(0, mid);
      const chunkB = books.slice(mid);

      const engineA = 'gemini-3.1-flash-lite';
      const engineB = 'gemini-3.5-flash-lite';

      console.log(`[Server AI] Executing parallel batch normalize: ${chunkA.length} books on ${engineA}, ${chunkB.length} books on ${engineB}`);
      const [resA, resB] = await Promise.all([
        processNormalizeChunk(chunkA, engineA).catch(() => processNormalizeChunk(chunkA, engineB)).catch(() => []),
        processNormalizeChunk(chunkB, engineB).catch(() => processNormalizeChunk(chunkB, engineA)).catch(() => []),
      ]);
      normalizedResults = [...(resA || []), ...(resB || [])];
    } else {
      normalizedResults = await processNormalizeChunk(books);
    }

    const cleaned = normalizedResults.map((b: any) => ({
      ...b,
      category: sanitizeSingleCategory(b.category || 'Chung'),
      is_ai_normalized: true,
    }));

    return res.json({ success: true, normalized: cleaned });
  } catch (err: any) {
    console.error('Error in batch normalization API:', err);
    return res.status(500).json({
      error: 'Không thể chuẩn hóa hàng loạt dữ liệu sách.',
      message: err?.message || String(err),
    });
  }
});

// API: Proxy for Google Drive / Google Sheets & Apps Script to bypass browser CORS completely!
app.all('/api/drive/proxy', async (req, res) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Thiếu tham số url để proxy.' });
  }

  console.log(`[Proxy Drive] Method ${req.method} to target: ${targetUrl}`);

  try {
    let currentUrl = targetUrl;
    let currentMethod = req.method;
    const headers: any = {
      'User-Agent': 'aistudio-khosach-proxy',
    };

    // Chuẩn bị body ban đầu
    let bodyPayload: any = undefined;
    if (currentMethod === 'POST' || currentMethod === 'PUT') {
      bodyPayload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    }

    let response;
    let redirectCount = 0;
    const maxRedirects = 10;

    while (redirectCount < maxRedirects) {
      const fetchOptions: any = {
        method: currentMethod,
        headers: headers,
        redirect: 'manual', // Tự tay xử lý chuyển hướng để tránh lỗi giữ nguyên body/Content-Type khi đổi từ POST thành GET
      };

      if (bodyPayload !== undefined) {
        fetchOptions.body = bodyPayload;
      }

      response = await fetch(currentUrl, {
        ...fetchOptions,
        signal: AbortSignal.timeout(60000), // Timeout 60 giây hỗ trợ Google Apps Script đồng bộ dữ liệu lớn
      });

      const status = response.status;
      console.log(`[Proxy Drive] Request to ${currentUrl} returned status ${status}`);

      // Xử lý chuyển hướng (301, 302, 303, 307, 308)
      if (status >= 300 && status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          break;
        }

        // Tạo URL tuyệt đối từ Location header
        currentUrl = new URL(location, currentUrl).toString();
        redirectCount++;
        console.log(`[Proxy Drive] Redirecting to: ${currentUrl} (Count: ${redirectCount})`);

        // Quy tắc chuẩn HTTP: Đối với 301, 302, 303: Chuyển sang GET và xóa bỏ Body + Content-Type
        if (status === 301 || status === 302 || status === 303) {
          currentMethod = 'GET';
          bodyPayload = undefined;
          delete headers['Content-Type'];
        }
        continue;
      }

      break;
    }

    if (!response) {
      throw new Error('Không nhận được phản hồi từ máy chủ đích.');
    }

    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return res.json(data);
    } else {
      const text = await response.text();
      // If it returned HTML (e.g. 404, Page not found, Login redirect, Script error)
      const trimmed = text.trim();
      if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.includes('<title>Page not found</title>')) {
        let cleanMsg = 'Máy chủ Google trả về trang web HTML thay vì dữ liệu JSON.';
        if (text.includes('Page not found') || text.includes('does not exist')) {
          cleanMsg = 'Liên kết Google Apps Script hoặc Google Sheet không tồn tại (File/Script not found).';
        } else if (text.includes('accounts.google.com') || text.includes('Sign in') || text.includes('ServiceLogin')) {
          cleanMsg = 'Liên kết yêu cầu đăng nhập tài khoản Google. Vui lòng kiểm tra quyền chia sẻ công khai.';
        }
        return res.status(response.status >= 400 ? response.status : 422).json({
          status: 'error',
          success: false,
          error: cleanMsg,
          isHtmlError: true,
        });
      }
      res.setHeader('Content-Type', contentType || 'text/plain; charset=utf-8');
      return res.send(text);
    }
  } catch (err: any) {
    console.error('[Proxy Drive] Lỗi khi chuyển tiếp yêu cầu:', err.message || err);
    return res.status(502).json({
      success: false,
      error: `CORS Proxy thất bại: ${err.message || String(err)}`
    });
  }
});

// API: Proxy Check App Update to bypass browser CORS / localized ISP blocks
app.get('/api/app-update/check', async (req, res) => {
  const TARGET_URL = 'https://raw.githubusercontent.com/tuanta3012/khosach/refs/heads/main/version.json';
  
  try {
    const cacheBustUrl = `${TARGET_URL}?t=${Date.now()}`;
    console.log(`[Server UpdateCheck] Fetching exclusively from: ${cacheBustUrl}`);
    
    const response = await fetch(cacheBustUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'aistudio-build-updater'
      }
    });

    if (response.ok) {
      const data = await response.json();
      if (data && data.version) {
        console.log(`[Server UpdateCheck] Successfully fetched version ${data.version}`);
        return res.json({
          success: true,
          version: data.version.trim(),
          notes: data.notes || '',
          apkUrl: data.apkUrl || ''
        });
      }
    }
    
    console.warn(`[Server UpdateCheck] Source returned HTTP ${response.status}`);
    return res.status(502).json({
      success: false,
      error: `GitHub Raw returned HTTP ${response.status}`
    });
  } catch (err: any) {
    console.error(`[Server UpdateCheck] Error fetching update:`, err.message || err);
    return res.status(502).json({
      success: false,
      error: `Không thể kết nối đến máy chủ cập nhật GitHub: ${err.message}`
    });
  }
});

// Vite Middleware for development
if (process.env.NODE_ENV !== 'production') {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server Kho Sách running on port ${PORT}`);
});
