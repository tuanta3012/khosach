import * as pdfjsLib from 'pdfjs-dist';
import {
  ParsedPdfData,
  PdfBlockTag,
  PdfChapterInfo,
  PdfExtractedAsset,
  PdfFigureBox,
  PdfParsedPage,
  PdfPreParsedBlock,
} from '../types';

export const DIGITAL_PDF_PARSER_VERSION = 4;

/**
 * Cơ chế nhường luồng thực sự (dùng scheduler.yield() hoặc setTimeout(0/16))
 * Tránh MessageChannel làm nghẽn BeginMainFrame/Choreographer trên Android WebView.
 */
export async function yieldToEventLoopFast(preferFrameYield = false): Promise<void> {
  const isMainThread = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (preferFrameYield && isMainThread) {
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
    return;
  }

  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sched?.yield === 'function') {
    try {
      await sched.yield();
      return;
    } catch {}
  }

  await new Promise<void>((resolve) => setTimeout(resolve, isMainThread && preferFrameYield ? 16 : 0));
}

export interface PdfCanvasLike {
  width: number;
  height: number;
  getContext(
    contextId: '2d',
    options?: unknown
  ): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}

export interface PdfParserRuntimeAdapter {
  createCanvas: (width: number, height: number) => PdfCanvasLike;
  canvasToJpegBytes: (canvas: PdfCanvasLike, quality?: number) => Promise<Uint8Array>;
  documentOptions?: Record<string, unknown>;
  pageYieldMs?: number;
  isWorker?: boolean;
}

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

interface FigurePlacement {
  assetId: string;
  minY: number;
  maxY: number;
  area: number;
}

export interface CroppedFigureEntry {
  asset: PdfExtractedAsset;
  placement: FigurePlacement;
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

interface CandidateBox extends RectBox {
  hasBitmap: boolean;
  primitiveCount: number;
  complexCount: number;
}

function toMatrix6(raw: unknown): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
    const arr = Array.from(raw as ArrayLike<number>);
    if (arr.length >= 6 && arr.slice(0, 6).every((n) => Number.isFinite(n))) {
      return arr.slice(0, 6);
    }
  }
  return null;
}

function toNumArray(raw: unknown): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
    return Array.from(raw as ArrayLike<number>);
  }
  return null;
}

