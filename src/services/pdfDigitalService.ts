import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import {
  ParsedPdfData,
  PdfBlockTag,
  PdfChapterInfo,
  PdfExtractedAsset,
  PdfParsedPage,
  PdfPreParsedBlock,
  PdfProcessingMode,
  PdfTranslatedBlock,
  PdfTranslationUnit,
} from '../types';
import { appendVnSuffix } from './epubService';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const MAX_TEXT_CHUNK_CHARS = 2600;
const MAX_TEXT_CHUNK_BLOCKS = 24;
const MAX_TEXT_CHUNK_PAGES = 4;

interface PositionedTextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
  isMono: boolean;
  isBold: boolean;
  hasEOL: boolean;
}

interface PositionedLine {
  y: number;
  x: number;
  maxX: number;
  height: number;
  fontSize: number;
  isMono: boolean;
  isBold: boolean;
  text: string;
  runs: PositionedTextRun[];
}

interface RectBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

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

function normalizeHeaderFooterLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPurePageNumber(text: string): boolean {
  const clean = text.trim();
  return (
    /^\d{1,4}$/.test(clean) ||
    /^(page|trang|p\.)\s*\d{1,4}(\s*\/\s*\d{1,4})?$/i.test(clean) ||
    /^[-–—]\s*\d{1,4}\s*[-–—]$/.test(clean)
  );
}

function transformBox(
  matrix: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number
): RectBox {
  const pts = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [px, py] of pts) {
    const nx = matrix[0] * px + matrix[2] * py + matrix[4];
    const ny = matrix[1] * px + matrix[3] * py + matrix[5];
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx < minX) minX = nx;
      if (ny < minY) minY = ny;
      if (nx > maxX) maxX = nx;
      if (ny > maxY) maxY = ny;
    }
  }
  return { minX, minY, maxX, maxY };
}

