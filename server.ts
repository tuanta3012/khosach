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

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
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

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
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

// API: Proxy Check App Update to bypass browser CORS / localized ISP blocks
app.get('/api/app-update/check', async (req, res) => {
  const SOURCES = [
    {
      name: 'GitHub Raw (main)',
      url: 'https://raw.githubusercontent.com/tuanta3012/khosach/main/version.json',
      isApi: false
    },
    {
      name: 'GitHub Raw (refs/heads/main)',
      url: 'https://raw.githubusercontent.com/tuanta3012/khosach/refs/heads/main/version.json',
      isApi: false
    },
    {
      name: 'jsDelivr CDN',
      url: 'https://cdn.jsdelivr.net/gh/tuanta3012/khosach@main/version.json',
      isApi: false
    },
    {
      name: 'GitHub API',
      url: 'https://api.github.com/repos/tuanta3012/khosach/contents/version.json',
      isApi: true
    }
  ];

  for (const src of SOURCES) {
    try {
      const cacheBustUrl = `${src.url}?t=${Date.now()}`;
      console.log(`[Server UpdateCheck] Fetching from ${src.name}: ${cacheBustUrl}`);
      
      const response = await fetch(cacheBustUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'aistudio-build-updater'
        }
      });

      if (response.ok) {
        const jsonResult = await response.json();
        let data: any = null;

        if (src.isApi) {
          if (jsonResult.content && jsonResult.encoding === 'base64') {
            const decodedStr = Buffer.from(jsonResult.content, 'base64').toString('utf8');
            data = JSON.parse(decodedStr);
          }
        } else {
          data = jsonResult;
        }

        if (data && data.version) {
          console.log(`[Server UpdateCheck] Successfully fetched version ${data.version} from ${src.name}`);
          return res.json({
            success: true,
            version: data.version.trim(),
            notes: data.notes || '',
            apkUrl: data.apkUrl || ''
          });
        }
      } else {
        console.warn(`[Server UpdateCheck] Source ${src.name} returned HTTP ${response.status}`);
      }
    } catch (err: any) {
      console.error(`[Server UpdateCheck] Error fetching from ${src.name}:`, err.message || err);
    }
  }

  return res.status(502).json({
    success: false,
    error: 'Không thể kết nối đến tất cả các máy chủ cập nhật của GitHub.'
  });
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