function mergeNearbyBoxes(boxes: CandidateBox[], pad = 22): CandidateBox[] {
  const filtered = boxes.filter(
    (b) =>
      Number.isFinite(b.minX) &&
      Number.isFinite(b.minY) &&
      b.maxX >= b.minX &&
      b.maxY >= b.minY &&
      (b.maxX > b.minX || b.maxY > b.minY)
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
          a.hasBitmap = a.hasBitmap || b.hasBitmap;
          a.primitiveCount += b.primitiveCount;
          a.complexCount += b.complexCount;
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
  viewport: pdfjsLib.PageViewport,
  hasTables = false
): Promise<RectBox[]> {
  const OPS = pdfjsLib.OPS;
  const opList = await page.getOperatorList();
  const ctmStack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const rawBoxes: CandidateBox[] = [];

  const pageArea = Math.max(1, viewport.width * viewport.height);

  const isNearFullPage = (w: number, h: number) =>
    (w * h > pageArea * 0.68 && w > viewport.width * 0.82 && h > viewport.height * 0.78) ||
    (w > viewport.width * 0.88 && h > viewport.height * 0.85);

  const pushCandidateBox = (
    box: RectBox,
    opts: {
      minMaxSide: number;
      hasBitmap: boolean;
      isComplex?: boolean;
    }
  ) => {
    const clamped: RectBox = {
      minX: Math.max(0, box.minX),
      minY: Math.max(0, box.minY),
      maxX: Math.min(viewport.width, box.maxX),
      maxY: Math.min(viewport.height, box.maxY),
    };
    const w = clamped.maxX - clamped.minX;
    const h = clamped.maxY - clamped.minY;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0 || (w === 0 && h === 0)) return;
    if (Math.max(w, h) < opts.minMaxSide) return;
    if (isNearFullPage(w, h)) return;

    // Bỏ qua đường kẻ ngang/dọc đơn lẻ (gạch chân tiêu đề, đường phân cách header/footer)
    if (!opts.hasBitmap) {
      if ((h < 3 && w > viewport.width * 0.38) || (w < 3 && h > viewport.height * 0.38)) {
        return;
      }
    }

    rawBoxes.push({
      ...clamped,
      hasBitmap: opts.hasBitmap,
      primitiveCount: 1,
      complexCount: opts.isComplex ? 1 : 0,
    });
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (fn === OPS.save) {
      ctmStack.push([...ctm]);
    } else if (fn === OPS.restore) {
      ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform) {
      const m = toMatrix6(args);
      if (m) {
        ctm = pdfjsLib.Util.transform(ctm, m);
      }
    } else if (fn === OPS.paintFormXObjectBegin) {
      ctmStack.push([...ctm]);
      const formMatrix = Array.isArray(args) ? toMatrix6(args[0]) : null;
      if (formMatrix) {
        ctm = pdfjsLib.Util.transform(ctm, formMatrix);
      }
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.beginGroup) {
      ctmStack.push([...ctm]);
      const group = Array.isArray(args) ? (args[0] as Record<string, unknown> | null) : null;
      if (
        group &&
        (group.needsIsolation ||
          group.isolated ||
          group.hasSoftMask ||
          group.knockout ||
          group.isGray)
      ) {
        const gm = toMatrix6(group.matrix);
        if (gm) {
          ctm = pdfjsLib.Util.transform(ctm, gm);
        }
      }
    } else if (fn === OPS.endGroup) {
      ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject ||
      fn === OPS.paintSolidColorImageMask
    ) {
      const fullMatrix = pdfjsLib.Util.transform(viewport.transform, ctm);
      const box = transformBox(fullMatrix, 0, 0, 1, 1);
      pushCandidateBox(box, { minMaxSide: 28, hasBitmap: true, isComplex: true });
    } else if (fn === OPS.paintImageXObjectRepeat && Array.isArray(args)) {
      const scaleX = Number(args[1]);
      const scaleY = Number(args[2]);
      const positions = toNumArray(args[3]);
      if (Number.isFinite(scaleX) && Number.isFinite(scaleY) && positions) {
        for (let p = 0; p + 1 < positions.length; p += 2) {
          const localCtm = pdfjsLib.Util.transform(ctm, [
            scaleX,
            0,
            0,
            scaleY,
            positions[p],
            positions[p + 1],
          ]);
          const fullMatrix = pdfjsLib.Util.transform(viewport.transform, localCtm);
          pushCandidateBox(transformBox(fullMatrix, 0, 0, 1, 1), {
            minMaxSide: 28,
            hasBitmap: true,
            isComplex: true,
          });
        }
      }
    } else if (fn === OPS.paintImageMaskXObjectRepeat && Array.isArray(args)) {
      const scaleX = Number(args[1]);
      const skewX = Number(args[2]) || 0;
      const skewY = Number(args[3]) || 0;
      const scaleY = Number(args[4]);
      const positions = toNumArray(args[5]);
      if (Number.isFinite(scaleX) && Number.isFinite(scaleY) && positions) {
        for (let p = 0; p + 1 < positions.length; p += 2) {
          const localCtm = pdfjsLib.Util.transform(ctm, [
            scaleX,
            skewX,
            skewY,
            scaleY,
            positions[p],
            positions[p + 1],
          ]);
          const fullMatrix = pdfjsLib.Util.transform(viewport.transform, localCtm);
          pushCandidateBox(transformBox(fullMatrix, 0, 0, 1, 1), {
            minMaxSide: 28,
            hasBitmap: true,
            isComplex: true,
          });
        }
      }
    } else if (fn === OPS.paintImageMaskXObjectGroup && Array.isArray(args) && Array.isArray(args[0])) {
      for (const item of args[0] as Array<{ transform?: unknown }>) {
        const m = toMatrix6(item?.transform);
        if (!m) continue;
        const localCtm = pdfjsLib.Util.transform(ctm, m);
        const fullMatrix = pdfjsLib.Util.transform(viewport.transform, localCtm);
        pushCandidateBox(transformBox(fullMatrix, 0, 0, 1, 1), {
          minMaxSide: 24,
          hasBitmap: true,
          isComplex: true,
        });
      }
    } else if (
      fn === OPS.paintInlineImageXObjectGroup &&
      Array.isArray(args) &&
      Array.isArray(args[1])
    ) {
      for (const entry of args[1] as Array<{ transform?: unknown }>) {
        const m = toMatrix6(entry?.transform);
        if (!m) continue;
        const localCtm = pdfjsLib.Util.transform(ctm, m);
        const fullMatrix = pdfjsLib.Util.transform(viewport.transform, localCtm);
        pushCandidateBox(transformBox(fullMatrix, 0, 0, 1, 1), {
          minMaxSide: 24,
          hasBitmap: true,
          isComplex: true,
        });
      }
    } else if (fn === OPS.constructPath && Array.isArray(args)) {
      const pathOp = args[0];
      // OPS.endPath (28) là clip path / không vẽ nét hay tô màu
      if (pathOp === OPS.endPath) continue;

      let minPx = Infinity;
      let minPy = Infinity;
      let maxPx = -Infinity;
      let maxPy = -Infinity;
      let isComplex = false;

      // Định dạng pdfjs-dist v6+: args = [op, [Float32Array | Path2D], minMax]
      const minMax = toNumArray(args[2]);
      if (minMax && minMax.length >= 4) {
        [minPx, minPy, maxPx, maxPy] = minMax;
        const dataFirst = Array.isArray(args[1]) ? toNumArray(args[1][0]) : null;
        if (dataFirst && dataFirst.length >= 15) {
          isComplex = true;
        }
      } else {
        // Fallback nếu dữ liệu dạng mảng tọa độ phẳng [x0, y0, ...]
        const coords = toNumArray(args[1]);
        if (coords && coords.length >= 4 && typeof coords[0] === 'number') {
          for (let k = 0; k + 1 < coords.length; k += 2) {
            const px = coords[k];
            const py = coords[k + 1];
            if (Number.isFinite(px) && Number.isFinite(py)) {
              if (px < minPx) minPx = px;
              if (py < minPy) minPy = py;
              if (px > maxPx) maxPx = px;
              if (py > maxPy) maxPy = py;
            }
          }
          if (coords.length >= 10) isComplex = true;
        }
      }

      if (
        Number.isFinite(minPx) &&
        Number.isFinite(minPy) &&
        Number.isFinite(maxPx) &&
        Number.isFinite(maxPy) &&
        (maxPx > minPx || maxPy > minPy)
      ) {
        const fullMatrix = pdfjsLib.Util.transform(viewport.transform, ctm);
        const box = transformBox(fullMatrix, minPx, minPy, maxPx, maxPy);
        pushCandidateBox(box, {
          minMaxSide: 10,
          hasBitmap: false,
          isComplex,
        });
      }
    }
  }

  const merged = mergeNearbyBoxes(rawBoxes, 22);
  return merged
    .filter((b) => {
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      const area = w * h;
      if (isNearFullPage(w, h) || (area > pageArea * 0.72 && w > viewport.width * 0.85)) {
        return false;
      }
      if (b.hasBitmap) {
        return w >= 34 && h >= 26;
      }
      if (w < 52 || h < 40) return false;
      if (b.complexCount === 0 && b.primitiveCount < 3) return false;
      if (hasTables && b.complexCount === 0 && b.primitiveCount >= 4) return false;
      return true;
    })
    .map(({ minX, minY, maxX, maxY }) => ({ minX, minY, maxX, maxY }))
    .sort((a, b) => a.minY - b.minY || a.minX - b.minX)
    .slice(0, 8);
}