function mergeNearbyBoxes(boxes: RectBox[], pad = 18): RectBox[] {
  const filtered = boxes.filter(
    (b) =>
      Number.isFinite(b.minX) &&
      Number.isFinite(b.minY) &&
      b.maxX > b.minX &&
      b.maxY > b.minY
  );
  if (filtered.length <= 1) return filtered;

  const working = filtered.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < working.length; i++) {
      for (let j = i + 1; j < working.length; j++) {
        const a = working[i];
        const b = working[j];
        const overlaps =
          a.minX - pad <= b.maxX &&
          a.maxX + pad >= b.minX &&
          a.minY - pad <= b.maxY &&
          a.maxY + pad >= b.minY;
        if (overlaps) {
          a.minX = Math.min(a.minX, b.minX);
          a.minY = Math.min(a.minY, b.minY);
          a.maxX = Math.max(a.maxX, b.maxX);
          a.maxY = Math.max(a.maxY, b.maxY);
          working.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return working;
}

async function detectPageFigureBoxes(
  page: pdfjsLib.PDFPageProxy,
  viewport: pdfjsLib.PageViewport
): Promise<RectBox[]> {
  const OPS = pdfjsLib.OPS;
  const opList = await page.getOperatorList();
  const ctmStack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const rawBoxes: RectBox[] = [];

  const pageArea = viewport.width * viewport.height;

  const pushViewportBox = (box: RectBox, minW: number, minH: number) => {
    const clamped: RectBox = {
      minX: Math.max(0, box.minX),
      minY: Math.max(0, box.minY),
      maxX: Math.min(viewport.width, box.maxX),
      maxY: Math.min(viewport.height, box.maxY),
    };
    const w = clamped.maxX - clamped.minX;
    const h = clamped.maxY - clamped.minY;
    if (w < minW || h < minH) return;
    // Bỏ qua khung nền trắng/viền khung bao phủ phần lớn trang
    if (
      (w * h > pageArea * 0.72 && w > viewport.width * 0.85 && h > viewport.height * 0.8) ||
      (w > viewport.width * 0.9 && h > viewport.height * 0.88)
    ) {
      return;
    }
    rawBoxes.push(clamped);
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (fn === OPS.save) {
      ctmStack.push([...ctm]);
    } else if (fn === OPS.restore) {
      ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform && Array.isArray(args) && args.length >= 6) {
      ctm = pdfjsLib.Util.transform(ctm, args as number[]);
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject ||
      fn === OPS.paintImageXObjectRepeat
    ) {
      const fullMatrix = pdfjsLib.Util.transform(viewport.transform, ctm);
      const box = transformBox(fullMatrix, 0, 0, 1, 1);
      pushViewportBox(box, 42, 34);
    } else if (fn === OPS.constructPath && Array.isArray(args)) {
      const coords = args[1];
      if (Array.isArray(coords) || ArrayBuffer.isView(coords)) {
        const arr = Array.from(coords as ArrayLike<number>);
        let minPx = Infinity;
        let minPy = Infinity;
        let maxPx = -Infinity;
        let maxPy = -Infinity;
        for (let k = 0; k + 1 < arr.length; k += 2) {
          const px = arr[k];
          const py = arr[k + 1];
          if (Number.isFinite(px) && Number.isFinite(py)) {
            if (px < minPx) minPx = px;
            if (py < minPy) minPy = py;
            if (px > maxPx) maxPx = px;
            if (py > maxPy) maxPy = py;
          }
        }
        if (Number.isFinite(minPx) && maxPx > minPx && maxPy > minPy) {
          const fullMatrix = pdfjsLib.Util.transform(viewport.transform, ctm);
          const box = transformBox(fullMatrix, minPx, minPy, maxPx, maxPy);
          // Chỉ gom vector có kích thước đáng kể (sơ đồ/biểu đồ/khung hình), tránh gạch chân hay kẻ bảng mảnh
          pushViewportBox(box, 54, 44);
        }
      }
    }
  }

  const merged = mergeNearbyBoxes(rawBoxes, 16);
  return merged
    .filter((b) => {
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      const area = w * h;
      return (
        w >= 52 &&
        h >= 40 &&
        !(area > pageArea * 0.74 && w > viewport.width * 0.86 && h > viewport.height * 0.82)
      );
    })
    .sort((a, b) => a.minY - b.minY || a.minX - b.minX)
    .slice(0, 6);
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

interface FigurePlacement {
  assetId: string;
  minY: number;
  maxY: number;
  area: number;
}

interface CroppedFigureEntry {
  asset: PdfExtractedAsset;
  placement: FigurePlacement;
}

async function cropFiguresFromPage(
  page: pdfjsLib.PDFPageProxy,
  pageNumber: number,
  baseViewport: pdfjsLib.PageViewport,
  boxes: RectBox[]
): Promise<CroppedFigureEntry[]> {
  if (boxes.length === 0) return [];

  const targetScale = Math.min(2.0, Math.max(1.2, 1600 / Math.max(1, baseViewport.width)));
  const renderViewport = page.getViewport({ scale: targetScale });
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = Math.max(1, Math.round(renderViewport.width));
  pageCanvas.height = Math.max(1, Math.round(renderViewport.height));

  const ctx = pageCanvas.getContext('2d');
  if (!ctx) return [];

  const extracted: CroppedFigureEntry[] = [];
  try {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

    await page.render({
      canvas: pageCanvas,
      canvasContext: ctx,
      viewport: renderViewport,
    }).promise;

    const scaleRatio = renderViewport.width / Math.max(1, baseViewport.width);
    const pad = Math.round(6 * scaleRatio);

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const sx = Math.max(0, Math.floor(b.minX * scaleRatio) - pad);
      const sy = Math.max(0, Math.floor(b.minY * scaleRatio) - pad);
      const ex = Math.min(pageCanvas.width, Math.ceil(b.maxX * scaleRatio) + pad);
      const ey = Math.min(pageCanvas.height, Math.ceil(b.maxY * scaleRatio) + pad);
      const cw = ex - sx;
      const ch = ey - sy;
      if (cw < 48 || ch < 36) continue;

      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = cw;
      cropCanvas.height = ch;
      const cropCtx = cropCanvas.getContext('2d');
      if (cropCtx) {
        cropCtx.fillStyle = '#ffffff';
        cropCtx.fillRect(0, 0, cw, ch);
        cropCtx.drawImage(pageCanvas, sx, sy, cw, ch, 0, 0, cw, ch);
        const bytes = await canvasToJpegBytes(cropCanvas, 0.86);
        const assetId = `p${pageNumber}_fig${i + 1}`;
        extracted.push({
          asset: {
            assetId,
            pageNumber,
            fileName: `${assetId}.jpg`,
            mimeType: 'image/jpeg',
            data: bytes,
            width: cw,
            height: ch,
          },
          placement: {
            assetId,
            minY: b.minY,
            maxY: b.maxY,
            area: Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY),
          },
        });
      }
      cropCanvas.width = 0;
      cropCanvas.height = 0;
    }
  } finally {
    pageCanvas.width = 0;
    pageCanvas.height = 0;
  }

  return extracted;
}

function buildLinesFromRuns(
  runs: PositionedTextRun[],
  styles: Record<string, { fontFamily?: string }>
): PositionedLine[] {
  if (runs.length === 0) return [];
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PositionedLine[] = [];

  const commitGroup = (groupRuns: PositionedTextRun[]) => {
    if (groupRuns.length === 0) return;
    const byX = [...groupRuns].sort((a, b) => a.x - b.x);
    let text = '';
    let prevRight = byX[0].x;
    let totalWeightedSize = 0;
    let totalChars = 0;
    let boldChars = 0;
    let monoChars = 0;

    for (let i = 0; i < byX.length; i++) {
      const r = byX[i];
      if (i > 0) {
        const gap = r.x - prevRight;
        if (gap > Math.max(2.0, r.fontSize * 0.24)) {
          text += ' ';
        }
      }
      text += r.str;
      prevRight = Math.max(prevRight, r.x + r.width);

      const len = r.str.trim().length || 1;
      totalChars += len;
      totalWeightedSize += r.fontSize * len;
      const family = (styles[r.fontName]?.fontFamily || r.fontName || '').toLowerCase();
      if (r.isBold || /bold|black|heavy|semibold/.test(family)) boldChars += len;
      if (r.isMono || /mono|courier|consolas|menlo|code/.test(family)) monoChars += len;
    }

    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;

    const avgY = byX.reduce((s, r) => s + r.y, 0) / byX.length;
    const maxH = byX.reduce((m, r) => Math.max(m, r.height || r.fontSize), 0);

    lines.push({
      y: avgY,
      x: byX[0].x,
      maxX: byX[byX.length - 1].x + byX[byX.length - 1].width,
      height: maxH,
      fontSize: totalChars > 0 ? totalWeightedSize / totalChars : byX[0].fontSize,
      isBold: boldChars > totalChars * 0.55,
      isMono: monoChars > totalChars * 0.6,
      text: cleaned,
      runs: byX,
    });
  };

  let currentGroup: PositionedTextRun[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    const anchor = currentGroup[0];
    const tolerance = Math.max(3.5, Math.min(anchor.fontSize, r.fontSize) * 0.48);
    if (Math.abs(r.y - anchor.y) <= tolerance) {
      currentGroup.push(r);
    } else {
      commitGroup(currentGroup);
      currentGroup = [r];
    }
  }
  commitGroup(currentGroup);

  return lines;
}

function detectMultiColumnAndTables(
  lines: PositionedLine[],
  pageWidth: number
): { isMultiColumn: boolean; hasTables: boolean } {
  let multiGapRows = 0;
  let tableLikeRows = 0;
  let leftColCount = 0;
  let rightColCount = 0;

  for (const line of lines) {
    if (line.text.length < 4) continue;
    const runs = line.runs;
    let largeGaps = 0;
    let midGap = false;

    for (let i = 1; i < runs.length; i++) {
      const gap = runs[i].x - (runs[i - 1].x + runs[i - 1].width);
      if (gap >= Math.max(18, line.fontSize * 1.6)) {
        largeGaps += 1;
        const gapMid = (runs[i - 1].x + runs[i - 1].width + runs[i].x) / 2;
        if (gapMid > pageWidth * 0.35 && gapMid < pageWidth * 0.65 && gap > pageWidth * 0.05) {
          midGap = true;
        }
      }
    }

    if (largeGaps >= 2) {
      tableLikeRows += 1;
    } else if (midGap) {
      multiGapRows += 1;
    }

    const width = line.maxX - line.x;
    if (width < pageWidth * 0.46) {
      if (line.x < pageWidth * 0.25 && line.maxX < pageWidth * 0.52) {
        leftColCount += 1;
      } else if (line.x > pageWidth * 0.45) {
        rightColCount += 1;
      }
    }
  }

  const hasTables = tableLikeRows >= 3;
  const isMultiColumn = multiGapRows >= 5 || (leftColCount >= 6 && rightColCount >= 6);
  return { isMultiColumn, hasTables };
}

function detectMathOrGarbledText(text: string): boolean {
  if (!text) return false;
  if (text.includes('\uFFFD')) return true;
  const mathMatches = text.match(/[∑∏∫∂∇≈≠≤≥∞√∈∉⊂⊃∪∩∀∃αβγδεθλμπσφψω]/g);
  return (mathMatches?.length || 0) >= 6;
}

function buildPreParsedBlocks(
  lines: PositionedLine[],
  bodyFontSize: number,
  pageWidth: number,
  figurePlacements: FigurePlacement[]
): PdfPreParsedBlock[] {
  const blocks: PdfPreParsedBlock[] = [];
  let nextBlockId = 1;
  const pendingFigures = [...figurePlacements].sort((a, b) => a.minY - b.minY);

  const pushFigureBlock = (assetId: string) => {
    blocks.push({
      blockId: nextBlockId++,
      tag: 'figure',
      text: `[[PDF_IMG_${assetId}]]`,
      isFigure: true,
      assetId,
    });
  };

  if (lines.length === 0) {
    for (const fig of pendingFigures) {
      pushFigureBlock(fig.assetId);
    }
    return blocks;
  }

  const medianLeftMargin = (() => {
    const xs = lines.map((l) => Math.round(l.x)).sort((a, b) => a - b);
    return xs[Math.floor(xs.length * 0.25)] || 40;
  })();

  const classifyLineTag = (line: PositionedLine): PdfBlockTag => {
    const ratio = line.fontSize / Math.max(6, bodyFontSize);
    if (ratio >= 1.48 && line.text.length <= 160) return 'h1';
    if (ratio >= 1.24 && line.text.length <= 160) return 'h2';
    if ((ratio >= 1.1 || line.isBold) && line.text.length <= 95 && !/[.,;]$/.test(line.text)) {
      return 'h3';
    }
    if (line.isMono) return 'pre';
    if (/^[•●▪▫◦‣\-–—*]\s+/.test(line.text)) return 'ul';
    if (/^\d{1,3}[.)]\s+/.test(line.text)) return 'ol';
    if (
      line.x > medianLeftMargin + 22 &&
      line.maxX < pageWidth - 22 &&
      line.fontSize <= bodyFontSize * 1.02
    ) {
      return 'blockquote';
    }
    return 'p';
  };

  let curTag: PdfBlockTag | null = null;
  let curText = '';
  let prevLine: PositionedLine | null = null;

  const flush = () => {
    const clean = curText.replace(/\s+/g, ' ').trim();
    if (clean && curTag) {
      blocks.push({
        blockId: nextBlockId++,
        tag: curTag,
        text: clean,
      });
    }
    curTag = null;
    curText = '';
  };

  for (const line of lines) {
    const lineTag = classifyLineTag(line);
    const isHeading = lineTag === 'h1' || lineTag === 'h2' || lineTag === 'h3';
    const isListStart = lineTag === 'ul' || lineTag === 'ol';

    let shouldBreak = false;
    if (!prevLine || !curTag) {
      shouldBreak = true;
    } else if (isHeading || curTag === 'h1' || curTag === 'h2' || curTag === 'h3') {
      if (lineTag !== curTag || (line.y - prevLine.y) > line.fontSize * 1.55) {
        shouldBreak = true;
      }
    } else if (isListStart) {
      shouldBreak = true;
    } else if (lineTag !== curTag && !(curTag === 'ul' && lineTag === 'p') && !(curTag === 'ol' && lineTag === 'p')) {
      shouldBreak = true;
    } else {
      const verticalGap = line.y - prevLine.y;
      const normalGap = Math.max(prevLine.fontSize, line.fontSize) * 1.48;
      const firstLineIndent = line.x - medianLeftMargin > Math.max(12, line.fontSize * 0.9);
      const prevShort =
        prevLine.maxX < pageWidth * 0.72 && /[.!?:”"»)]$/.test(prevLine.text);
      if (verticalGap > normalGap || (firstLineIndent && prevShort) || prevShort) {
        shouldBreak = true;
      }
    }

    // Chèn ảnh đúng vị trí dọc (Y) trước khối văn bản mới hoặc ngay sau khi vượt qua đáy ảnh
    const readyFigureBeforeLine =
      pendingFigures.length > 0 &&
      ((shouldBreak && line.y >= pendingFigures[0].minY - 6) ||
        line.y > pendingFigures[0].maxY + 8);

    if (readyFigureBeforeLine) {
      flush();
      while (
        pendingFigures.length > 0 &&
        ((shouldBreak && line.y >= pendingFigures[0].minY - 6) ||
          line.y > pendingFigures[0].maxY + 8)
      ) {
        const fig = pendingFigures.shift()!;
        pushFigureBlock(fig.assetId);
      }
      curTag = lineTag;
      curText = line.text;
    } else if (shouldBreak) {
      flush();
      curTag = lineTag;
      curText = line.text;
    } else {
      if (/[-‐‑]$/.test(curText) && /^[a-zà-ỹ]/i.test(line.text)) {
        curText = curText.slice(0, -1) + line.text;
      } else {
        curText = `${curText} ${line.text}`;
      }
    }
    prevLine = line;
  }
  flush();

  while (pendingFigures.length > 0) {
    const fig = pendingFigures.shift()!;
    pushFigureBlock(fig.assetId);
  }

  return blocks;
}

async function resolveOutlineChapters(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  totalPages: number
): Promise<PdfChapterInfo[]> {
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline || outline.length === 0) return [];

    const entries: Array<{ title: string; startPage: number }> = [];

    const walkOutline = async (items: any[], depth = 0) => {
      for (const item of items) {
        if (!item) continue;
        const title = String(item.title || '').replace(/\s+/g, ' ').trim();
        let pageNum = 0;

        if (item.dest) {
          try {
            const dest =
              typeof item.dest === 'string'
                ? await pdfDoc.getDestination(item.dest)
                : item.dest;
            if (Array.isArray(dest) && dest[0]) {
              const pageIdx = await pdfDoc.getPageIndex(dest[0]);
              pageNum = pageIdx + 1;
            }
          } catch {}
        }

        if (title && pageNum >= 1 && pageNum <= totalPages && depth <= 1) {
          entries.push({ title, startPage: pageNum });
        }

        if (Array.isArray(item.items) && item.items.length > 0 && depth < 1) {
          await walkOutline(item.items, depth + 1);
        }
      }
    };

    await walkOutline(outline);
    if (entries.length === 0) return [];

    entries.sort((a, b) => a.startPage - b.startPage);
    const deduped: Array<{ title: string; startPage: number }> = [];
    for (const e of entries) {
      const last = deduped[deduped.length - 1];
      if (!last || last.startPage !== e.startPage) {
        deduped.push(e);
      }
    }

    const chapters: PdfChapterInfo[] = [];
    if (deduped[0].startPage > 1) {
      chapters.push({
        chapterIndex: 0,
        title: 'Mở đầu',
        startPage: 1,
        endPage: deduped[0].startPage - 1,
      });
    }

    for (let i = 0; i < deduped.length; i++) {
      const startPage = deduped[i].startPage;
      const nextStart = i + 1 < deduped.length ? deduped[i + 1].startPage - 1 : totalPages;
      chapters.push({
        chapterIndex: chapters.length,
        title: deduped[i].title,
        startPage,
        endPage: Math.max(startPage, nextStart),
      });
    }

    return chapters;
  } catch {
    return [];
  }
}

