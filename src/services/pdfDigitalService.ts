import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import JSZip from 'jszip';
import {
  BookExportProgress,
  ParsedPdfData,
  PdfBlockTag,
  PdfChapterInfo,
  PdfExportRenderMode,
  PdfExtractedAsset,
  PdfFigureBox,
  PdfParsedPage,
  PdfProcessingMode,
  PdfTranslatedBlock,
  PdfTranslationUnit,
} from '../types';
import { appendVnSuffix } from './epubService';
import {
  cropFiguresFromPage,
  evaluateHybridVisionNeeded,
  parseDigitalPdfCore,
  PdfCanvasLike,
  PdfParserRuntimeAdapter,
  yieldToEventLoopFast,
} from './pdfDigitalParserCore';
import {
  exportTranslatedDigitalPdfCore,
  exportTranslatedPdfCore,
  PdfExportCanvasLike,
  PdfExportDrawable,
  PdfExportRuntimeAdapter,
} from './pdfExportCore';
import type { PdfWorkerRequest, PdfWorkerResponse } from '../workers/pdfDigitalWorker';
import type {
  PdfExportWorkerRequest,
  PdfExportWorkerResponse,
} from '../workers/pdfExportWorker';
import {
  acquireBackgroundKeepAlive,
  releaseBackgroundKeepAlive,
} from '../utils/wakeLockService';

export { evaluateHybridVisionNeeded };

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  pdfWorkerUrl,
  window.location.href
).toString();

const MAX_TEXT_CHUNK_CHARS = 3400;
const MAX_TEXT_CHUNK_BLOCKS = 32;
const MAX_TEXT_CHUNK_PAGES = 5;

function yieldToEventLoop(): Promise<void> {
  return yieldToEventLoopFast(true);
}

function escapeXml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function canvasToJpegBytes(canvas: HTMLCanvasElement, quality = 0.86): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Không xuất được ảnh từ canvas.'))),
      'image/jpeg',
      quality
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export const mainThreadAdapter: PdfParserRuntimeAdapter = {
  createCanvas: (width: number, height: number): PdfCanvasLike => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as PdfCanvasLike;
  },
  canvasToJpegBytes: (canvas: PdfCanvasLike, quality = 0.86) =>
    canvasToJpegBytes(canvas as unknown as HTMLCanvasElement, quality),
  pageYieldMs: 0,
};

let nextWorkerJobId = 1;

class WorkerFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerFallbackError';
  }
}