export async function cropFiguresFromPage(
  page: pdfjsLib.PDFPageProxy,
  pageNumber: number,
  baseViewport: pdfjsLib.PageViewport,
  boxes: Array<{ minX: number; minY: number; maxX: number; maxY: number; assetId?: string }>,
  adapter: PdfParserRuntimeAdapter
): Promise<CroppedFigureEntry[]> {
  if (boxes.length === 0) return [];

  const maxBaseSide = Math.max(baseViewport.width, baseViewport.height, 1);
  const targetScale = Math.min(
    2.0,
    Math.max(0.75, Math.min(1600 / Math.max(1, baseViewport.width), 1800 / maxBaseSide))
  );
  const renderViewport = page.getViewport({ scale: targetScale });
  const pageCanvas = adapter.createCanvas(
    Math.max(1, Math.round(renderViewport.width)),
    Math.max(1, Math.round(renderViewport.height))
  );

  const extracted: CroppedFigureEntry[] = [];
  try {
    await page.render({
      canvas: pageCanvas as unknown as HTMLCanvasElement,
      viewport: renderViewport,
      background: '#ffffff',
      annotationMode: 0,
      intent: 'print', // Bắt buộc intent: 'print' để tắt useRequestAnimationFrame, tránh bị treo trên Android WebView khi không chạm màn hình
    } as any).promise;

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

      const cropCanvas = adapter.createCanvas(cw, ch);
      const cropCtx =
        cropCanvas.getContext('2d', { alpha: false, willReadFrequently: true }) ||
        cropCanvas.getContext('2d');
      if (!cropCtx) {
        cropCanvas.width = 0;
        cropCanvas.height = 0;
        throw new Error('Không khởi tạo được canvas 2D để cắt ảnh PDF.');
      }

      try {
        cropCtx.fillStyle = '#ffffff';
        cropCtx.fillRect(0, 0, cw, ch);
        cropCtx.drawImage(
          pageCanvas as unknown as CanvasImageSource,
          sx,
          sy,
          cw,
          ch,
          0,
          0,
          cw,
          ch
        );
        const bytes = await adapter.canvasToJpegBytes(cropCanvas, 0.86);
        if (!bytes || bytes.byteLength < 32) {
          throw new Error(`Dữ liệu ảnh cắt trang ${pageNumber} bị rỗng.`);
        }
        const assetId = b.assetId || `p${pageNumber}_fig${i + 1}`;
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
      } finally {
        cropCanvas.width = 0;
        cropCanvas.height = 0;
      }
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

  const hasTables = tableLikeRows >= 2;
  const isMultiColumn = multiGapRows >= 3 || (leftColCount >= 4 && rightColCount >= 4);
  return { isMultiColumn, hasTables };
}

function detectMathOrGarbledText(text: string): boolean {
  if (!text) return false;
  if (text.includes('\uFFFD')) return true;
  if (/[\uE000-\uF8FF]/.test(text)) return true;
  const mathMatches = text.match(/[∑∏∫∂∇≈≠≤≥∞√∈∉⊂⊃∪∩∀∃αβγδεθλμπσφψω]/g);
  return (mathMatches?.length || 0) >= 3;
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
      if (lineTag !== curTag || line.y - prevLine.y > line.fontSize * 1.55) {
        shouldBreak = true;
      }
    } else if (isListStart) {
      shouldBreak = true;
    } else if (
      lineTag !== curTag &&
      !(curTag === 'ul' && lineTag === 'p') &&
      !(curTag === 'ol' && lineTag === 'p')
    ) {
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

export function evaluateHybridVisionNeeded(
  page: PdfParsedPage,
  assets?: Record<string, PdfExtractedAsset>
): boolean {
  // 1. Trang có bất kỳ hình ảnh, hình vẽ, sơ đồ vector hoặc asset nào được phát hiện
  if (page.hasFigures || (page.assetIds && page.assetIds.length > 0)) {
    return true;
  }
  if (page.blocks && page.blocks.some((b) => b.isFigure || b.tag === 'figure' || Boolean(b.assetId))) {
    return true;
  }

  // 2. Trang có bảng biểu hoặc bố cục đa cột (báo chí, tài liệu kỹ thuật, bảng dữ liệu)
  if (page.hasTables || page.isMultiColumn) {
    return true;
  }
  if (page.blocks && page.blocks.some((b) => b.tag === 'table')) {
    return true;
  }

  // 3. Trang có công thức toán học, ký hiệu đặc biệt hoặc chữ số hóa lỗi font
  if (page.hasMathOrGarbled) {
    return true;
  }

  // 4. Trang có khối mã nguồn (code block / preformatted text)
  const codeBlockCount = (page.blocks || []).filter((b) => b.tag === 'pre').length;
  if (codeBlockCount > 0) {
    return true;
  }

  // 5. Trang chữ ngắn, trang bìa, lời tựa, ngắt chương, hộp chú ý (callout)
  const textCharCount = (page.rawDigitalText || '').replace(/\s+/g, ' ').trim().length;
  if (textCharCount < 520) {
    return true;
  }

  // 6. Tỷ lệ diện tích hình vẽ/sơ đồ trên trang > 2%
  if (typeof page.figureAreaRatio === 'number' && page.figureAreaRatio > 0.02) {
    return true;
  }
  if (assets && page.assetIds && page.assetIds.length > 0) {
    return true;
  }

  // 7. Trang có cấu trúc phân tầng phức tạp (nhiều tiêu đề, trích dẫn, danh sách)
  const nonPBlocks = (page.blocks || []).filter((b) => b.tag !== 'p').length;
  if (nonPBlocks >= 3) {
    return true;
  }

  // 8. Định dạng nhiều dòng ngắn bất thường (dạng thơ, danh lục, chú giải)
  if (page.blocks && page.blocks.length >= 8 && textCharCount / page.blocks.length < 45) {
    return true;
  }

  return Boolean(page.requiresVision);
}

export async function parseDigitalPdfCore(
  arrayBuffer: ArrayBuffer,
  fileName: string,
  adapter: PdfParserRuntimeAdapter,
  onProgress?: (currentPage: number, totalPages: number) => void,
  stopSignal?: { current: boolean }
): Promise<ParsedPdfData> {
  const bytesCopy = new Uint8Array(arrayBuffer.slice(0));
  const loadingTask = pdfjsLib.getDocument({
    data: bytesCopy,
    ...(adapter.documentOptions || {}),
  } as any);

  let pdfDoc: pdfjsLib.PDFDocumentProxy;
  try {
    pdfDoc = await loadingTask.promise;
  } catch (loadErr: unknown) {
    const errName = (loadErr as { name?: string })?.name || '';
    const errMsg = loadErr instanceof Error ? loadErr.message : String(loadErr || '');
    if (errName === 'PasswordException' || /password/i.test(errMsg)) {
      throw new Error('File PDF có mật khẩu bảo vệ, không thể tách nội dung.');
    }
    throw loadErr;
  }

  try {
    const totalPages = pdfDoc.numPages;
    if (totalPages <= 0) {
      throw new Error('File PDF không có trang nào.');
    }

    // Kiểm tra lớp chữ Digital trên nhiều vị trí (tránh loại nhầm sách có nhiều trang bìa/mục lục ảnh ở đầu)
    const samplePagesSet = new Set<number>();
    for (let p = 1; p <= Math.min(5, totalPages); p++) {
      samplePagesSet.add(p);
    }
    if (totalPages > 5) {
      for (const p of [
        6,
        7,
        Math.round(totalPages * 0.15),
        Math.round(totalPages * 0.3),
        Math.round(totalPages * 0.5),
        Math.round(totalPages * 0.7),
        Math.round(totalPages * 0.85),
      ]) {
        if (p >= 1 && p <= totalPages) samplePagesSet.add(p);
      }
    }

    let sampleCharCount = 0;
    let maxSamplePageChars = 0;
    for (const p of samplePagesSet) {
      if (stopSignal?.current) throw new Error('Đã hủy tách trang theo yêu cầu.');
      try {
        const page = await pdfDoc.getPage(p);
        const tc = await page.getTextContent();
        const text = tc.items
          .map((it: any) => (typeof it?.str === 'string' ? it.str : ''))
          .join('')
          .replace(/\s+/g, '');
        sampleCharCount += text.length;
        if (text.length > maxSamplePageChars) maxSamplePageChars = text.length;
        if (sampleCharCount >= 80 || maxSamplePageChars >= 30) {
          break;
        }
      } catch {}
    }

    if (sampleCharCount < 35 && maxSamplePageChars < 20) {
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
      figureBoxes: PdfFigureBox[];
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
    let figureDetectErrors = 0;
    let totalDetectedBoxes = 0;

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      if (stopSignal?.current) {
        throw new Error('Đã hủy tách trang theo yêu cầu.');
      }

      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent().catch(() => ({ items: [], styles: {} as Record<string, { fontFamily?: string }> }));

      const runs: PositionedTextRun[] = [];
      for (const rawItem of tc.items || []) {
        const item = rawItem as any;
        if (typeof item?.str !== 'string' || !item.str) continue;
        if (!item.str.trim() && item.str.length <= 1) continue;
        if (!Array.isArray(item.transform) || item.transform.length < 6) continue;

        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        if (!Number.isFinite(tx[4]) || !Number.isFinite(tx[5])) continue;

        const fontSize = Math.max(
          5,
          Math.round((Math.hypot(tx[0], tx[1]) || item.height || 11) * 10) / 10
        );
        const family = (tc.styles?.[item.fontName]?.fontFamily || item.fontName || '').toLowerCase();

        runs.push({
          str: item.str,
          x: tx[4],
          y: tx[5],
          width: Math.max(0, Number(item.width) || 0),
          height: Math.max(fontSize, Number(item.height) || fontSize),
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

      const assetIds: string[] = [];
      const figureBoxes: PdfFigureBox[] = [];
      const figurePlacements: FigurePlacement[] = [];
      let totalFigureArea = 0;

      try {
        const detectedBoxes = await detectPageFigureBoxes(page, viewport, hasTables);
        totalDetectedBoxes += detectedBoxes.length;
        for (let fIdx = 0; fIdx < detectedBoxes.length; fIdx++) {
          const b = detectedBoxes[fIdx];
          const assetId = `p${pageNumber}_fig${fIdx + 1}`;
          const area = Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
          assetIds.push(assetId);
          figureBoxes.push({
            assetId,
            minX: Math.round(b.minX),
            minY: Math.round(b.minY),
            maxX: Math.round(b.maxX),
            maxY: Math.round(b.maxY),
          });
          figurePlacements.push({
            assetId,
            minY: b.minY,
            maxY: b.maxY,
            area,
          });
          totalFigureArea += area;
        }
      } catch (figErr) {
        figureDetectErrors += 1;
        console.warn(`[PdfParser] Bỏ qua dò khung hình trang ${pageNumber}:`, figErr);
        if (
          adapter.isWorker &&
          totalDetectedBoxes === 0 &&
          (pageNumber <= 5 || figureDetectErrors >= 3)
        ) {
          throw new Error('Worker gặp lỗi dò khung hình ảnh PDF, chuyển về luồng chính.');
        }
      }

      const pageArea = Math.max(1, viewport.width * viewport.height);
      const figureAreaRatio = Math.min(1, Math.round((totalFigureArea / pageArea) * 1000) / 1000);

      rawPages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        lines,
        assetIds,
        figureBoxes,
        figurePlacements,
        figureAreaRatio,
        hasFigures: assetIds.length > 0,
        isMultiColumn,
        hasTables,
        hasMathOrGarbled,
      });

      if (onProgress) {
        onProgress(pageNumber, totalPages);
      }
      if (!adapter.isWorker || pageNumber % 3 === 0 || pageNumber === totalPages) {
        await yieldToEventLoopFast(!adapter.isWorker && pageNumber % 2 === 0);
      }
    }

    let bodyFontSize = 11;
    let bestWeight = -1;
    for (const [size, weight] of fontSizeFreq.entries()) {
      if (size >= 7 && size <= 16 && weight > bestWeight) {
        bestWeight = weight;
        bodyFontSize = size;
      }
    }

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
        figureBoxes: rp.figureBoxes,
        blocks,
      };
      const requiresVision = evaluateHybridVisionNeeded(parsedPageDraft, assets);
      parsedPageDraft.requiresVision = requiresVision;

      if (requiresVision) visionPageCount += 1;
      else textOnlyPageCount += 1;

      pages.push(parsedPageDraft);
    }

    return {
      parserVersion: DIGITAL_PDF_PARSER_VERSION,
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
