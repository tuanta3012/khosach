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

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

async function generateContentWithFallback(params: { contents: any; config?: any }) {
  const primaryModel = 'gemini-3.5-flash-lite';
  const fallbackModel = 'gemini-3.1-flash-lite';

  try {
    console.log(`[Server AI] Attempting primary model: ${primaryModel}`);
    return await ai.models.generateContent({
      model: primaryModel,
      ...params,
    });
  } catch (err: any) {
    console.warn(`[Server AI] Primary model ${primaryModel} failed. Falling back to ${fallbackModel}. Error:`, err.message || err);
    return await ai.models.generateContent({
      model: fallbackModel,
      ...params,
    });
  }
}

// API: Batch OCR & Book Extraction from images (Gemini 2.5 Flash / Flash Latest)
app.post('/api/books/scan-images', async (req, res) => {
  try {
    const { images } = req.body;
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Không có ảnh nào được gửi lên để phân tích.' });
    }

    const parts: any[] = [];
    for (const imgBase64 of images) {
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
- title: Tên sách (bắt buộc, viết hoa chuẩn)
- author: Tác giả (bắt buộc, nếu không rõ ghi "Nhiều tác giả" hoặc "Khuyết danh")
- publisher: Nhà xuất bản / Công ty phát hành (ví dụ: NXB Trẻ, Nhã Nam, Kim Đồng, NXB Phụ Nữ, NXB Văn Học...)
- publish_year: Năm xuất bản (số nguyên 4 chữ số nếu thấy, hoặc ước lượng phù hợp nếu rõ ràng, nếu không để null)
- category: Thể loại sách tiếng Việt (ví dụ: Văn học, Kinh tế - Đầu tư, Lịch sử, Kỹ năng sống, Tâm lý học, Khoa học, Triết học, Thiếu nhi...)

Trả về mảng JSON chứa các sách bóc tách được.`,
    });

    const response = await generateContentWithFallback({
      contents: { parts },
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
    const books = JSON.parse(textOutput);
    return res.json({ success: true, count: books.length, books });
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
- title: Tên sách chuẩn có dấu đầy đủ
- author: Tác giả chuẩn
- publisher: Nhà xuất bản uy tín
- publish_year: Năm phát hành bản in phổ biến
- category: Thể loại chuẩn (Văn học, Kinh tế, Lịch sử, Tâm lý, Khoa học...)
- summary: Tóm tắt 1-2 câu nội dung cuốn sách`;

    const response = await generateContentWithFallback({
      contents: prompt,
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

// API: Batch Normalize book metadata using Gemini 2.5 Flash Lite
app.post('/api/books/batch-normalize', async (req, res) => {
  try {
    const { books } = req.body;
    if (!books || !Array.isArray(books) || books.length === 0) {
      return res.status(400).json({ error: 'Không có danh sách sách để chuẩn hóa.' });
    }

    const prompt = `Bạn là biên tập viên thư viện sách chuyên nghiệp. 
Hãy sửa lỗi chính tả, sửa tiếng Việt không dấu thành có dấu chuẩn xác, viết hoa chữ cái đầu đúng quy tắc tiếng Việt/quốc tế cho danh sách các cuốn sách sau đây. 
Nếu thông tin tác giả chưa đúng hoặc thiếu dấu, hãy tự động sửa lại chính xác (ví dụ: "nguyen nhat anh" -> "Nguyễn Nhật Ánh"). 
Nếu nhà xuất bản viết tắt hoặc thiếu dấu, hãy điền đầy đủ (ví dụ: "nxb tre" -> "NXB Trẻ", "nha nam" -> "Nhã Nam", "nxb kim dong" -> "NXB Kim Đồng").
Nếu thể loại chưa chuẩn, hãy phân loại và đưa về các thể loại chuẩn tiếng Việt phù hợp (như: Văn học, Kinh tế, Lịch sử, Tâm lý học, Khoa học, Thiếu nhi, Kỹ năng sống, Triết học, Mỹ thuật...).

Dưới đây là danh sách sách dạng JSON cần chuẩn hóa:
${JSON.stringify(books)}

Hãy trả về một mảng JSON mới có cấu trúc tương ứng, giữ nguyên trường "id" của từng cuốn sách, và bổ sung thuộc tính "is_ai_normalized": true cho tất cả sách đã chuẩn hóa thành công.`;

    const response = await generateContentWithFallback({
      contents: prompt,
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
    return res.json({ success: true, normalized: output });
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
        signal: AbortSignal.timeout(20000), // Timeout 20 giây
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