async function parseDigitalPdfInWorker(
  arrayBuffer: ArrayBuffer,
  fileName: string,
  onProgress?: (currentPage: number, totalPages: number) => void,
  stopSignal?: { current: boolean }
): Promise<ParsedPdfData> {
  const worker = new Worker(
    new URL('../workers/pdfDigitalWorker.ts', import.meta.url),
    { type: 'module' }
  );
  const jobId = nextWorkerJobId++;

  return new Promise<ParsedPdfData>((resolve, reject) => {
    let settled = false;

    const cleanup = (stopWatch: ReturnType<typeof setInterval>) => {
      clearInterval(stopWatch);
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {}
    };

    const stopWatch = setInterval(() => {
      if (stopSignal?.current && !settled) {
        settled = true;
        try {
          const cancelMsg: PdfWorkerRequest = { type: 'cancel', id: jobId };
          worker.postMessage(cancelMsg);
        } catch {}
        cleanup(stopWatch);
        reject(new Error('Đã hủy tách trang theo yêu cầu.'));
      }
    }, 100);

    worker.onmessage = (event: MessageEvent<PdfWorkerResponse>) => {
      const msg = event.data;
      if (!msg || msg.id !== jobId || settled) return;

      if (msg.type === 'progress') {
        if (onProgress) onProgress(msg.currentPage, msg.totalPages);
        return;
      }

      if (msg.type === 'done') {
        settled = true;
        cleanup(stopWatch);
        resolve(msg.result);
        return;
      }

      if (msg.type === 'error') {
        settled = true;
        cleanup(stopWatch);
        if (msg.canFallbackToMainThread && !stopSignal?.current) {
          reject(new WorkerFallbackError(msg.message));
        } else {
          reject(new Error(msg.message));
        }
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      if (settled) return;
      settled = true;
      cleanup(stopWatch);
      if (!stopSignal?.current) {
        reject(new WorkerFallbackError(err?.message || 'Không khởi chạy được PDF Worker.'));
      } else {
        reject(new Error(err?.message || 'Lỗi xử lý PDF trong Worker.'));
      }
    };

    if (stopSignal?.current) {
      settled = true;
      cleanup(stopWatch);
      reject(new Error('Đã hủy tách trang theo yêu cầu.'));
      return;
    }

    // Tạo bản sao riêng để Transferable không làm rỗng epubBuffer gốc lưu xuống IndexedDB
    const transferableBuffer = arrayBuffer.slice(0);
    const req: PdfWorkerRequest = {
      type: 'parse',
      id: jobId,
      buffer: transferableBuffer,
      fileName,
    };
    worker.postMessage(req, [transferableBuffer]);
  });
}

export async function parseDigitalPdfFile(
  arrayBuffer: ArrayBuffer,
  fileName: string,
  onProgress?: (currentPage: number, totalPages: number) => void,
  stopSignal?: { current: boolean }
): Promise<ParsedPdfData> {
  await acquireBackgroundKeepAlive();
  try {
    const canUseOffscreenWorker =
      typeof Worker !== 'undefined' &&
      typeof OffscreenCanvas !== 'undefined' &&
      typeof OffscreenCanvas.prototype.convertToBlob === 'function';

    if (canUseOffscreenWorker) {
      try {
        return await parseDigitalPdfInWorker(arrayBuffer, fileName, onProgress, stopSignal);
      } catch (err) {
        if (stopSignal?.current || !(err instanceof WorkerFallbackError)) {
          throw err;
        }
        console.warn('[PdfDigital] Worker khởi tạo thất bại, tự động fallback về main thread:', err.message);
      }
    }

    return await parseDigitalPdfCore(arrayBuffer, fileName, mainThreadAdapter, onProgress, stopSignal);
  } finally {
    await releaseBackgroundKeepAlive();
  }
}

export function buildPdfTranslationUnits(
  parsedPdf: ParsedPdfData,
  mode: PdfProcessingMode = 'auto'
): PdfTranslationUnit[] {
  const units: PdfTranslationUnit[] = [];
  let textPageNumbers: number[] = [];
  let textChars = 0;
  let textBlockCount = 0;
  let currentChapterIndex = -1;

  const flushTextChunk = () => {
    if (textPageNumbers.length === 0) return;
    units.push({
      unitIndex: units.length,
      kind: 'text-chunk',
      pageNumbers: textPageNumbers,
      totalChars: textChars,
    });
    textPageNumbers = [];
    textChars = 0;
    textBlockCount = 0;
  };

  for (const page of parsedPdf.pages) {
    // Tự động phân loại chế độ xử lý trên từng trang sách:
    // Trang có hình ảnh/sơ đồ, bảng biểu, đa cột, code, công thức hoặc chữ ngắn -> AI Vision
    // Trang chữ văn xuôi liên tục dài không hình/bảng -> Tách chữ số hóa nhanh
    const useVision =
      mode === 'full-vision'
        ? true
        : Boolean(page.requiresVision || evaluateHybridVisionNeeded(page, parsedPdf.assets));
    const pageChars = Math.max(80, page.rawDigitalText.length);
    const nonFigureBlocks = page.blocks.filter((b) => !b.isFigure);

    // Trang trống hoàn toàn (không chữ, không ảnh) bỏ qua chunk text nếu không phải vision
    if (!useVision && nonFigureBlocks.length === 0 && page.assetIds.length === 0) {
      continue;
    }

    if (useVision) {
      flushTextChunk();
      units.push({
        unitIndex: units.length,
        kind: 'vision-page',
        pageNumbers: [page.pageNumber],
        totalChars: pageChars,
      });
      currentChapterIndex = page.chapterIndex;
      continue;
    }

    const chapterChanged =
      currentChapterIndex !== -1 && currentChapterIndex !== page.chapterIndex;
    const exceedsBudget =
      textPageNumbers.length > 0 &&
      (textChars + pageChars > MAX_TEXT_CHUNK_CHARS ||
        textBlockCount + page.blocks.length > MAX_TEXT_CHUNK_BLOCKS ||
        textPageNumbers.length >= MAX_TEXT_CHUNK_PAGES);

    if (chapterChanged || exceedsBudget) {
      flushTextChunk();
    }

    currentChapterIndex = page.chapterIndex;
    textPageNumbers.push(page.pageNumber);
    textChars += pageChars;
    textBlockCount += page.blocks.length;
  }

  flushTextChunk();

  if (units.length === 0 && parsedPdf.pages.length > 0) {
    units.push({
      unitIndex: 0,
      kind: 'vision-page',
      pageNumbers: [parsedPdf.pages[0].pageNumber],
      totalChars: 200,
    });
  }

  return units;
}

export async function renderPdfPageForVision(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number
): Promise<{ base64: string; mimeType: 'image/jpeg' }> {
  const page = await pdfDoc.getPage(pageNumber);
  const baseVp = page.getViewport({ scale: 1 });
  const targetScale = Math.min(1.75, Math.max(1.0, 1080 / Math.max(1, baseVp.width)));
  const viewport = page.getViewport({ scale: targetScale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));

  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Không khởi tạo được canvas render trang PDF.');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      annotationMode: 0,
      intent: 'print', // Bỏ qua window.requestAnimationFrame
    }).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    const commaIdx = dataUrl.indexOf(',');
    return {
      base64: commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl,
      mimeType: 'image/jpeg',
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function stripTagsToPlainText(html: string): string {
  if (!html) return '';
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  }
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeFragmentToXhtml(rawHtml: string, tag: PdfBlockTag): string {
  const trimmed = (rawHtml || '').trim();
  if (!trimmed) return '';

  if (tag === 'pre') {
    return escapeXml(stripTagsToPlainText(trimmed));
  }

  if (typeof DOMParser === 'undefined') {
    return escapeXml(trimmed);
  }

  const allowedTags = new Set([
    'b',
    'strong',
    'i',
    'em',
    'u',
    'sub',
    'sup',
    'code',
    'br',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'caption',
    'p',
    'span',
  ]);

  const doc = new DOMParser().parseFromString(`<div>${trimmed}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return escapeXml(trimmed);

  const serializeNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeXml(node.nodeValue || '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node as Element;
    const tagName = (el.tagName || '').toLowerCase();
    const childrenXml = Array.from(el.childNodes).map(serializeNode).join('');

    if (!allowedTags.has(tagName)) {
      return childrenXml;
    }

    if (tagName === 'br') {
      return '<br />';
    }

    if (tagName === 'td' || tagName === 'th') {
      const colspan = el.getAttribute('colspan');
      const rowspan = el.getAttribute('rowspan');
      let attrs = '';
      if (colspan && /^\d+$/.test(colspan)) attrs += ` colspan="${colspan}"`;
      if (rowspan && /^\d+$/.test(rowspan)) attrs += ` rowspan="${rowspan}"`;
      return `<${tagName}${attrs}>${childrenXml}</${tagName}>`;
    }

    return `<${tagName}>${childrenXml}</${tagName}>`;
  };

  return Array.from(root.childNodes).map(serializeNode).join('');
}

function mergeChapterBlocksAcrossPages(
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
            html: escapeXml(b.text),
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
        const prevPlain = stripTagsToPlainText(merged[merged.length - 1].html);
        const curPlain = stripTagsToPlainText(block.html);
        const prevOpenSentence =
          prevPlain.length > 20 && !/[.!?:…"”»\])]$/.test(prevPlain);
        const curStartsLower = /^[a-zàáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ,;)]/.test(
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

function expandImageTokensToXhtml(
  block: PdfTranslatedBlock,
  assets: Record<string, PdfExtractedAsset>
): string {
  const rawHtml = block.html.trim();
  const imgRegex = /`?\[{1,2}\s*PDF_IMG_([a-zA-Z0-9_-]+)\s*\]{1,2}`?/g;

  const renderFigureTag = (assetId: string): string => {
    const asset = assets[assetId];
    if (!asset) return '';
    return `<figure class="pdf-figure"><img src="../Images/${escapeXml(asset.fileName)}" alt="Hình ${escapeXml(assetId)}" /></figure>`;
  };

  if (block.tag === 'figure' || /^`?\[{1,2}\s*PDF_IMG_[a-zA-Z0-9_-]+\s*\]{1,2}`?$/.test(rawHtml)) {
    const matches = Array.from(rawHtml.matchAll(imgRegex));
    if (matches.length > 0) {
      return matches.map((m) => renderFigureTag(m[1])).filter(Boolean).join('\n');
    }
    return '';
  }

  // Nếu placeholder [[PDF_IMG_...]] nằm lẫn trong đoạn văn, tách ra thành <figure> độc lập để đảm bảo XHTML chuẩn
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(rawHtml)) !== null) {
    const before = rawHtml.slice(lastIndex, match.index).trim();
    if (before) {
      parts.push(wrapBlockXhtml(block.tag, before));
    }
    const fig = renderFigureTag(match[1]);
    if (fig) parts.push(fig);
    lastIndex = match.index + match[0].length;
  }

  const tail = rawHtml.slice(lastIndex).trim();
  if (tail) {
    parts.push(wrapBlockXhtml(block.tag, tail));
  }

  return parts.join('\n');
}

function wrapBlockXhtml(tag: PdfBlockTag, innerHtml: string): string {
  const safeInner = sanitizeFragmentToXhtml(innerHtml, tag);
  if (!safeInner) return '';

  switch (tag) {
    case 'h1':
      return `<h1>${safeInner}</h1>`;
    case 'h2':
      return `<h2>${safeInner}</h2>`;
    case 'h3':
      return `<h3>${safeInner}</h3>`;
    case 'blockquote':
      return `<blockquote><p>${safeInner}</p></blockquote>`;
    case 'pre':
      return `<pre><code>${safeInner}</code></pre>`;
    case 'ul': {
      if (/<li[\s>]/i.test(safeInner)) {
        return /^<ul[\s>]/i.test(safeInner) ? safeInner : `<ul>${safeInner}</ul>`;
      }
      const cleaned = safeInner.replace(/^[•●▪▫◦‣\-–—*]\s+/, '');
      return `<ul><li>${cleaned}</li></ul>`;
    }
    case 'ol': {
      if (/<li[\s>]/i.test(safeInner)) {
        return /^<ol[\s>]/i.test(safeInner) ? safeInner : `<ol>${safeInner}</ol>`;
      }
      const cleaned = safeInner.replace(/^\d{1,3}[.)]\s+/, '');
      return `<ol><li>${cleaned}</li></ol>`;
    }
    case 'table': {
      if (/<tr[\s>]/i.test(safeInner)) {
        return /^<table[\s>]/i.test(safeInner)
          ? safeInner.replace(/^<table/i, '<table class="pdf-table"')
          : `<table class="pdf-table">${safeInner}</table>`;
      }
      return `<p>${safeInner}</p>`;
    }
    case 'figure':
      return '';
    case 'p':
    default:
      return `<p>${safeInner}</p>`;
  }
}

async function extractAssetsInWorker(
  pdfBuffer: ArrayBuffer,
  pages: Array<{ pageNumber: number; figureBoxes: PdfFigureBox[] }>,
  onProgress?: (progress: BookExportProgress) => void
): Promise<Record<string, PdfExtractedAsset>> {
  const worker = new Worker(
    new URL('../workers/pdfDigitalWorker.ts', import.meta.url),
    { type: 'module' }
  );
  const jobId = nextWorkerJobId++;

  return new Promise<Record<string, PdfExtractedAsset>>((resolve, reject) => {
    let settled = false;
    let lastActivityAt = Date.now();

    const cleanup = (watchdog: ReturnType<typeof setInterval>) => {
      clearInterval(watchdog);
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {}
    };

    const watchdog = setInterval(() => {
      if (!settled && Date.now() - lastActivityAt > 45_000) {
        settled = true;
        cleanup(watchdog);
        reject(new WorkerFallbackError('Worker trích xuất ảnh bị quá thời gian chờ.'));
      }
    }, 2000);

    worker.onmessage = (event: MessageEvent<PdfWorkerResponse>) => {
      const msg = event.data;
      if (!msg || msg.id !== jobId || settled) return;
      lastActivityAt = Date.now();

      if (msg.type === 'progress') {
        const pct = 2 + Math.round((msg.currentPage / Math.max(1, msg.totalPages)) * 10);
        onProgress?.({
          stage: `Đang trích xuất hình ảnh (${msg.currentPage}/${msg.totalPages})...`,
          current: msg.currentPage,
          total: msg.totalPages,
          percent: pct,
        });
        return;
      }

      if (msg.type === 'assets-done') {
        settled = true;
        cleanup(watchdog);
        resolve(msg.assets);
        return;
      }

      if (msg.type === 'error') {
        settled = true;
        cleanup(watchdog);
        if (msg.canFallbackToMainThread) {
          reject(new WorkerFallbackError(msg.message));
        } else {
          reject(new Error(msg.message));
        }
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      if (settled) return;
      settled = true;
      cleanup(watchdog);
      reject(new WorkerFallbackError(err?.message || 'Lỗi Worker trích xuất ảnh PDF.'));
    };

    const transferableBuffer = pdfBuffer.slice(0);
    const req: PdfWorkerRequest = {
      type: 'extract-assets',
      id: jobId,
      buffer: transferableBuffer,
      pages,
    };
    worker.postMessage(req, [transferableBuffer]);
  });
}

/**
 * Đảm bảo toàn bộ ảnh minh họa cần thiết trong các trang PDF đã được trích xuất
 * trước khi đóng gói EPUB hoặc kết xuất PDF (ưu tiên OffscreenCanvas Worker, tránh nghẽn main thread).
 */
export async function ensureAssetsExtracted(
  pdfBuffer: ArrayBuffer | undefined,
  parsedPdf: ParsedPdfData,
  onProgress?: (progress: BookExportProgress) => void
): Promise<void> {
  if (!pdfBuffer || !parsedPdf.pages) return;
  const missingPages = parsedPdf.pages.filter((p) => {
    if (!p.figureBoxes || p.figureBoxes.length === 0) return false;
    return (p.assetIds || []).some((id) => !parsedPdf.assets?.[id]);
  });

  if (missingPages.length === 0) return;

  onProgress?.({
    stage: `Đang trích xuất hình ảnh (${missingPages.length} trang có ảnh)...`,
    current: 0,
    total: missingPages.length,
    percent: 2,
  });

  const canUseOffscreenWorker =
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function';

  if (canUseOffscreenWorker) {
    try {
      const workerAssets = await extractAssetsInWorker(
        pdfBuffer,
        missingPages.map((p) => ({
          pageNumber: p.pageNumber,
          figureBoxes: p.figureBoxes || [],
        })),
        onProgress
      );
      if (!parsedPdf.assets) {
        parsedPdf.assets = {};
      }
      for (const [id, asset] of Object.entries(workerAssets)) {
        parsedPdf.assets[id] = asset;
      }
      return;
    } catch (err) {
      if (!(err instanceof WorkerFallbackError)) {
        throw err;
      }
      console.warn('[PdfExport] Worker trích xuất ảnh fallback về main thread:', err.message);
    }
  }

  const bytesCopy = new Uint8Array(pdfBuffer.slice(0));
  const loadingTask = pdfjsLib.getDocument({ data: bytesCopy });
  try {
    const pdfDoc = await loadingTask.promise;
    for (let i = 0; i < missingPages.length; i++) {
      const p = missingPages[i];
      try {
        const pageProxy = await pdfDoc.getPage(p.pageNumber);
        const baseVp = pageProxy.getViewport({ scale: 1 });
        const cropped = await cropFiguresFromPage(
          pageProxy,
          p.pageNumber,
          baseVp,
          p.figureBoxes || [],
          mainThreadAdapter
        );
        if (!parsedPdf.assets) {
          parsedPdf.assets = {};
        }
        for (const c of cropped) {
          parsedPdf.assets[c.asset.assetId] = c.asset;
        }
      } catch (err) {
        console.warn(`[PdfExport] Bỏ qua trích xuất ảnh trang ${p.pageNumber}:`, err);
      }

      const pct = 2 + Math.round(((i + 1) / missingPages.length) * 10);
      onProgress?.({
        stage: `Đang trích xuất hình ảnh (${i + 1}/${missingPages.length})...`,
        current: i + 1,
        total: missingPages.length,
        percent: pct,
      });
      await yieldToEventLoopFast(true);
    }
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

export async function reassemblePdfTranslationToEpub(
  parsedPdf: ParsedPdfData,
  translatedPages: Record<number, PdfTranslatedBlock[]>,
  originalFileName: string,
  onProgress?: (progress: BookExportProgress) => void,
  originalPdfBuffer?: ArrayBuffer
): Promise<{ blob: Blob; translatedTitle: string }> {
  await acquireBackgroundKeepAlive();
  try {
    if (originalPdfBuffer) {
      await ensureAssetsExtracted(originalPdfBuffer, parsedPdf, onProgress);
    }
  const baseName = originalFileName.replace(/\.pdf$/i, '').trim();
  const translatedTitle = appendVnSuffix(
    parsedPdf.bookTitle && parsedPdf.bookTitle !== 'Sach_PDF' ? parsedPdf.bookTitle : baseName
  );
  const bookUuid = `urn:uuid:pdf-vn-${Date.now().toString(36)}`;

  const totalAssets = Object.keys(parsedPdf.assets || {}).length;
  const totalChapters = Math.max(1, parsedPdf.chapters.length);

  onProgress?.({
    stage: 'Đang chuẩn bị cấu trúc EPUB...',
    current: 0,
    total: totalChapters,
    percent: 2,
  });

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    { compression: 'DEFLATE' }
  );

  const styleCss = `body { font-family: Georgia, "Times New Roman", serif; line-height: 1.65; margin: 4%; color: #1e293b; }
h1, h2, h3 { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; line-height: 1.3; margin-top: 1.4em; margin-bottom: 0.6em; page-break-after: avoid; }
h1 { font-size: 1.45em; border-bottom: 1px solid #cbd5e1; padding-bottom: 0.3em; }
h2 { font-size: 1.22em; }
h3 { font-size: 1.08em; }
p { margin: 0.65em 0; text-align: justify; }
blockquote { margin: 1em 0; padding: 0.5em 1em; border-left: 3px solid #0284c7; background: #f8fafc; color: #334155; }
pre { background: #f1f5f9; padding: 0.8em; border-radius: 6px; overflow-x: auto; font-size: 0.88em; white-space: pre-wrap; word-break: break-word; }
ul, ol { margin: 0.6em 0 0.8em 1.4em; padding: 0; }
li { margin: 0.25em 0; }
figure.pdf-figure { margin: 1em auto; text-align: center; page-break-inside: avoid; }
figure.pdf-figure img { max-width: 100%; height: auto; border-radius: 4px; }
table.pdf-table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 0.9em; page-break-inside: avoid; }
table.pdf-table th, table.pdf-table td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; vertical-align: top; }
table.pdf-table th { background: #f1f5f9; font-weight: bold; }`;

  zip.file('OEBPS/Styles/style.css', styleCss, { compression: 'DEFLATE' });

  // Lưu toàn bộ ảnh hình minh họa cắt từ PDF (dùng STORE vì JPEG/PNG đã nén sẵn)
  const assetEntries = Object.values(parsedPdf.assets);
  for (let aIdx = 0; aIdx < assetEntries.length; aIdx++) {
    const asset = assetEntries[aIdx];
    zip.file(`OEBPS/Images/${asset.fileName}`, asset.data, { compression: 'STORE' });
    if ((aIdx + 1) % 15 === 0) {
      const pct = 3 + Math.round(((aIdx + 1) / Math.max(1, totalAssets)) * 10);
      onProgress?.({
        stage: `Đang đóng gói hình ảnh (${aIdx + 1}/${totalAssets})...`,
        current: aIdx + 1,
        total: totalAssets,
        percent: pct,
      });
      await yieldToEventLoop();
    }
  }

  // Tạo từng file chương XHTML
  const chapterFiles: Array<{ id: string; href: string; title: string }> = [];

  for (let i = 0; i < parsedPdf.chapters.length; i++) {
    const ch = parsedPdf.chapters[i];
    const chBlocks = mergeChapterBlocksAcrossPages(parsedPdf, translatedPages, ch);
    const bodyParts: string[] = [];

    const firstHeading = chBlocks.find((b) => b.tag === 'h1' || b.tag === 'h2');
    const chapterHeading = firstHeading
      ? stripTagsToPlainText(firstHeading.html)
      : ch.title;

    if (!firstHeading && ch.title) {
      bodyParts.push(`<h1>${escapeXml(ch.title)}</h1>`);
    }

    for (const block of chBlocks) {
      const rendered = expandImageTokensToXhtml(block, parsedPdf.assets);
      if (rendered) bodyParts.push(rendered);
    }

    if (bodyParts.length === 0) {
      bodyParts.push(`<p></p>`);
    }

    const fileName = `chapter_${String(i + 1).padStart(3, '0')}.xhtml`;
    const href = `Text/${fileName}`;
    chapterFiles.push({
      id: `chap_${i + 1}`,
      href,
      title: chapterHeading || ch.title || `Chương ${i + 1}`,
    });

    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="vi" lang="vi">
<head>
  <meta charset="utf-8" />
  <title>${escapeXml(chapterHeading || translatedTitle)}</title>
  <link rel="stylesheet" type="text/css" href="../Styles/style.css" />
</head>
<body>
${bodyParts.join('\n')}
</body>
</html>`;

    zip.file(`OEBPS/${href}`, xhtml, { compression: 'DEFLATE' });

    if ((i + 1) % 3 === 0 || i + 1 === parsedPdf.chapters.length) {
      const pct = 14 + Math.round(((i + 1) / totalChapters) * 34);
      onProgress?.({
        stage: `Đang tạo chương EPUB (${i + 1}/${totalChapters})...`,
        current: i + 1,
        total: totalChapters,
        percent: pct,
      });
      await yieldToEventLoop();
    }
  }

  // OEBPS/nav.xhtml
  const navItems = chapterFiles
    .map((c) => `      <li><a href="${escapeXml(c.href)}">${escapeXml(c.title)}</a></li>`)
    .join('\n');

  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="vi" lang="vi">
<head>
  <meta charset="utf-8" />
  <title>Mục lục</title>
  <link rel="stylesheet" type="text/css" href="Styles/style.css" />
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Mục lục</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>`,
    { compression: 'DEFLATE' }
  );

  // OEBPS/toc.ncx (tương thích máy đọc sách EPUB 2)
  const navPoints = chapterFiles
    .map(
      (c, idx) => `    <navPoint id="navPoint-${idx + 1}" playOrder="${idx + 1}">
      <navLabel><text>${escapeXml(c.title)}</text></navLabel>
      <content src="${escapeXml(c.href)}" />
    </navPoint>`
    )
    .join('\n');

  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(bookUuid)}" />
    <meta name="dtb:depth" content="1" />
  </head>
  <docTitle><text>${escapeXml(translatedTitle)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`,
    { compression: 'DEFLATE' }
  );

  // OEBPS/package.opf
  const manifestChapters = chapterFiles
    .map(
      (c) =>
        `    <item id="${escapeXml(c.id)}" href="${escapeXml(c.href)}" media-type="application/xhtml+xml" />`
    )
    .join('\n');

  const manifestImages = assetEntries
    .map(
      (a) =>
        `    <item id="${escapeXml(a.assetId)}" href="Images/${escapeXml(a.fileName)}" media-type="${a.mimeType}" />`
    )
    .join('\n');

  const spineRefs = chapterFiles
    .map((c) => `    <itemref idref="${escapeXml(c.id)}" />`)
    .join('\n');

  zip.file(
    'OEBPS/package.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="vi">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeXml(bookUuid)}</dc:identifier>
    <dc:title>${escapeXml(translatedTitle)}</dc:title>
    <dc:creator>${escapeXml(parsedPdf.bookAuthor || 'Khuyết danh')}</dc:creator>
    <dc:language>vi</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
    <item id="css" href="Styles/style.css" media-type="text/css" />
${manifestChapters}
${manifestImages}
  </manifest>
  <spine toc="ncx">
    <itemref idref="nav" />
${spineRefs}
  </spine>
</package>`,
    { compression: 'DEFLATE' }
  );

  onProgress?.({
    stage: 'Đang nén tệp EPUB (0%)...',
    current: 0,
    total: 100,
    percent: 48,
  });

  const blob = await zip.generateAsync(
    {
      type: 'blob',
      mimeType: 'application/epub+zip',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    (metadata) => {
      const zipPct = Math.round(metadata.percent);
      const overallPct = 48 + Math.round((zipPct / 100) * 40);
      onProgress?.({
        stage: `Đang nén tệp EPUB (${zipPct}%)...`,
        current: zipPct,
        total: 100,
        percent: overallPct,
      });
    }
  );

  return { blob, translatedTitle };
  } finally {
    await releaseBackgroundKeepAlive();
  }
}

async function decodeAssetOnMainThread(
  asset: PdfExtractedAsset
): Promise<PdfExportDrawable | null> {
  try {
    const safeBytes = new Uint8Array(asset.data);
    const blob = new Blob([safeBytes], { type: asset.mimeType || 'image/jpeg' });
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width || asset.width,
        height: bitmap.height || asset.height,
        dispose: () => {
          try {
            bitmap.close();
          } catch {}
        },
      };
    }

    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Không tải được ảnh PDF.'));
        el.src = url;
      });
      return {
        source: img,
        width: img.naturalWidth || img.width || asset.width,
        height: img.naturalHeight || img.height || asset.height,
        dispose: () => {
          img.src = '';
        },
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

const mainThreadExportAdapter: PdfExportRuntimeAdapter = {
  createCanvas: (width: number, height: number): PdfExportCanvasLike => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as PdfExportCanvasLike;
  },
  canvasToJpegBlob: (canvas: PdfExportCanvasLike, quality: number): Promise<Blob> => {
    const htmlCanvas = canvas as unknown as HTMLCanvasElement;
    return new Promise<Blob>((resolve, reject) => {
      htmlCanvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Không xuất được ảnh từ canvas.'))),
        'image/jpeg',
        quality
      );
    });
  },
  decodeAssetToDrawable: decodeAssetOnMainThread,
  yieldPage: () => yieldToEventLoopFast(true),
  isWorker: false,
};

let cachedPdfFontsPromise: Promise<{ regular: Uint8Array; bold: Uint8Array } | null> | null =
  null;

async function loadPdfUnicodeFonts(): Promise<{ regular: Uint8Array; bold: Uint8Array } | null> {
  if (!cachedPdfFontsPromise) {
    cachedPdfFontsPromise = (async () => {
      try {
        const base =
          (typeof document !== 'undefined' && document.baseURI) ||
          (typeof window !== 'undefined' && window.location.href) ||
          'http://localhost/';
        const regUrl = new URL('fonts/DejaVuSerif.ttf', base).toString();
        const boldUrl = new URL('fonts/DejaVuSerif-Bold.ttf', base).toString();

        const [regRes, boldRes] = await Promise.all([fetch(regUrl), fetch(boldUrl)]);
        if (!regRes.ok || !boldRes.ok) {
          return null;
        }
        const [regBuf, boldBuf] = await Promise.all([
          regRes.arrayBuffer(),
          boldRes.arrayBuffer(),
        ]);
        if (regBuf.byteLength === 0 || boldBuf.byteLength === 0) {
          return null;
        }
        return {
          regular: new Uint8Array(regBuf),
          bold: new Uint8Array(boldBuf),
        };
      } catch (err) {
        console.warn('[PdfExport] Không nạp được font Unicode cục bộ:', err);
        return null;
      }
    })();
  }
  const result = await cachedPdfFontsPromise;
  if (!result) {
    cachedPdfFontsPromise = null;
  }
  return result;
}

async function exportTranslatedPdfInWorker(
  parsedPdf: ParsedPdfData,
  translatedPages: Record<number, PdfTranslatedBlock[]>,
  translatedTitle: string,
  renderMode: PdfExportRenderMode,
  fonts: { regular: Uint8Array; bold: Uint8Array } | null,
  onProgress?: (progress: BookExportProgress) => void,
  stopSignal?: { current: boolean }
): Promise<{ blob: Blob; translatedTitle: string }> {
  const worker = new Worker(
    new URL('../workers/pdfExportWorker.ts', import.meta.url),
    { type: 'module' }
  );
  const jobId = nextWorkerJobId++;

  return new Promise<{ blob: Blob; translatedTitle: string }>((resolve, reject) => {
    let settled = false;
    let lastActivityAt = Date.now();

    const cleanup = (watchdog: ReturnType<typeof setInterval>) => {
      clearInterval(watchdog);
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {}
    };

    const watchdog = setInterval(() => {
      if (settled) return;

      if (stopSignal?.current) {
        settled = true;
        try {
          const cancelMsg: PdfExportWorkerRequest = { type: 'cancel', id: jobId };
          worker.postMessage(cancelMsg);
        } catch {}
        cleanup(watchdog);
        reject(new Error('Đã hủy xuất file PDF.'));
        return;
      }

      if (Date.now() - lastActivityAt > 45_000) {
        settled = true;
        cleanup(watchdog);
        reject(new WorkerFallbackError('Worker kết xuất PDF không phản hồi quá 45s.'));
      }
    }, 500);

    worker.onmessage = (event: MessageEvent<PdfExportWorkerResponse>) => {
      const msg = event.data;
      if (!msg || msg.id !== jobId || settled) return;
      lastActivityAt = Date.now();

      if (msg.type === 'heartbeat') {
        return;
      }

      if (msg.type === 'progress') {
        onProgress?.(msg.progress);
        return;
      }

      if (msg.type === 'done') {
        settled = true;
        cleanup(watchdog);
        resolve({ blob: msg.blob, translatedTitle: msg.translatedTitle });
        return;
      }

      if (msg.type === 'error') {
        settled = true;
        cleanup(watchdog);
        if (msg.canFallbackToMainThread && !stopSignal?.current) {
          reject(new WorkerFallbackError(msg.message));
        } else {
          reject(new Error(msg.message));
        }
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      if (settled) return;
      settled = true;
      cleanup(watchdog);
      if (!stopSignal?.current) {
        reject(new WorkerFallbackError(err?.message || 'Không khởi chạy được PDF Export Worker.'));
      } else {
        reject(new Error(err?.message || 'Lỗi kết xuất PDF trong Worker.'));
      }
    };

    if (stopSignal?.current) {
      settled = true;
      cleanup(watchdog);
      reject(new Error('Đã hủy xuất file PDF.'));
      return;
    }

    // Không đưa asset ArrayBuffer vào transferables để không làm rỗng dữ liệu ảnh của job trên main thread
    const req: PdfExportWorkerRequest = {
      type: 'export',
      id: jobId,
      parsedPdf,
      translatedPages,
      translatedTitle,
      renderMode,
      ...(fonts
        ? {
            fontRegularBytes: fonts.regular,
            fontBoldBytes: fonts.bold,
          }
        : {}),
    };
    worker.postMessage(req);
  });
}

/**
 * Kết xuất bản dịch sang file PDF Unicode tiếng Việt chuẩn A4:
 * - Mặc định ('digital'): văn bản vector chọn/bôi đen được kèm ảnh sắc nét (dung lượng nhẹ, chạy nhanh).
 * - Tùy chọn ('image'): kết xuất từng trang thành ảnh JPEG toàn trang qua Canvas 2D.
 * Ưu tiên chạy trong Web Worker để không chặn main thread / WebView.
 */
export async function exportTranslatedPdfFile(
  parsedPdf: ParsedPdfData,
  translatedPages: Record<number, PdfTranslatedBlock[]>,
  originalFileName: string,
  onProgress?: (progress: BookExportProgress) => void,
  originalPdfBuffer?: ArrayBuffer,
  stopSignal?: { current: boolean },
  renderMode: PdfExportRenderMode = 'digital'
): Promise<{ blob: Blob; translatedTitle: string }> {
  await acquireBackgroundKeepAlive();
  try {
    if (originalPdfBuffer) {
      await ensureAssetsExtracted(originalPdfBuffer, parsedPdf, onProgress);
    }

    const baseName = originalFileName.replace(/\.(pdf|epub)$/i, '').trim();
    const translatedTitle = appendVnSuffix(
      parsedPdf.bookTitle && parsedPdf.bookTitle !== 'Sach_PDF' ? parsedPdf.bookTitle : baseName
    );

    let effectiveMode: PdfExportRenderMode = renderMode;
    let fonts: { regular: Uint8Array; bold: Uint8Array } | null = null;
    if (effectiveMode === 'digital') {
      fonts = await loadPdfUnicodeFonts();
      if (!fonts) {
        effectiveMode = 'image';
      }
    }

    const canUseOffscreenWorker =
      typeof Worker !== 'undefined' &&
      (effectiveMode === 'digital' ||
        (typeof OffscreenCanvas !== 'undefined' &&
          typeof OffscreenCanvas.prototype.convertToBlob === 'function'));

    if (canUseOffscreenWorker) {
      try {
        return await exportTranslatedPdfInWorker(
          parsedPdf,
          translatedPages,
          translatedTitle,
          effectiveMode,
          fonts,
          onProgress,
          stopSignal
        );
      } catch (err) {
        if (stopSignal?.current || !(err instanceof WorkerFallbackError)) {
          throw err;
        }
        console.warn('[PdfExport] Worker kết xuất PDF fallback về main thread:', err.message);
      }
    }

    if (effectiveMode === 'digital' && fonts) {
      return await exportTranslatedDigitalPdfCore({
        parsedPdf,
        translatedPages,
        translatedTitle,
        fontRegularBytes: fonts.regular,
        fontBoldBytes: fonts.bold,
        adapter: mainThreadExportAdapter,
        onProgress,
        stopSignal,
      });
    }

    return await exportTranslatedPdfCore({
      parsedPdf,
      translatedPages,
      translatedTitle,
      adapter: mainThreadExportAdapter,
      onProgress,
      stopSignal,
    });
  } finally {
    await releaseBackgroundKeepAlive();
  }
}