export async function parseDigitalPdfFile(
  arrayBuffer: ArrayBuffer,
  fileName: string,
  onProgress?: (currentPage: number, totalPages: number) => void
): Promise<ParsedPdfData> {
  const bytesCopy = new Uint8Array(arrayBuffer.slice(0));
  const loadingTask = pdfjsLib.getDocument({ data: bytesCopy });
  const pdfDoc = await loadingTask.promise;

  try {
    const totalPages = pdfDoc.numPages;
    if (totalPages <= 0) {
      throw new Error('File PDF không có trang nào.');
    }

    // Kiểm tra nhanh 5 trang đầu để loại trừ PDF scan thuần ảnh
    const sampleCount = Math.min(5, totalPages);
    let sampleCharCount = 0;
    for (let p = 1; p <= sampleCount; p++) {
      const page = await pdfDoc.getPage(p);
      const tc = await page.getTextContent();
      const text = tc.items
        .map((it: any) => (typeof it?.str === 'string' ? it.str : ''))
        .join('')
        .replace(/\s+/g, '');
      sampleCharCount += text.length;
    }

    if (sampleCharCount < Math.max(60, sampleCount * 22)) {
      throw new Error(
        'PDF này là bản scan ảnh, không có lớp chữ Digital để tách nội dung.'
      );
    }

    let bookTitle = fileName.replace(/\.pdf$/i, '').trim() || 'Sach_PDF';
    let bookAuthor = 'Khuyết danh';
    let bookPublisher = '';

    try {
      const meta = await pdfDoc.getMetadata();
      const info = (meta?.info || {}) as Record<string, unknown>;
      if (typeof info.Title === 'string' && info.Title.trim().length >= 2) {
        bookTitle = info.Title.trim();
      }
      if (typeof info.Author === 'string' && info.Author.trim()) {
        bookAuthor = info.Author.trim();
      }
      if (typeof info.Producer === 'string' && info.Producer.trim()) {
        bookPublisher = info.Producer.trim();
      }
    } catch {}

    const outlineChapters = await resolveOutlineChapters(pdfDoc, totalPages);

    interface RawPageExtract {
      pageNumber: number;
      width: number;
      height: number;
      lines: PositionedLine[];
      assetIds: string[];
      figurePlacements: FigurePlacement[];
      figureAreaRatio: number;
      hasFigures: boolean;
      isMultiColumn: boolean;
      hasTables: boolean;
      hasMathOrGarbled: boolean;
    }

    const rawPages: RawPageExtract[] = [];
    const assets: Record<string, PdfExtractedAsset> = {};
    const fontSizeFreq = new Map<number, number>();

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      if (onProgress) onProgress(pageNumber, totalPages);

      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();

      const runs: PositionedTextRun[] = [];
      for (const rawItem of tc.items) {
        const item = rawItem as any;
        if (typeof item?.str !== 'string' || !item.str) continue;
        if (!item.str.trim() && item.str.length <= 1) continue;

        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontSize = Math.max(
          5,
          Math.round((Math.hypot(tx[0], tx[1]) || item.height || 11) * 10) / 10
        );
        const family = (tc.styles[item.fontName]?.fontFamily || item.fontName || '').toLowerCase();

        runs.push({
          str: item.str,
          x: tx[4],
          y: tx[5],
          width: Math.max(0, item.width || 0),
          height: Math.max(fontSize, item.height || fontSize),
          fontSize,
          fontName: item.fontName || '',
          isMono: /mono|courier|consolas|menlo|code/.test(family),
          isBold: /bold|black|heavy|semibold/.test(family),
          hasEOL: Boolean(item.hasEOL),
        });

        const roundedSize = Math.round(fontSize * 2) / 2;
        fontSizeFreq.set(
          roundedSize,
          (fontSizeFreq.get(roundedSize) || 0) + item.str.trim().length
        );
      }

      const lines = buildLinesFromRuns(runs, tc.styles || {});
      const { isMultiColumn, hasTables } = detectMultiColumnAndTables(lines, viewport.width);
      const joinedRawText = lines.map((l) => l.text).join('\n');
      const hasMathOrGarbled = detectMathOrGarbledText(joinedRawText);

      // Lớp 3: dò hình ảnh / biểu đồ vector và cắt xuất sắc nét
      const figureBoxes = await detectPageFigureBoxes(page, viewport);
      const croppedEntries = await cropFiguresFromPage(page, pageNumber, viewport, figureBoxes);
      const assetIds: string[] = [];
      const figurePlacements: FigurePlacement[] = [];
      let totalFigureArea = 0;

      for (const entry of croppedEntries) {
        assets[entry.asset.assetId] = entry.asset;
        assetIds.push(entry.asset.assetId);
        figurePlacements.push(entry.placement);
        totalFigureArea += entry.placement.area;
      }

      const pageArea = Math.max(1, viewport.width * viewport.height);
      const figureAreaRatio = Math.min(1, Math.round((totalFigureArea / pageArea) * 1000) / 1000);

      rawPages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        lines,
        assetIds,
        figurePlacements,
        figureAreaRatio,
        hasFigures: assetIds.length > 0,
        isMultiColumn,
        hasTables,
        hasMathOrGarbled,
      });

      if (pageNumber % 4 === 0) {
        await yieldToEventLoop();
      }
    }

    // Tính fontSize thân bài chủ đạo
    let bodyFontSize = 11;
    let bestWeight = -1;
    for (const [size, weight] of fontSizeFreq.entries()) {
      if (size >= 7 && size <= 16 && weight > bestWeight) {
        bestWeight = weight;
        bodyFontSize = size;
      }
    }

    // Pass 2: Thống kê & loại bỏ Running Header / Footer lặp lại ở lề trên/dưới
    const marginRepeatCounter = new Map<string, number>();
    for (const rp of rawPages) {
      const seenOnPage = new Set<string>();
      for (const line of rp.lines) {
        const inTopMargin = line.y < rp.height * 0.095;
        const inBottomMargin = line.y > rp.height * 0.905;
        if (!inTopMargin && !inBottomMargin) continue;
        if (line.text.length > 90) continue;
        const norm = normalizeHeaderFooterLine(line.text);
        if (norm && !seenOnPage.has(norm)) {
          seenOnPage.add(norm);
          marginRepeatCounter.set(norm, (marginRepeatCounter.get(norm) || 0) + 1);
        }
      }
    }

    const repeatThreshold = Math.max(3, Math.floor(totalPages * 0.25));
    const filteredPages: Array<{
      rp: RawPageExtract;
      cleanLines: PositionedLine[];
    }> = rawPages.map((rp) => {
      const cleanLines = rp.lines.filter((line) => {
        const inTopMargin = line.y < rp.height * 0.095;
        const inBottomMargin = line.y > rp.height * 0.905;
        if (!inTopMargin && !inBottomMargin) return true;
        if (isPurePageNumber(line.text)) return false;
        const norm = normalizeHeaderFooterLine(line.text);
        if (norm && (marginRepeatCounter.get(norm) || 0) >= repeatThreshold) {
          return false;
        }
        return true;
      });
      return { rp, cleanLines };
    });

    // Xác định danh sách chương: ưu tiên Outline, fallback H1 lớn hoặc gộp mỗi 15 trang
    let chapters: PdfChapterInfo[] = outlineChapters;
    if (chapters.length === 0) {
      const detectedStarts: Array<{ title: string; startPage: number }> = [];
      for (const { rp, cleanLines } of filteredPages) {
        const firstBigHeading = cleanLines.find(
          (l) => l.fontSize >= bodyFontSize * 1.48 && l.text.length >= 3 && l.text.length <= 120
        );
        if (firstBigHeading) {
          detectedStarts.push({
            title: firstBigHeading.text,
            startPage: rp.pageNumber,
          });
        }
      }

      if (detectedStarts.length >= 2) {
        chapters = [];
        if (detectedStarts[0].startPage > 1) {
          chapters.push({
            chapterIndex: 0,
            title: 'Mở đầu',
            startPage: 1,
            endPage: detectedStarts[0].startPage - 1,
          });
        }
        for (let i = 0; i < detectedStarts.length; i++) {
          const s = detectedStarts[i].startPage;
          const e =
            i + 1 < detectedStarts.length ? detectedStarts[i + 1].startPage - 1 : totalPages;
          chapters.push({
            chapterIndex: chapters.length,
            title: detectedStarts[i].title,
            startPage: s,
            endPage: Math.max(s, e),
          });
        }
      } else {
        chapters = [];
        const stride = 15;
        for (let start = 1; start <= totalPages; start += stride) {
          const end = Math.min(totalPages, start + stride - 1);
          chapters.push({
            chapterIndex: chapters.length,
            title:
              totalPages <= stride
                ? bookTitle
                : `Phần ${chapters.length + 1} (Trang ${start}–${end})`,
            startPage: start,
            endPage: end,
          });
        }
      }
    }

    const resolveChapterForPage = (pageNum: number): PdfChapterInfo => {
      for (const ch of chapters) {
        if (pageNum >= ch.startPage && pageNum <= ch.endPage) return ch;
      }
      return chapters[chapters.length - 1];
    };

    const pages: PdfParsedPage[] = [];
    let visionPageCount = 0;
    let textOnlyPageCount = 0;

    for (const { rp, cleanLines } of filteredPages) {
      const ch = resolveChapterForPage(rp.pageNumber);
      const blocks = buildPreParsedBlocks(cleanLines, bodyFontSize, rp.width, rp.figurePlacements);
      const rawDigitalText = cleanLines.map((l) => l.text).join('\n');
      const parsedPageDraft: PdfParsedPage = {
        pageNumber: rp.pageNumber,
        chapterIndex: ch.chapterIndex,
        chapterTitle: ch.title,
        rawDigitalText,
        requiresVision: false,
        hasFigures: rp.hasFigures,
        hasTables: rp.hasTables,
        isMultiColumn: rp.isMultiColumn,
        hasMathOrGarbled: rp.hasMathOrGarbled,
        figureAreaRatio: rp.figureAreaRatio,
        assetIds: rp.assetIds,
        blocks,
      };
      const requiresVision = evaluateHybridVisionNeeded(parsedPageDraft, assets);
      parsedPageDraft.requiresVision = requiresVision;

      if (requiresVision) visionPageCount += 1;
      else textOnlyPageCount += 1;

      pages.push(parsedPageDraft);
    }

    return {
      bookTitle,
      bookAuthor,
      bookPublisher,
      totalPages,
      chapters,
      pages,
      assets,
      visionPageCount,
      textOnlyPageCount,
    };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

