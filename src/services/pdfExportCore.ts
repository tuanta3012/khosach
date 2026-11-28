import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb } from 'pdf-lib';
import * as fontkitNamespace from '@pdf-lib/fontkit';
import {
  BookExportProgress,
  ParsedPdfData,
  PdfChapterInfo,
  PdfExtractedAsset,
  PdfTranslatedBlock,
} from '../types';

export interface PdfExportDrawable {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
}

export interface PdfExportCanvasLike {
  width: number;
  height: number;
  getContext(
    contextId: '2d',
    options?: unknown
  ): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}

export interface PdfExportRuntimeAdapter {
  createCanvas: (width: number, height: number) => PdfExportCanvasLike;
  canvasToJpegBlob: (canvas: PdfExportCanvasLike, quality: number) => Promise<Blob>;
  decodeAssetToDrawable: (asset: PdfExtractedAsset) => Promise<PdfExportDrawable | null>;
  yieldPage: (pageNumber: number) => Promise<void>;
  isWorker?: boolean;
}

export interface PdfExportCoreInput {
  parsedPdf: ParsedPdfData;
  translatedPages: Record<number, PdfTranslatedBlock[]>;
  translatedTitle: string;
  adapter: PdfExportRuntimeAdapter;
  onProgress?: (progress: BookExportProgress) => void;
  stopSignal?: { current: boolean };
}

type Pdf2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const textEncoder = new TextEncoder();

function escapeXmlPure(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(input: string): string {
  if (!input || input.indexOf('&') === -1) return input;
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    });
}

export function stripTagsToPlainTextPure(html: string): string {
  if (!html) return '';
  const spaced = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h1|h2|h3|blockquote)>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(spaced).replace(/\s+/g, ' ').trim();
}

