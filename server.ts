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

let lastCallTimestamp35 = 0;
let lastCallTimestamp31 = 0;

async function generateContentWithFallback(params: { contents: any; config?: any; apiKey?: string; preferredModel?: string }) {
  const aiClient = getAiClient(params.apiKey);
  const now = Date.now();

  // Đánh giá thời gian chờ cho từng model pool (Target ~15 RPM = ~2.8s throttle per model pool)
  const waitTime35 = Math.max(0, 2800 - (now - lastCallTimestamp35));
  const waitTime31 = Math.max(0, 2800 - (now - lastCallTimestamp31));

  let primaryModel = 'gemini-3.5-flash-lite';
  let modelsToTry = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ];

  if (params.preferredModel) {
    primaryModel = params.preferredModel;
    modelsToTry = [params.preferredModel, ...modelsToTry.filter((m) => m !== params.preferredModel)];
  } else if (waitTime31 < waitTime35) {
    primaryModel = 'gemini-3.1-flash-lite';
    modelsToTry = [
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
    ];
  }

  // Cập nhật timestamp cho model được chọn làm primary để đảm bảo RPM < 15 (~3.5s per request)
  if (primaryModel === 'gemini-3.5-flash-lite') {
    if (waitTime35 > 0) await new Promise((resolve) => setTimeout(resolve, waitTime35));
    lastCallTimestamp35 = Date.now();
  } else if (primaryModel === 'gemini-3.1-flash-lite') {
    if (waitTime31 > 0) await new Promise((resolve) => setTimeout(resolve, waitTime31));
    lastCallTimestamp31 = Date.now();
  }

  let lastError: any = null;
  for (const modelName of modelsToTry) {
    try {
      console.log(`[Server AI Dual-Engine] Requesting model: ${modelName}`);
      return await aiClient.models.generateContent({
        model: modelName,
        contents: params.contents,
        config: params.config,
      });
    } catch (err: any) {
      console.warn(`[Server AI Dual-Engine] Model ${modelName} failed (${err.message || err}).`);
      lastError = err;
    }
  }

  throw lastError || new Error("Cả 2 model gemini-3.5-flash-lite và gemini-3.1-flash-lite đều tạm thời gián đoạn.");
}

// API: Kiểm tra tính hợp lệ của Gemini API Key (Có Tự động Fallback sang các Model dự phòng)
app.post('/api/ai/test-key', async (req, res) => {
  try {
    const customKey = (req.body?.apiKey || req.headers['x-gemini-api-key'] || process.env.GEMINI_API_KEY) as string;
    if (!customKey || !customKey.trim()) {
      return res.status(400).json({ success: false, message: 'Vui lòng cung cấp API Key để kiểm tra.' });
    }
    
    // Sử dụng cơ chế Fallback tự động quay vòng qua các model để thử
    const response = await generateContentWithFallback({
      contents: 'Ping',
      apiKey: customKey.trim(),
    });

    if (response && response.text) {
      return res.json({ success: true, message: 'Kết nối Google Gemini thành công!' });
    }
    return res.json({ success: true, message: 'API Key hợp lệ và sẵn sàng sử dụng!' });
  } catch (err: any) {
    console.warn('[Server AI] Test API Key failed:', err.message || err);
    let readableError = 'API Key không hợp lệ hoặc đã hết hạn mức.';
    try {
      const parsed = JSON.parse(err.message);
      readableError = parsed?.error?.message || readableError;
    } catch {
      readableError = err.message || readableError;
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
    const { images } = req.body;
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

      parts.push({
        text: `Bạn là chuyên gia phân loại thư viện sách tiếng Việt và quốc tế.
Hãy đọc kỹ tất cả văn bản trong các ảnh này (chứa gáy sách, bìa sách hoặc trang xi-nhê phụ) và bóc tách danh sách các cuốn sách riêng biệt xuất hiện trong ảnh.
Đối với mỗi cuốn sách, trích xuất chuẩn xác các trường:
- title: Tên sách (BẮT BUỘC: Đối với sách tiếng Việt thì ghi tên tiếng Việt chuẩn có dấu. Đối với sách NGOẠI VĂN như tiếng Trung, Nhật, Hàn, Anh, Pháp...: BẮT BUỘC GIỮ NGUYÊN TÊN CHỮ TƯỢNG HÌNH/CHỮ GỐC IN TRÊN BÌA SÁCH kèm theo tên dịch tiếng Việt trong ngoặc đơn, ví dụ: "活着 (Phải Sống)", "Norwegian Wood (Rừng Na Uy)", "Atomic Habits (Thay Đổi Tí Hon Bất Phá Bản Thân)". TUYỆT ĐỐI KHÔNG dùng phiên âm Alphabet/Pinyin như KHÔNG viết "Huozhe (Phải Sống)").
- author: Tác giả (BẮT BUỘC: Dịch hoặc dùng tên Hán-Việt/phiên dịch tiếng Việt chuẩn nếu có, ví dụ: "Dư Hoa" thay vì "余华" hay "Yu Hua", "Khổng Tử", "Haruki Murakami", "Plato". Nếu không rõ ghi "Khuyết danh")
- publisher: Nhà xuất bản / Công ty phát hành (ví dụ: NXB Trẻ, Nhã Nam, Kim Đồng, NXB Phụ Nữ, NXB Văn Học...)
- publish_year: Năm xuất bản (số nguyên 4 chữ số nếu thấy, hoặc ước lượng phù hợp nếu rõ ràng, nếu không để null)
- category: Thể loại sách tiếng Việt (ví dụ: Văn học, Kinh tế - Đầu tư, Lịch sử, Kỹ năng sống, Tâm lý học, Khoa học, Triết học, Thiếu nhi...)

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

    // Nếu gửi từ 2 ảnh trở lên, chia song song 2 luồng Engine 3.5 & Engine 3.1
    if (images.length >= 2) {
      const mid = Math.ceil(images.length / 2);
      const chunkA = images.slice(0, mid);
      const chunkB = images.slice(mid);

      console.log(`[Server AI] Executing parallel dual-engine scan: ${chunkA.length} images on Engine A, ${chunkB.length} images on Engine B`);
      const [resA, resB] = await Promise.all([
        processImageChunk(chunkA, 'gemini-3.5-flash-lite').catch(() => []),
        processImageChunk(chunkB, 'gemini-3.1-flash-lite').catch(() => []),
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
    const { title, author, publisher } = req.body;
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
    const { books } = req.body;
    if (!books || !Array.isArray(books) || books.length === 0) {
      return res.status(400).json({ error: 'Không có danh sách sách để chuẩn hóa.' });
    }

    const apiKey = (req.headers['x-gemini-api-key'] || req.body?.apiKey) as string | undefined;

    const processNormalizeChunk = async (chunkBooks: any[], preferredModel?: string) => {
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
        preferredModel,
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

    // Nếu từ 4 sách trở lên, chia song song 2 luồng Engine 3.5 & Engine 3.1
    if (books.length >= 4) {
      const mid = Math.ceil(books.length / 2);
      const chunkA = books.slice(0, mid);
      const chunkB = books.slice(mid);

      console.log(`[Server AI] Executing parallel batch normalize: ${chunkA.length} books on Engine A, ${chunkB.length} books on Engine B`);
      const [resA, resB] = await Promise.all([
        processNormalizeChunk(chunkA, 'gemini-3.5-flash-lite').catch(() => []),
        processNormalizeChunk(chunkB, 'gemini-3.1-flash-lite').catch(() => []),
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
