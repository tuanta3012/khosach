import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import {
  ParsedPdfData,
  PdfBlockTag,
  PdfChapterInfo,
  PdfExtractedAsset,
  PdfParsedPage,
  PdfProcessingMode,
  PdfTranslatedBlock,
  PdfTranslationUnit,
} from '../types';
import { appendVnSuffix } from './epubService';
import {
  evaluateHybridVisionNeeded,
  parseDigitalPdfCore,
  PdfCanvasLike,
  PdfParserRuntimeAdapter,
} from './pdfDigitalParserCore';
import type { PdfWorkerRequest, PdfWorkerResponse } from '../workers/pdfDigitalWorker';

export { evaluateHybridVisionNeeded };

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const MAX_TEXT_CHUNK_CHARS = 3400;
const MAX_TEXT_CHUNK_BLOCKS = 32;
const MAX_TEXT_CHUNK_PAGES = 5;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

const mainThreadAdapter: PdfParserRuntimeAdapter = {
  createCanvas: (width: number, height: number): PdfCanvasLike => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as PdfCanvasLike;
  },
  canvasToJpegBytes: (canvas: PdfCanvasLike, quality = 0.86) =>
    canvasToJpegBytes(canvas as unknown as HTMLCanvasElement, quality),
  pageYieldMs: 15,
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
    let sawProgress = false;

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
        sawProgress = true;
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
        if (msg.isFatalWorkerBoot && !sawProgress && !stopSignal?.current) {
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
      if (!sawProgress && !stopSignal?.current) {
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

  return parseDigitalPdfCore(arrayBuffer, fileName, mainThreadAdapter, onProgress, stopSignal);
}

export function buildPdfTranslationUnits(
  parsedPdf: ParsedPdfData,
  mode: PdfProcessingMode
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
    const useVision =
      mode === 'full-vision' || evaluateHybridVisionNeeded(page, parsedPdf.assets);
    const pageChars = Math.max(80, page.rawDigitalText.length);
    const nonFigureBlocks = page.blocks.filter((b) => !b.isFigure);

    // Trang trống hoàn toàn (không chữ, không ảnh) bỏ qua chunk text nếu không phải full-vision
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
  const targetScale = Math.min(1.55, Math.max(0.95, 920 / Math.max(1, baseVp.width)));
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
    }).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
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
  const imgRegex = /\[\[PDF_IMG_([a-zA-Z0-9_-]+)\]\]/g;

  const renderFigureTag = (assetId: string): string => {
    const asset = assets[assetId];
    if (!asset) return '';
    return `<figure class="pdf-figure"><img src="../Images/${escapeXml(asset.fileName)}" alt="Hình ${escapeXml(assetId)}" /></figure>`;
  };

  if (block.tag === 'figure' || /^\[\[PDF_IMG_[a-zA-Z0-9_-]+\]\]$/.test(rawHtml)) {
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

export async function reassemblePdfTranslationToEpub(
  parsedPdf: ParsedPdfData,
  translatedPages: Record<number, PdfTranslatedBlock[]>,
  originalFileName: string
): Promise<{ blob: Blob; translatedTitle: string }> {
  const baseName = originalFileName.replace(/\.pdf$/i, '').trim();
  const translatedTitle = appendVnSuffix(
    parsedPdf.bookTitle && parsedPdf.bookTitle !== 'Sach_PDF' ? parsedPdf.bookTitle : baseName
  );
  const bookUuid = `urn:uuid:pdf-vn-${Date.now().toString(36)}`;

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

  // Lưu toàn bộ ảnh hình minh họa cắt từ PDF
  const assetEntries = Object.values(parsedPdf.assets);
  for (const asset of assetEntries) {
    zip.file(`OEBPS/Images/${asset.fileName}`, asset.data, { compression: 'DEFLATE' });
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

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
  });

  return { blob, translatedTitle };
}

function wrapTextToLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
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