export function evaluateHybridVisionNeeded(
  page: PdfParsedPage,
  assets?: Record<string, PdfExtractedAsset>
): boolean {
  if (page.hasTables || page.isMultiColumn || page.hasMathOrGarbled) {
    return true;
  }

  const assetCount = page.assetIds?.length || 0;
  if (assetCount === 0) {
    return false;
  }

  const textCharCount = (page.rawDigitalText || '').replace(/\s+/g, ' ').trim().length;
  // Trang ít chữ / trang bìa / trang minh họa nhiều -> dùng Vision
  if (textCharCount < 380) {
    return true;
  }

  let areaRatio = typeof page.figureAreaRatio === 'number' ? page.figureAreaRatio : -1;
  if (areaRatio < 0 && assets) {
    // Ước lượng tương thích ngược cho PDF đã phân tích trước đó (~1.5M px / trang render)
    let totalPx = 0;
    for (const id of page.assetIds) {
      const asset = assets[id];
      if (asset) totalPx += asset.width * asset.height;
    }
    areaRatio = Math.min(1, totalPx / 1_500_000);
  }

  if (areaRatio >= 0) {
    if (areaRatio >= 0.2) return true;
    if (assetCount >= 2 && areaRatio >= 0.12) return true;
    return false;
  }

  return page.requiresVision;
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
  const targetScale = Math.min(1.85, Math.max(1.0, 1120 / Math.max(1, baseVp.width)));
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

    const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
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