export function parseTableRowsFromHtmlPure(
  html: string
): Array<Array<{ text: string; isHeader: boolean }>> {
  if (!html) return [];
  const rows: Array<Array<{ text: string; isHeader: boolean }>> = [];
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;

  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    const cells: Array<{ text: string; isHeader: boolean }> = [];
    cellRegex.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push({
        text: stripTagsToPlainTextPure(cellMatch[2]),
        isHeader: cellMatch[1].toLowerCase() === 'th',
      });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function mergeChapterBlocksAcrossPagesPure(
  parsedPdf: ParsedPdfData,
  translatedPages: Record<number, PdfTranslatedBlock[]>,
  chapter: PdfChapterInfo
): PdfTranslatedBlock[] {
  const merged: PdfTranslatedBlock[] = [];

  for (let p = chapter.startPage; p <= chapter.endPage; p++) {
    const pageBlocks = translatedPages[p];
    if (!pageBlocks || pageBlocks.length === 0) {
      const parsedPage = parsedPdf.pages.find((pg) => pg.pageNumber === p);
      if (parsedPage) {
        for (const b of parsedPage.blocks) {
          merged.push({
            tag: b.tag,
            html: escapeXmlPure(b.text),
          });
        }
      }
      continue;
    }

    for (let idx = 0; idx < pageBlocks.length; idx++) {
      const block = pageBlocks[idx];
      if (!block || !block.html || !block.html.trim()) continue;

      if (
        idx === 0 &&
        merged.length > 0 &&
        block.tag === 'p' &&
        merged[merged.length - 1].tag === 'p' &&
        !/\[\[PDF_IMG_/.test(block.html) &&
        !/\[\[PDF_IMG_/.test(merged[merged.length - 1].html)
      ) {
        const prevPlain = stripTagsToPlainTextPure(merged[merged.length - 1].html);
        const curPlain = stripTagsToPlainTextPure(block.html);
        const prevOpenSentence =
          prevPlain.length > 20 && !/[.!?:…"”»\])]$/.test(prevPlain);
        const curStartsLower =
          /^[a-zàáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ,;)]/.test(
            curPlain
          );
        if (prevOpenSentence && curStartsLower) {
          merged[merged.length - 1] = {
            tag: 'p',
            html: `${merged[merged.length - 1].html.trim()} ${block.html.trim()}`,
          };
          continue;
        }
      }

      merged.push(block);
    }
  }

  return merged;
}

function wrapTextToLines(ctx: Pdf2DContext, text: string, maxWidth: number): string[] {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [];

  const paragraphs = clean.split('\n');
  const out: string[] = [];

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }

    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        if (ctx.measureText(word).width > maxWidth) {
          let chunk = '';
          for (const ch of word) {
            if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
        } else {
          line = word;
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function encodePdfUtf16BeHex(str: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

/**
 * Bộ đóng gói PDF 1.4 theo luồng BlobPart:
 * - Không giữ Uint8Array của nhiều trang JPEG trong RAM JS.
 * - Không cần pdfDoc.save() sao chép toàn bộ tệp PDF thêm lần nữa trong heap.
 */
class StreamingPdfBlobBuilder {
  private parts: BlobPart[] = [];
  private offsets: number[] = [0]; // index 0 reserved, index i = byte offset of obj i
  private byteOffset = 0;
  private nextObjId = 4; // 1 = Catalog, 2 = Pages, 3 = Info
  private pageObjIds: number[] = [];

  constructor(title: string, author: string) {
    const header = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, // %PDF-1.4\n
      0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, // %binary comment\n
    ]);
    this.pushBytes(header);

    // 1 0 obj: Catalog
    this.offsets[1] = this.byteOffset;
    this.pushAscii('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    // 3 0 obj: Info
    this.offsets[3] = this.byteOffset;
    this.pushAscii(
      `3 0 obj\n<< /Title ${encodePdfUtf16BeHex(title || 'Sach')} /Author ${encodePdfUtf16BeHex(
        author || 'Khuyết danh'
      )} /Producer ${encodePdfUtf16BeHex('KhoSach Reader')} >>\nendobj\n`
    );
  }

  private pushBytes(bytes: Uint8Array): void {
    this.parts.push(bytes as unknown as BlobPart);
    this.byteOffset += bytes.byteLength;
  }

  private pushAscii(str: string): void {
    this.pushBytes(textEncoder.encode(str));
  }

  private pushBlob(blob: Blob): void {
    this.parts.push(blob);
    this.byteOffset += blob.size;
  }

  addJpegPage(jpegBlob: Blob, pixelWidth: number, pixelHeight: number): void {
    if (!jpegBlob || jpegBlob.size === 0) {
      throw new Error('Trang PDF kết xuất bị rỗng.');
    }

    const imgObjId = this.nextObjId++;
    const contentObjId = this.nextObjId++;
    const pageObjId = this.nextObjId++;

    // Image XObject
    this.offsets[imgObjId] = this.byteOffset;
    this.pushAscii(
      `${imgObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBlob.size} >>\nstream\n`
    );
    this.pushBlob(jpegBlob);
    this.pushAscii('\nendstream\nendobj\n');

    // Page Content Stream (A4 595.28 x 841.89 pt)
    const contentStr = 'q\n595.28 0 0 841.89 0 0 cm\n/Im1 Do\nQ\n';
    const contentBytes = textEncoder.encode(contentStr);
    this.offsets[contentObjId] = this.byteOffset;
    this.pushAscii(`${contentObjId} 0 obj\n<< /Length ${contentBytes.byteLength} >>\nstream\n`);
    this.pushBytes(contentBytes);
    this.pushAscii('endstream\nendobj\n');

    // Page Object
    this.offsets[pageObjId] = this.byteOffset;
    this.pushAscii(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im1 ${imgObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`
    );

    this.pageObjIds.push(pageObjId);
  }

  finalize(): Blob {
    // 2 0 obj: Pages root
    this.offsets[2] = this.byteOffset;
    const kidsList = this.pageObjIds.map((id) => `${id} 0 R`).join(' ');
    this.pushAscii(
      `2 0 obj\n<< /Type /Pages /Kids [${kidsList}] /Count ${this.pageObjIds.length} >>\nendobj\n`
    );

    const totalObjects = this.nextObjId;
    const xrefOffset = this.byteOffset;

    const xrefLines: string[] = [
      `xref\n0 ${totalObjects}\n`,
      '0000000000 65535 f \n',
    ];
    for (let id = 1; id < totalObjects; id++) {
      const off = this.offsets[id] ?? 0;
      xrefLines.push(`${String(off).padStart(10, '0')} 00000 n \n`);
    }
    this.pushAscii(xrefLines.join(''));

    this.pushAscii(
      `trailer\n<< /Size ${totalObjects} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    );

    const pdfBlob = new Blob(this.parts, { type: 'application/pdf' });

    // Dọn toàn bộ tham chiếu mảng tạm ngay lập tức
    this.parts.length = 0;
    this.offsets.length = 0;
    this.pageObjIds.length = 0;

    return pdfBlob;
  }
}

export async function exportTranslatedPdfCore({
  parsedPdf,
  translatedPages,
  translatedTitle,
  adapter,
  onProgress,
  stopSignal,
}: PdfExportCoreInput): Promise<{ blob: Blob; translatedTitle: string }> {
  const estimatedSourcePages = Math.max(
    parsedPdf.totalPages || 0,
    Object.keys(translatedPages || {}).length
  );

  // Giảm độ phân giải & tăng mức nén JPEG cho sách dày (>200 trang) để tăng tốc kết xuất và giảm RAM trên Android
  const PAGE_W =
    estimatedSourcePages > 450 ? 720 : estimatedSourcePages > 200 ? 820 : 1040;
  const S = PAGE_W / 1240;
  const PAGE_H = Math.round(1754 * S);
  const JPEG_QUALITY =
    estimatedSourcePages > 450 ? 0.62 : estimatedSourcePages > 200 ? 0.68 : 0.78;

  const px = (v: number) => Math.max(1, Math.round(v * S));
  const MARGIN_X = px(96);
  const MARGIN_TOP = px(96);
  const MARGIN_BOTTOM = px(104);
  const CONTENT_W = PAGE_W - MARGIN_X * 2;
  const totalChapters = Math.max(1, parsedPdf.chapters.length);

  onProgress?.({
    stage: 'Đang khởi tạo bộ kết xuất PDF...',
    current: 0,
    total: Math.max(1, estimatedSourcePages),
    percent: 4,
  });

  const pdfBuilder = new StreamingPdfBlobBuilder(
    translatedTitle,
    parsedPdf.bookAuthor || 'Khuyết danh'
  );

  const canvas = adapter.createCanvas(PAGE_W, PAGE_H);
  const ctx = canvas.getContext('2d', { alpha: false }) as Pdf2DContext | null;
  if (!ctx) {
    throw new Error('Không khởi tạo được bộ kết xuất PDF.');
  }

  let pageNumber = 0;
  let cursorY = MARGIN_TOP;
  let activeChapterIdx = 0;

  const checkStopped = () => {
    if (stopSignal?.current) {
      throw new Error('Đã hủy xuất file PDF.');
    }
  };

  const initBlankPage = (drawPageNumber = true) => {
    pageNumber += 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    cursorY = MARGIN_TOP;
    if (drawPageNumber && pageNumber > 1) {
      ctx.save();
      ctx.font = `400 ${px(20)}px "Noto Sans", "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'center';
      ctx.fillText(String(pageNumber - 1), PAGE_W / 2, PAGE_H - px(46));
      ctx.restore();
    }
  };

  const commitCurrentPageToPdf = async () => {
    checkStopped();
    const jpegBlob = await adapter.canvasToJpegBlob(canvas, JPEG_QUALITY);
    pdfBuilder.addJpegPage(jpegBlob, PAGE_W, PAGE_H);

    const chRatio = (activeChapterIdx + 0.5) / totalChapters;
    const pct = Math.min(82, Math.max(5, 5 + Math.round(chRatio * 77)));
    onProgress?.({
      stage: `Đang kết xuất PDF: trang ${pageNumber} (chương ${Math.min(
        totalChapters,
        activeChapterIdx + 1
      )}/${totalChapters})...`,
      current: pageNumber,
      total: Math.max(pageNumber, estimatedSourcePages),
      percent: pct,
    });

    // Nhường luồng thực sự sau mỗi trang để UI & hệ thống không bị treo
    await adapter.yieldPage(pageNumber);
  };

  const ensureSpace = async (neededHeight: number) => {
    if (cursorY + neededHeight > PAGE_H - MARGIN_BOTTOM) {
      await commitCurrentPageToPdf();
      initBlankPage(true);
    }
  };

  try {
    // 1. Trang bìa đơn giản
    initBlankPage(false);
    ctx.fillStyle = '#0f172a';
    ctx.font = `700 ${px(54)}px "Noto Serif", Georgia, serif`;
    const titleLines = wrapTextToLines(ctx, translatedTitle, CONTENT_W);
    cursorY = Math.max(px(420), Math.round(PAGE_H * 0.36));
    for (const line of titleLines) {
      ctx.fillText(line, MARGIN_X, cursorY);
      cursorY += px(72);
    }

    if (parsedPdf.bookAuthor) {
      cursorY += px(24);
      ctx.fillStyle = '#475569';
      ctx.font = `500 ${px(30)}px "Noto Sans", "Segoe UI", Roboto, sans-serif`;
      ctx.fillText(parsedPdf.bookAuthor, MARGIN_X, cursorY);
    }

    await commitCurrentPageToPdf();
    initBlankPage(true);

    // 2. Kết xuất nội dung các chương
    for (let chIdx = 0; chIdx < parsedPdf.chapters.length; chIdx++) {
      checkStopped();
      activeChapterIdx = chIdx;
      const ch = parsedPdf.chapters[chIdx];
      if (chIdx > 0 && cursorY > MARGIN_TOP + px(80)) {
        await commitCurrentPageToPdf();
        initBlankPage(true);
      }

      const chBlocks = mergeChapterBlocksAcrossPagesPure(parsedPdf, translatedPages, ch);
      const hasFirstHeading = chBlocks.some((b) => b.tag === 'h1' || b.tag === 'h2');
      const blocksToDraw: PdfTranslatedBlock[] =
        !hasFirstHeading && ch.title
          ? [{ tag: 'h1', html: ch.title }, ...chBlocks]
          : chBlocks;

      for (const block of blocksToDraw) {
        checkStopped();
        const imgRegex = /`?\[{1,2}\s*PDF_IMG_([a-zA-Z0-9_-]+)\s*\]{1,2}`?/g;
        const imgTokens = Array.from(block.html.matchAll(imgRegex));
        const textWithoutTokens = block.html.replace(imgRegex, '').trim();

        if (textWithoutTokens && block.tag !== 'figure') {
          if (block.tag === 'table') {
            const rows = parseTableRowsFromHtmlPure(textWithoutTokens);
            if (rows.length > 0) {
              const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 1);
              const colW = CONTENT_W / maxCols;
              ctx.font = `400 ${px(22)}px "Noto Sans", "Segoe UI", Roboto, sans-serif`;

              for (const row of rows) {
                const cellLineGroups = row.map((cell) => {
                  ctx.font = cell.isHeader
                    ? `700 ${px(22)}px "Noto Sans", "Segoe UI", Roboto, sans-serif`
                    : `400 ${px(22)}px "Noto Sans", "Segoe UI", Roboto, sans-serif`;
                  return wrapTextToLines(ctx, cell.text, colW - px(20));
                });
                const maxLines = cellLineGroups.reduce((m, g) => Math.max(m, g.length), 1);
                const rowH = maxLines * px(30) + px(20);
                await ensureSpace(rowH + px(6));

                for (let c = 0; c < maxCols; c++) {
                  const cell = row[c] || { text: '', isHeader: false };
                  const cx = MARGIN_X + c * colW;
                  if (cell.isHeader) {
                    ctx.fillStyle = '#f1f5f9';
                    ctx.fillRect(cx, cursorY, colW, rowH);
                  }
                  ctx.strokeStyle = '#cbd5e1';
                  ctx.lineWidth = Math.max(1, 1.5 * S);
                  ctx.strokeRect(cx, cursorY, colW, rowH);

                  ctx.fillStyle = '#0f172a';
                  ctx.font = cell.isHeader
                    ? `700 ${px(22)}px "Noto Sans", "Segoe UI", Roboto, sans-serif`
                    : `400 ${px(22)}px "Noto Sans", "Segoe UI", Roboto, sans-serif`;
                  const lines = cellLineGroups[c] || [];
                  for (let li = 0; li < lines.length; li++) {
                    ctx.fillText(lines[li], cx + px(10), cursorY + px(28) + li * px(30));
                  }
                }
                cursorY += rowH;
              }
              cursorY += px(18);
            }
          } else {
            let fontSpec = `400 ${px(27)}px "Noto Serif", Georgia, serif`;
            let lineHeight = px(42);
            let fill = '#1e293b';
            let indentLeft = 0;
            let spaceBefore = 0;
            let spaceAfter = px(18);

            if (block.tag === 'h1') {
              fontSpec = `700 ${px(40)}px "Noto Sans", "Segoe UI", Roboto, sans-serif`;
              lineHeight = px(52);
              fill = '#0f172a';
              spaceBefore = px(20);
              spaceAfter = px(22);
            } else if (block.tag === 'h2') {
              fontSpec = `700 ${px(33)}px "Noto Sans", "Segoe UI", Roboto, sans-serif`;
              lineHeight = px(44);
              fill = '#0f172a';
              spaceBefore = px(16);
              spaceAfter = px(16);
            } else if (block.tag === 'h3') {
              fontSpec = `700 ${px(29)}px "Noto Sans", "Segoe UI", Roboto, sans-serif`;
              lineHeight = px(40);
              fill = '#1e293b';
              spaceBefore = px(12);
              spaceAfter = px(12);
            } else if (block.tag === 'blockquote') {
              fontSpec = `italic ${px(26)}px "Noto Serif", Georgia, serif`;
              lineHeight = px(40);
              fill = '#334155';
              indentLeft = px(28);
            } else if (block.tag === 'pre') {
              fontSpec = `400 ${px(22)}px "Courier New", monospace`;
              lineHeight = px(32);
              fill = '#0f172a';
              indentLeft = px(18);
            } else if (block.tag === 'ul' || block.tag === 'ol') {
              indentLeft = px(24);
              spaceAfter = px(12);
            }

            let plain = stripTagsToPlainTextPure(textWithoutTokens);
            if (block.tag === 'ul' && !/^[•●▪\-–*]/.test(plain)) {
              plain = `• ${plain}`;
            }

            ctx.font = fontSpec;
            const lines = wrapTextToLines(ctx, plain, CONTENT_W - indentLeft - px(12));
            if (lines.length > 0) {
              cursorY += spaceBefore;
              if (block.tag === 'h1' || block.tag === 'h2' || block.tag === 'h3') {
                await ensureSpace(lines.length * lineHeight + px(60));
              }

              for (let li = 0; li < lines.length; li++) {
                await ensureSpace(lineHeight + px(8));
                if (block.tag === 'blockquote') {
                  ctx.fillStyle = '#0284c7';
                  ctx.fillRect(MARGIN_X + px(6), cursorY - px(24), px(5), lineHeight);
                } else if (block.tag === 'pre') {
                  ctx.fillStyle = '#f1f5f9';
                  ctx.fillRect(MARGIN_X, cursorY - px(24), CONTENT_W, lineHeight);
                }
                ctx.fillStyle = fill;
                ctx.font = fontSpec;
                ctx.fillText(lines[li], MARGIN_X + indentLeft, cursorY);
                cursorY += lineHeight;
              }
              cursorY += spaceAfter;
            }
          }
        }

        // Vẽ ảnh nhúng nếu có và giải phóng ImageBitmap ngay sau khi vẽ
        for (const match of imgTokens) {
          const asset = parsedPdf.assets?.[match[1]];
          if (!asset) continue;
          const drawable = await adapter.decodeAssetToDrawable(asset);
          if (!drawable) continue;

          try {
            const maxImgW = CONTENT_W;
            const maxImgH = Math.round((PAGE_H - MARGIN_TOP - MARGIN_BOTTOM) * 0.72);
            const scale = Math.min(
              1.45 * S,
              maxImgW / Math.max(1, drawable.width),
              maxImgH / Math.max(1, drawable.height)
            );
            const drawW = Math.max(1, Math.round(drawable.width * scale));
            const drawH = Math.max(1, Math.round(drawable.height * scale));

            await ensureSpace(drawH + px(28));
            const drawX = MARGIN_X + Math.round((CONTENT_W - drawW) / 2);
            ctx.drawImage(drawable.source, drawX, cursorY, drawW, drawH);
            cursorY += drawH + px(22);
          } finally {
            drawable.dispose();
          }
        }
      }
    }

    await commitCurrentPageToPdf();

    onProgress?.({
      stage: `Đang hoàn tất tệp PDF (${pageNumber} trang)...`,
      current: pageNumber,
      total: pageNumber,
      percent: 85,
    });
    await adapter.yieldPage(pageNumber);

    const blob = pdfBuilder.finalize();
    return { blob, translatedTitle };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export interface PdfDigitalExportCoreInput {
  parsedPdf: ParsedPdfData;
  translatedPages: Record<number, PdfTranslatedBlock[]>;
  translatedTitle: string;
  fontRegularBytes: Uint8Array;
  fontBoldBytes: Uint8Array;
  adapter: PdfExportRuntimeAdapter;
  onProgress?: (progress: BookExportProgress) => void;
  stopSignal?: { current: boolean };
}

function resolveFontkitInstance(): Parameters<PDFDocument['registerFontkit']>[0] {
  const mod = fontkitNamespace as unknown as {
    default?: Parameters<PDFDocument['registerFontkit']>[0];
  };
  return (mod.default || fontkitNamespace) as unknown as Parameters<
    PDFDocument['registerFontkit']
  >[0];
}

function sanitizeTextForEmbeddedFont(text: string, charSet: Set<number>): string {
  if (!text) return '';
  const normalized = text
    .normalize('NFC')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '');
  let out = '';
  for (const ch of normalized) {
    if (ch === '\n') {
      out += '\n';
      continue;
    }
    if (ch === '\t') {
      out += ' ';
      continue;
    }
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp < 32) continue;
    if (charSet.has(cp)) {
      out += ch;
    } else if (cp === 0x2022 || cp === 0x25cf || cp === 0x25aa) {
      out += charSet.has(0x2022) ? '\u2022' : '-';
    } else if (cp >= 0x2018 && cp <= 0x201f) {
      out += '"';
    } else if (cp === 0x2013 || cp === 0x2014) {
      out += '-';
    } else {
      out += ' ';
    }
  }
  return out;
}

function wrapVectorTextToLines(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
  charSet: Set<number>
): string[] {
  const safe = sanitizeTextForEmbeddedFont(text, charSet).trim();
  if (!safe) return [];

  const paragraphs = safe.split('\n');
  const out: string[] = [];

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }

    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        if (font.widthOfTextAtSize(word, fontSize) > maxWidth) {
          let chunk = '';
          for (const ch of word) {
            if (font.widthOfTextAtSize(chunk + ch, fontSize) > maxWidth && chunk) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
        } else {
          line = word;
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function isPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function isJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Kết xuất PDF chuẩn Digital (chữ vector Unicode tiếng Việt có thể bôi đen, sao chép, tìm kiếm)
 * kèm hình ảnh nhúng sắc nét, dung lượng nhẹ.
 */
export async function exportTranslatedDigitalPdfCore({
  parsedPdf,
  translatedPages,
  translatedTitle,
  fontRegularBytes,
  fontBoldBytes,
  adapter,
  onProgress,
  stopSignal,
}: PdfDigitalExportCoreInput): Promise<{ blob: Blob; translatedTitle: string }> {
  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const MARGIN_X = 48;
  const MARGIN_TOP = 54;
  const MARGIN_BOTTOM = 52;
  const CONTENT_W = PAGE_W - MARGIN_X * 2;
  const totalChapters = Math.max(1, parsedPdf.chapters.length);
  const estimatedSourcePages = Math.max(
    parsedPdf.totalPages || 0,
    Object.keys(translatedPages || {}).length,
    1
  );

  const checkStopped = () => {
    if (stopSignal?.current) {
      throw new Error('Đã hủy xuất file PDF.');
    }
  };

  onProgress?.({
    stage: 'Đang nạp phông chữ tiếng Việt vào PDF...',
    current: 0,
    total: estimatedSourcePages,
    percent: 4,
  });

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(resolveFontkitInstance());
  pdfDoc.setTitle(translatedTitle || 'Sach');
  pdfDoc.setAuthor(parsedPdf.bookAuthor || 'Khuyết danh');
  pdfDoc.setProducer('KhoSach Reader');

  const regFont = await pdfDoc.embedFont(fontRegularBytes, { subset: true });
  const boldFont = await pdfDoc.embedFont(fontBoldBytes, { subset: true });
  const regCharSet = new Set<number>(regFont.getCharacterSet());
  const boldCharSet = new Set<number>(boldFont.getCharacterSet());

  const embeddedImages = new Map<string, PDFImage | null>();
  const embedAssetImage = async (asset: PdfExtractedAsset): Promise<PDFImage | null> => {
    if (embeddedImages.has(asset.assetId)) {
      return embeddedImages.get(asset.assetId) || null;
    }

    let img: PDFImage | null = null;
    try {
      if (isPngSignature(asset.data) || asset.mimeType === 'image/png') {
        try {
          img = await pdfDoc.embedPng(asset.data);
        } catch {
          img = null;
        }
      }
      if (!img && (isJpegSignature(asset.data) || asset.mimeType === 'image/jpeg')) {
        try {
          img = await pdfDoc.embedJpg(asset.data);
        } catch {
          img = null;
        }
      }
      if (!img) {
        const drawable = await adapter.decodeAssetToDrawable(asset);
        if (drawable) {
          const tmpCanvas = adapter.createCanvas(
            Math.max(1, drawable.width),
            Math.max(1, drawable.height)
          );
          try {
            const cctx = tmpCanvas.getContext('2d', { alpha: false });
            if (cctx) {
              cctx.fillStyle = '#ffffff';
              cctx.fillRect(0, 0, tmpCanvas.width, tmpCanvas.height);
              cctx.drawImage(drawable.source, 0, 0, tmpCanvas.width, tmpCanvas.height);
              const jpgBlob = await adapter.canvasToJpegBlob(tmpCanvas, 0.88);
              const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
              img = await pdfDoc.embedJpg(jpgBytes);
            }
          } finally {
            drawable.dispose();
            tmpCanvas.width = 0;
            tmpCanvas.height = 0;
          }
        }
      }
    } catch {
      img = null;
    }

    embeddedImages.set(asset.assetId, img);
    return img;
  };

  let pageCount = 0;
  let currentPage: PDFPage = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let cursorY = PAGE_H - MARGIN_TOP;
  let activeChapterIdx = 0;

  const startNewPage = async (drawPageNumber = true) => {
    checkStopped();
    pageCount += 1;
    currentPage = pdfDoc.addPage([PAGE_W, PAGE_H]);
    cursorY = PAGE_H - MARGIN_TOP;

    if (drawPageNumber && pageCount > 1) {
      const label = String(pageCount - 1);
      const labelSize = 9.5;
      const w = regFont.widthOfTextAtSize(label, labelSize);
      currentPage.drawText(label, {
        x: (PAGE_W - w) / 2,
        y: 26,
        size: labelSize,
        font: regFont,
        color: rgb(0.39, 0.45, 0.55),
      });
    }

    if (pageCount % 4 === 0) {
      const chRatio = (activeChapterIdx + 0.5) / totalChapters;
      const pct = Math.min(82, Math.max(5, 5 + Math.round(chRatio * 77)));
      onProgress?.({
        stage: `Đang tạo PDF văn bản: trang ${pageCount} (chương ${Math.min(
          totalChapters,
          activeChapterIdx + 1
        )}/${totalChapters})...`,
        current: pageCount,
        total: Math.max(pageCount, estimatedSourcePages),
        percent: pct,
      });
      await adapter.yieldPage(pageCount);
    }
  };

  const ensureSpace = async (neededHeight: number) => {
    if (cursorY - neededHeight < MARGIN_BOTTOM) {
      await startNewPage(true);
    }
  };

  // 1. Trang bìa (dùng chính trang đầu vừa tạo)
  pageCount = 1;
  cursorY = Math.round(PAGE_H * 0.66);
  const titleLines = wrapVectorTextToLines(
    translatedTitle || 'Sách',
    boldFont,
    24,
    CONTENT_W,
    boldCharSet
  );
  for (const line of titleLines) {
    currentPage.drawText(line, {
      x: MARGIN_X,
      y: cursorY,
      size: 24,
      font: boldFont,
      color: rgb(0.06, 0.09, 0.16),
    });
    cursorY -= 33;
  }

  if (parsedPdf.bookAuthor) {
    cursorY -= 10;
    const authorLines = wrapVectorTextToLines(
      parsedPdf.bookAuthor,
      regFont,
      13.5,
      CONTENT_W,
      regCharSet
    );
    for (const line of authorLines) {
      currentPage.drawText(line, {
        x: MARGIN_X,
        y: cursorY,
        size: 13.5,
        font: regFont,
        color: rgb(0.28, 0.33, 0.41),
      });
      cursorY -= 20;
    }
  }

  await startNewPage(true);

  // 2. Nội dung từng chương
  for (let chIdx = 0; chIdx < parsedPdf.chapters.length; chIdx++) {
    checkStopped();
    activeChapterIdx = chIdx;
    const ch = parsedPdf.chapters[chIdx];

    if (chIdx > 0 && cursorY < PAGE_H - MARGIN_TOP - 40) {
      await startNewPage(true);
    }

    const chBlocks = mergeChapterBlocksAcrossPagesPure(parsedPdf, translatedPages, ch);
    const hasFirstHeading = chBlocks.some((b) => b.tag === 'h1' || b.tag === 'h2');
    const blocksToDraw: PdfTranslatedBlock[] =
      !hasFirstHeading && ch.title
        ? [{ tag: 'h1', html: ch.title }, ...chBlocks]
        : chBlocks;

    for (const block of blocksToDraw) {
      checkStopped();
      const imgRegex = /`?\[{1,2}\s*PDF_IMG_([a-zA-Z0-9_-]+)\s*\]{1,2}`?/g;
      const imgTokens = Array.from(block.html.matchAll(imgRegex));
      const textWithoutTokens = block.html.replace(imgRegex, '').trim();

      if (textWithoutTokens && block.tag !== 'figure') {
        if (block.tag === 'table') {
          const rows = parseTableRowsFromHtmlPure(textWithoutTokens);
          if (rows.length > 0) {
            const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 1);
            const colW = CONTENT_W / maxCols;
            const cellFontSize = 9.5;
            const cellLineH = 13.5;

            for (const row of rows) {
              const cellLineGroups = row.map((cell) => {
                const f = cell.isHeader ? boldFont : regFont;
                const cs = cell.isHeader ? boldCharSet : regCharSet;
                return wrapVectorTextToLines(cell.text, f, cellFontSize, colW - 10, cs);
              });
              const maxLines = cellLineGroups.reduce((m, g) => Math.max(m, g.length), 1);
              const rowH = maxLines * cellLineH + 10;
              await ensureSpace(rowH + 4);

              const rowTopY = cursorY;
              for (let c = 0; c < maxCols; c++) {
                const cell = row[c] || { text: '', isHeader: false };
                const cx = MARGIN_X + c * colW;
                currentPage.drawRectangle({
                  x: cx,
                  y: rowTopY - rowH,
                  width: colW,
                  height: rowH,
                  color: cell.isHeader ? rgb(0.95, 0.96, 0.98) : undefined,
                  borderColor: rgb(0.8, 0.84, 0.88),
                  borderWidth: 0.75,
                });

                const f = cell.isHeader ? boldFont : regFont;
                const lines = cellLineGroups[c] || [];
                for (let li = 0; li < lines.length; li++) {
                  currentPage.drawText(lines[li], {
                    x: cx + 5,
                    y: rowTopY - 13 - li * cellLineH,
                    size: cellFontSize,
                    font: f,
                    color: rgb(0.06, 0.09, 0.16),
                  });
                }
              }
              cursorY -= rowH;
            }
            cursorY -= 8;
          }
        } else {
          let font: PDFFont = regFont;
          let charSet = regCharSet;
          let fontSize = 11.5;
          let lineHeight = 17.5;
          let color = rgb(0.12, 0.16, 0.23);
          let indentLeft = 0;
          let spaceBefore = 0;
          let spaceAfter = 7;

          if (block.tag === 'h1') {
            font = boldFont;
            charSet = boldCharSet;
            fontSize = 18;
            lineHeight = 25;
            color = rgb(0.06, 0.09, 0.16);
            spaceBefore = 8;
            spaceAfter = 10;
          } else if (block.tag === 'h2') {
            font = boldFont;
            charSet = boldCharSet;
            fontSize = 15;
            lineHeight = 21;
            color = rgb(0.06, 0.09, 0.16);
            spaceBefore = 6;
            spaceAfter = 8;
          } else if (block.tag === 'h3') {
            font = boldFont;
            charSet = boldCharSet;
            fontSize = 13;
            lineHeight = 18;
            color = rgb(0.12, 0.16, 0.23);
            spaceBefore = 5;
            spaceAfter = 6;
          } else if (block.tag === 'blockquote') {
            fontSize = 11;
            lineHeight = 16.5;
            color = rgb(0.2, 0.25, 0.33);
            indentLeft = 14;
          } else if (block.tag === 'pre') {
            fontSize = 9.5;
            lineHeight = 14;
            color = rgb(0.06, 0.09, 0.16);
            indentLeft = 8;
          } else if (block.tag === 'ul' || block.tag === 'ol') {
            indentLeft = 14;
            spaceAfter = 5;
          }

          let plain = stripTagsToPlainTextPure(textWithoutTokens);
          if (block.tag === 'ul' && !/^[•●▪\-–*]/.test(plain)) {
            plain = `• ${plain}`;
          }

          const lines = wrapVectorTextToLines(
            plain,
            font,
            fontSize,
            CONTENT_W - indentLeft - 4,
            charSet
          );

          if (lines.length > 0) {
            cursorY -= spaceBefore;
            if (block.tag === 'h1' || block.tag === 'h2' || block.tag === 'h3') {
              await ensureSpace(lines.length * lineHeight + 24);
            }

            for (let li = 0; li < lines.length; li++) {
              await ensureSpace(lineHeight + 2);
              const baselineY = cursorY - fontSize;

              if (block.tag === 'blockquote') {
                currentPage.drawRectangle({
                  x: MARGIN_X + 3,
                  y: baselineY - 3,
                  width: 2.5,
                  height: lineHeight,
                  color: rgb(0.01, 0.52, 0.78),
                });
              } else if (block.tag === 'pre') {
                currentPage.drawRectangle({
                  x: MARGIN_X,
                  y: baselineY - 3,
                  width: CONTENT_W,
                  height: lineHeight,
                  color: rgb(0.95, 0.96, 0.98),
                });
              }

              currentPage.drawText(lines[li], {
                x: MARGIN_X + indentLeft,
                y: baselineY,
                size: fontSize,
                font,
                color,
              });
              cursorY -= lineHeight;
            }
            cursorY -= spaceAfter;
          }
        }
      }

      // Nhúng ảnh minh họa vector/raster gốc giữ nguyên độ sắc nét
      for (const match of imgTokens) {
        const asset = parsedPdf.assets?.[match[1]];
        if (!asset) continue;
        const pdfImg = await embedAssetImage(asset);
        if (!pdfImg) continue;

        const imgW = Math.max(1, pdfImg.width || asset.width);
        const imgH = Math.max(1, pdfImg.height || asset.height);
        const maxImgW = CONTENT_W;
        const maxImgH = (PAGE_H - MARGIN_TOP - MARGIN_BOTTOM) * 0.72;
        const scale = Math.min(1, maxImgW / imgW, maxImgH / imgH);
        const drawW = Math.max(1, imgW * scale);
        const drawH = Math.max(1, imgH * scale);

        await ensureSpace(drawH + 14);
        const drawX = MARGIN_X + (CONTENT_W - drawW) / 2;
        currentPage.drawImage(pdfImg, {
          x: drawX,
          y: cursorY - drawH,
          width: drawW,
          height: drawH,
        });
        cursorY -= drawH + 12;
      }
    }
  }

  onProgress?.({
    stage: `Đang đóng gói tệp PDF (${pageCount} trang)...`,
    current: pageCount,
    total: pageCount,
    percent: 85,
  });
  await adapter.yieldPage(pageCount);

  const savedBytes = await pdfDoc.save({ useObjectStreams: true });
  const blob = new Blob([new Uint8Array(savedBytes)], { type: 'application/pdf' });
  return { blob, translatedTitle };
}