function parseTableRowsFromHtml(html: string): Array<Array<{ text: string; isHeader: boolean }>> {
  if (typeof DOMParser === 'undefined') return [];
  const wrapped = /<table/i.test(html) ? html : `<table>${html}</table>`;
  const doc = new DOMParser().parseFromString(wrapped, 'text/html');
  const rows: Array<Array<{ text: string; isHeader: boolean }>> = [];
  const trs = Array.from(doc.querySelectorAll('tr'));
  for (const tr of trs) {
    const cells = Array.from(tr.querySelectorAll('th, td')).map((cell) => ({
      text: (cell.textContent || '').replace(/\s+/g, ' ').trim(),
      isHeader: cell.tagName.toLowerCase() === 'th',
    }));
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

async function decodeAssetToImage(asset: PdfExtractedAsset): Promise<HTMLImageElement | null> {
  try {
    const safeBytes = new Uint8Array(asset.data);
    const blob = new Blob([safeBytes], { type: asset.mimeType });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Không tải được ảnh PDF.'));
        el.src = url;
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/**
 * Kết xuất bản dịch sang file PDF Unicode tiếng Việt chuẩn A4 sạch đẹp
 * (dựng qua Canvas 2D hỗ trợ đầy đủ dấu tiếng Việt, bảng biểu, code và hình minh họa nhúng -> pdf-lib).
 */
export async function exportTranslatedPdfFile(
  parsedPdf: ParsedPdfData,
  translatedPages: Record<number, PdfTranslatedBlock[]>,
  originalFileName: string
): Promise<{ blob: Blob; translatedTitle: string }> {
  const baseName = originalFileName.replace(/\.pdf$/i, '').trim();
  const translatedTitle = appendVnSuffix(
    parsedPdf.bookTitle && parsedPdf.bookTitle !== 'Sach_PDF' ? parsedPdf.bookTitle : baseName
  );

  const PAGE_W = 1240; // A4 @ 150 DPI
  const PAGE_H = 1754;
  const MARGIN_X = 96;
  const MARGIN_TOP = 96;
  const MARGIN_BOTTOM = 104;
  const CONTENT_W = PAGE_W - MARGIN_X * 2;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(translatedTitle);
  pdfDoc.setAuthor(parsedPdf.bookAuthor || 'Khuyết danh');

  const canvas = document.createElement('canvas');
  canvas.width = PAGE_W;
  canvas.height = PAGE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Không khởi tạo được bộ kết xuất PDF.');
  }

  let pageNumber = 0;
  let cursorY = MARGIN_TOP;

  const initBlankPage = (drawPageNumber = true) => {
    pageNumber += 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    cursorY = MARGIN_TOP;
    if (drawPageNumber && pageNumber > 1) {
      ctx.save();
      ctx.font = '400 20px "Noto Sans", "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'center';
      ctx.fillText(String(pageNumber - 1), PAGE_W / 2, PAGE_H - 46);
      ctx.restore();
    }
  };

  const commitCurrentPageToPdf = async () => {
    const jpegBytes = await canvasToJpegBytes(canvas, 0.88);
    const embedded = await pdfDoc.embedJpg(jpegBytes);
    const pdfPage = pdfDoc.addPage([595.28, 841.89]); // A4 pt
    pdfPage.drawImage(embedded, {
      x: 0,
      y: 0,
      width: 595.28,
      height: 841.89,
    });
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
    ctx.font = '700 54px "Noto Serif", Georgia, serif';
    const titleLines = wrapTextToLines(ctx, translatedTitle, CONTENT_W);
    cursorY = Math.max(420, Math.round(PAGE_H * 0.36));
    for (const line of titleLines) {
      ctx.fillText(line, MARGIN_X, cursorY);
      cursorY += 72;
    }

    if (parsedPdf.bookAuthor) {
      cursorY += 24;
      ctx.fillStyle = '#475569';
      ctx.font = '500 30px "Noto Sans", "Segoe UI", Roboto, sans-serif';
      ctx.fillText(parsedPdf.bookAuthor, MARGIN_X, cursorY);
    }

    await commitCurrentPageToPdf();
    initBlankPage(true);

    // 2. Kết xuất nội dung các chương
    for (let chIdx = 0; chIdx < parsedPdf.chapters.length; chIdx++) {
      const ch = parsedPdf.chapters[chIdx];
      if (chIdx > 0 && cursorY > MARGIN_TOP + 80) {
        await commitCurrentPageToPdf();
        initBlankPage(true);
      }

      const chBlocks = mergeChapterBlocksAcrossPages(parsedPdf, translatedPages, ch);
      const hasFirstHeading = chBlocks.some((b) => b.tag === 'h1' || b.tag === 'h2');
      const blocksToDraw: PdfTranslatedBlock[] =
        !hasFirstHeading && ch.title
          ? [{ tag: 'h1', html: ch.title }, ...chBlocks]
          : chBlocks;

      for (const block of blocksToDraw) {
        const imgTokens = Array.from(block.html.matchAll(/\[\[PDF_IMG_([a-zA-Z0-9_-]+)\]\]/g));
        const textWithoutTokens = block.html.replace(/\[\[PDF_IMG_[a-zA-Z0-9_-]+\]\]/g, '').trim();

        if (textWithoutTokens && block.tag !== 'figure') {
          if (block.tag === 'table') {
            const rows = parseTableRowsFromHtml(textWithoutTokens);
            if (rows.length > 0) {
              const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 1);
              const colW = CONTENT_W / maxCols;
              ctx.font = '400 22px "Noto Sans", "Segoe UI", Roboto, sans-serif';

              for (const row of rows) {
                const cellLineGroups = row.map((cell) => {
                  ctx.font = cell.isHeader
                    ? '700 22px "Noto Sans", "Segoe UI", Roboto, sans-serif'
                    : '400 22px "Noto Sans", "Segoe UI", Roboto, sans-serif';
                  return wrapTextToLines(ctx, cell.text, colW - 20);
                });
                const maxLines = cellLineGroups.reduce((m, g) => Math.max(m, g.length), 1);
                const rowH = maxLines * 30 + 20;
                await ensureSpace(rowH + 6);

                for (let c = 0; c < maxCols; c++) {
                  const cell = row[c] || { text: '', isHeader: false };
                  const cx = MARGIN_X + c * colW;
                  if (cell.isHeader) {
                    ctx.fillStyle = '#f1f5f9';
                    ctx.fillRect(cx, cursorY, colW, rowH);
                  }
                  ctx.strokeStyle = '#cbd5e1';
                  ctx.lineWidth = 1.5;
                  ctx.strokeRect(cx, cursorY, colW, rowH);

                  ctx.fillStyle = '#0f172a';
                  ctx.font = cell.isHeader
                    ? '700 22px "Noto Sans", "Segoe UI", Roboto, sans-serif'
                    : '400 22px "Noto Sans", "Segoe UI", Roboto, sans-serif';
                  const lines = cellLineGroups[c] || [];
                  for (let li = 0; li < lines.length; li++) {
                    ctx.fillText(lines[li], cx + 10, cursorY + 28 + li * 30);
                  }
                }
                cursorY += rowH;
              }
              cursorY += 18;
            }
          } else {
            let fontSpec = '400 27px "Noto Serif", Georgia, serif';
            let lineHeight = 42;
            let fill = '#1e293b';
            let indentLeft = 0;
            let spaceBefore = 0;
            let spaceAfter = 18;

            if (block.tag === 'h1') {
              fontSpec = '700 40px "Noto Sans", "Segoe UI", Roboto, sans-serif';
              lineHeight = 52;
              fill = '#0f172a';
              spaceBefore = 20;
              spaceAfter = 22;
            } else if (block.tag === 'h2') {
              fontSpec = '700 33px "Noto Sans", "Segoe UI", Roboto, sans-serif';
              lineHeight = 44;
              fill = '#0f172a';
              spaceBefore = 16;
              spaceAfter = 16;
            } else if (block.tag === 'h3') {
              fontSpec = '700 29px "Noto Sans", "Segoe UI", Roboto, sans-serif';
              lineHeight = 40;
              fill = '#1e293b';
              spaceBefore = 12;
              spaceAfter = 12;
            } else if (block.tag === 'blockquote') {
              fontSpec = 'italic 26px "Noto Serif", Georgia, serif';
              lineHeight = 40;
              fill = '#334155';
              indentLeft = 28;
            } else if (block.tag === 'pre') {
              fontSpec = '400 22px "Courier New", monospace';
              lineHeight = 32;
              fill = '#0f172a';
              indentLeft = 18;
            } else if (block.tag === 'ul' || block.tag === 'ol') {
              indentLeft = 24;
              spaceAfter = 12;
            }

            let plain = stripTagsToPlainText(textWithoutTokens);
            if (block.tag === 'ul' && !/^[•●▪\-–*]/.test(plain)) {
              plain = `• ${plain}`;
            }

            ctx.font = fontSpec;
            const lines = wrapTextToLines(ctx, plain, CONTENT_W - indentLeft - 12);
            if (lines.length > 0) {
              cursorY += spaceBefore;
              if (block.tag === 'h1' || block.tag === 'h2' || block.tag === 'h3') {
                await ensureSpace(lines.length * lineHeight + 60);
              }

              for (let li = 0; li < lines.length; li++) {
                await ensureSpace(lineHeight + 8);
                if (block.tag === 'blockquote') {
                  ctx.fillStyle = '#0284c7';
                  ctx.fillRect(MARGIN_X + 6, cursorY - 24, 5, lineHeight);
                } else if (block.tag === 'pre') {
                  ctx.fillStyle = '#f1f5f9';
                  ctx.fillRect(MARGIN_X, cursorY - 24, CONTENT_W, lineHeight);
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

        // Vẽ ảnh nhúng nếu có
        for (const match of imgTokens) {
          const asset = parsedPdf.assets[match[1]];
          if (!asset) continue;
          const img = await decodeAssetToImage(asset);
          if (!img) continue;

          const maxImgW = CONTENT_W;
          const maxImgH = Math.round((PAGE_H - MARGIN_TOP - MARGIN_BOTTOM) * 0.72);
          const scale = Math.min(1.6, maxImgW / Math.max(1, img.width), maxImgH / Math.max(1, img.height));
          const drawW = Math.round(img.width * scale);
          const drawH = Math.round(img.height * scale);

          await ensureSpace(drawH + 28);
          const drawX = MARGIN_X + Math.round((CONTENT_W - drawW) / 2);
          ctx.drawImage(img, drawX, cursorY, drawW, drawH);
          cursorY += drawH + 22;
        }
      }

      if (chIdx % 2 === 0) {
        await yieldToEventLoop();
      }
    }

    await commitCurrentPageToPdf();
    const pdfBytes = await pdfDoc.save();
    const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
    return { blob, translatedTitle };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
