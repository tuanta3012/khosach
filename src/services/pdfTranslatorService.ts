import * as pdfjsLib from 'pdfjs-dist';
import {
  EpubGenreId,
  EpubTranslationJob,
  EpubTranslationProgress,
  ParsedPdfData,
  PdfBlockTag,
  PdfParsedPage,
  PdfProcessingMode,
  PdfTranslatedBlock,
  PdfTranslationUnit,
} from '../types';
import {
  buildTranslationChannelSlots,
  EPUB_TRANSLATION_MODEL,
  executeEpubFlashLiteWithKey,
  executePdfVisionFlashLiteWithKey,
  getAvailableEpubTranslationKeys,
  TranslationChannelSlot,
} from './geminiService';
import { getEpubGenreConfig } from './epubTranslatorService';
import { recordPdfUnitCheckpoint, updateEpubJobMetadata } from './epubCheckpointDb';
import { buildPdfTranslationUnits, renderPdfPageForVision } from './pdfDigitalService';

const MAX_RETRIES_PER_UNIT = 5;
const TEXT_HEDGE_DELAY_MS = 13_000;
const VISION_HEDGE_DELAY_MS = 16_000;

const ALLOWED_BLOCK_TAGS = new Set<PdfBlockTag>([
  'h1',
  'h2',
  'h3',
  'p',
  'blockquote',
  'ul',
  'ol',
  'pre',
  'table',
  'figure',
]);

const VISION_PAGE_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      tag: {
        type: 'STRING',
        enum: ['h1', 'h2', 'h3', 'p', 'blockquote', 'ul', 'ol', 'pre', 'table', 'figure'],
      },
      html: {
        type: 'STRING',
        description: 'Nội dung đã dịch tiếng Việt hoặc mã [[PDF_IMG_...]] cho hình ảnh',
      },
    },
    required: ['tag', 'html'],
  },
};

const TEXT_CHUNK_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      page: { type: 'INTEGER' },
      blockId: { type: 'INTEGER' },
      tag: {
        type: 'STRING',
        enum: ['h1', 'h2', 'h3', 'p', 'blockquote', 'ul', 'ol', 'pre', 'table', 'figure'],
      },
      translated: { type: 'STRING' },
    },
    required: ['page', 'blockId', 'tag', 'translated'],
  },
};

function buildPdfVisionSystemInstruction(
  genreId: EpubGenreId,
  customNotes?: string
): string {
  const genre = getEpubGenreConfig(genreId);
  const cleanNotes = (customNotes || '').trim();

  return [
    `Bạn là dịch giả sách chuyên nghiệp sang tiếng Việt, chuyên thể loại: ${genre.label}.`,
    `VĂN PHONG: ${genre.stylePrompt}`,
    `NHIỆM VỤ: Đọc ảnh trang sách PDF Digital kết hợp lớp chữ số hóa neo kèm theo để đọc đúng thứ tự cột/bảng biểu/chú thích và dịch toàn bộ sang tiếng Việt tự nhiên, chuẩn xác.`,
    `QUY TẮC BẮT BUỘC:`,
    `1. Dùng ảnh để xác định đúng cấu trúc bố cục (đa cột, bảng biểu, tiêu đề, trích dẫn, khối code, vị trí hình minh họa) và đối chiếu lớp text số hóa để đảm bảo không sai tên riêng, số liệu, ký hiệu, công thức.`,
    `2. Dịch THUẦN TIẾNG VIỆT đầy đủ, không tóm tắt, không lược bỏ nội dung hay thêm bình luận. Bỏ qua số trang hoặc tiêu đề lặp ở mép trên/dưới cùng của trang.`,
    `3. Với bảng biểu, trả tag "table" với HTML sạch (<table><thead><tr><th>...</th></tr></thead><tbody><tr><td>...</td></tr></tbody></table>) đã dịch toàn bộ sang tiếng Việt.`,
    `4. Với khối code, trả tag "pre" giữ nguyên mã lệnh, chỉ dịch chú thích nếu cần.`,
    `5. BẮT BUỘC đặt đúng các mã ảnh [[PDF_IMG_...]] được cung cấp (nếu trang có ảnh) tại đúng vị trí xuất hiện trong bài với tag "figure" và html đúng bằng mã "[[PDF_IMG_...]]".`,
    cleanNotes ? `6. GHI CHÚ RIÊNG:\n${cleanNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildPdfTextSystemInstruction(
  genreId: EpubGenreId,
  customNotes?: string
): string {
  const genre = getEpubGenreConfig(genreId);
  const cleanNotes = (customNotes || '').trim();

  return [
    `Bạn là dịch giả sách chuyên nghiệp sang tiếng Việt, chuyên thể loại: ${genre.label}.`,
    `VĂN PHONG: ${genre.stylePrompt}`,
    `QUY TẮC:`,
    `1. Dịch THUẦN TIẾNG VIỆT tự nhiên, đầy đủ, không tóm tắt hay thêm chú thích ngoài văn bản gốc.`,
    `2. Giữ nguyên cấu trúc phần tử { page, blockId, tag } khớp 1-1 với danh sách đầu vào; giữ nguyên mọi mã [[PDF_IMG_...]] nếu có.`,
    `3. Với tag "pre", giữ nguyên mã lệnh lập trình.`,
    cleanNotes ? `4. GHI CHÚ RIÊNG:\n${cleanNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function sanitizeTag(raw: unknown): PdfBlockTag {
  const str = String(raw || '').toLowerCase() as PdfBlockTag;
  return ALLOWED_BLOCK_TAGS.has(str) ? str : 'p';
}

function ensurePageAssetsIncluded(
  blocks: PdfTranslatedBlock[],
  assetIds: string[]
): PdfTranslatedBlock[] {
  if (!assetIds || assetIds.length === 0) return blocks;
  const serializedAll = blocks.map((b) => b.html).join('\n');
  const next = [...blocks];

  for (const assetId of assetIds) {
    const token = `[[PDF_IMG_${assetId}]]`;
    if (!serializedAll.includes(token)) {
      next.push({ tag: 'figure', html: token });
    }
  }
  return next;
}

export interface RunPdfTranslationOptions {
  job: EpubTranslationJob;
  parsedPdf: ParsedPdfData;
  processingMode: PdfProcessingMode;
  genre: EpubGenreId;
  customNotes: string;
  stopSignal: { current: boolean };
  getElapsedMs?: () => number;
  onProgress: (progress: EpubTranslationProgress) => void;
  onJobStateSync?: (updates: {
    translatedPdfPages: Record<number, PdfTranslatedBlock[]>;
    completedChunkIds: number[];
    failedChunkIds: number[];
  }) => void;
}

export interface RunPdfTranslationResult {
  completed: boolean;
  stopped: boolean;
  translatedPdfPages: Record<number, PdfTranslatedBlock[]>;
  completedChunkIds: number[];
  failedChunkIds: number[];
  errorMessage?: string;
}

interface InFlightPdfUnitEntry {
  unitIdx: number;
  startedAt: number;
  ownerKeys: Set<string>;
  ownerModels: Set<string>;
  activeAttempts: number;
  abortControllers: AbortController[];
}

export async function runParallelPdfTranslation(
  options: RunPdfTranslationOptions
): Promise<RunPdfTranslationResult> {
  const {
    job,
    parsedPdf,
    processingMode,
    genre,
    customNotes,
    stopSignal,
    getElapsedMs,
    onProgress,
    onJobStateSync,
  } = options;

  const availableKeys = getAvailableEpubTranslationKeys();
  const units: PdfTranslationUnit[] =
    job.pdfUnits && job.pdfUnits.length > 0 && job.pdfProcessingMode === processingMode
      ? job.pdfUnits
      : buildPdfTranslationUnits(parsedPdf, processingMode);

  const totalUnits = units.length;
  const totalPages = parsedPdf.totalPages;
  const translatedPdfPages: Record<number, PdfTranslatedBlock[]> = {
    ...(job.translatedPdfPages || {}),
  };
  const completedUnitSet = new Set<number>(job.completedChunkIds || []);
  const failedUnitSet = new Set<number>();

  if (availableKeys.length === 0) {
    return {
      completed: false,
      stopped: false,
      translatedPdfPages,
      completedChunkIds: Array.from(completedUnitSet),
      failedChunkIds: job.failedChunkIds || [],
      errorMessage: 'Chưa có API Key khả dụng.',
    };
  }

  const pageMap = new Map<number, PdfParsedPage>();
  for (const p of parsedPdf.pages) {
    pageMap.set(p.pageNumber, p);
  }

  const pendingQueue: number[] = [];
  for (const u of units) {
    if (!completedUnitSet.has(u.unitIndex)) {
      pendingQueue.push(u.unitIndex);
    }
  }

  if (pendingQueue.length === 0) {
    return {
      completed: true,
      stopped: false,
      translatedPdfPages,
      completedChunkIds: Array.from(completedUnitSet),
      failedChunkIds: [],
    };
  }

  // Đặt các trang Vision lên đầu hàng đợi để giảm thiểu nguy cơ kẹt nút cổ chai ở cuối sách
  pendingQueue.sort((aIdx, bIdx) => {
    const aVision = units[aIdx]?.kind === 'vision-page' ? 0 : 1;
    const bVision = units[bIdx]?.kind === 'vision-page' ? 0 : 1;
    if (aVision !== bVision) return aVision - bVision;
    return aIdx - bIdx;
  });

  await updateEpubJobMetadata(job.jobId, {
    genre,
    customNotes,
    pdfProcessingMode: processingMode,
    pdfUnits: units,
    status: 'translating',
    failedChunkIds: [],
    lastError: undefined,
  });

  const visionSystemInstruction = buildPdfVisionSystemInstruction(genre, customNotes);
  const textSystemInstruction = buildPdfTextSystemInstruction(genre, customNotes);

  const channelSlots: TranslationChannelSlot[] = buildTranslationChannelSlots(availableKeys, 12);
  if (channelSlots.length === 0) {
    return {
      completed: false,
      stopped: false,
      translatedPdfPages,
      completedChunkIds: Array.from(completedUnitSet),
      failedChunkIds: job.failedChunkIds || [],
      errorMessage: 'Không có kênh API nào khả dụng.',
    };
  }

  const finishedSignal = { current: false };
  const effectiveStopSignal = {
    get current() {
      return Boolean(stopSignal.current || finishedSignal.current);
    },
  };

  const unitRetryCounts = new Map<number, number>();
  const inFlightUnits = new Map<number, InFlightPdfUnitEntry>();
  const renderedPageCache = new Map<number, Promise<{ base64: string; mimeType: 'image/jpeg' }>>();
  const activeCheckpointWrites = new Set<Promise<void>>();

  let activeWorkersCount = channelSlots.length;
  let lastFatalOrKeyError = '';

  const countCompletedPages = () => Object.keys(translatedPdfPages).length;

  const emitProgress = (statusMessage: string) => {
    onProgress({
      completedChunks: completedUnitSet.size,
      totalChunks: totalUnits,
      completedSegments: Math.min(totalPages, countCompletedPages()),
      totalSegments: totalPages,
      failedChunks: failedUnitSet.size,
      activeWorkers: Math.max(1, activeWorkersCount),
      totalKeys: availableKeys.length,
      statusMessage,
    });
  };

  emitProgress(`Đang dịch PDF (${channelSlots.length} luồng · ${availableKeys.length} key)...`);

  // Mở PDFDocumentProxy dùng chung chỉ khi có đơn vị Vision cần dựng ảnh trang cuốn chiếu
  const hasPendingVision = pendingQueue.some((idx) => units[idx]?.kind === 'vision-page');
  let sharedPdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
  let sharedLoadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
  if (hasPendingVision) {
    const bytesCopy = new Uint8Array(job.epubBuffer.slice(0));
    sharedLoadingTask = pdfjsLib.getDocument({ data: bytesCopy });
    sharedPdfDoc = await sharedLoadingTask.promise;
  }

  // Tuần tự hóa thao tác vẽ canvas renderPdfPageForVision để giữ RAM mobile ổn định
  let renderMutex: Promise<void> = Promise.resolve();
  const renderPageSerialized = async (pageNumber: number) => {
    if (!sharedPdfDoc) throw new Error('Không mở được tài liệu PDF.');
    if (effectiveStopSignal.current) throw new Error('ABORTED');
    let release!: () => void;
    const prev = renderMutex;
    renderMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      if (effectiveStopSignal.current) throw new Error('ABORTED');
      return await renderPdfPageForVision(sharedPdfDoc, pageNumber);
    } finally {
      release();
    }
  };

  const getOrRenderVisionPage = (pageNumber: number) => {
    let cached = renderedPageCache.get(pageNumber);
    if (!cached) {
      cached = renderPageSerialized(pageNumber).catch((err) => {
        renderedPageCache.delete(pageNumber);
        throw err;
      });
      renderedPageCache.set(pageNumber, cached);
    }
    return cached;
  };

  const translateVisionUnit = async (
    unit: PdfTranslationUnit,
    apiKey: string,
    preferredModels: string[],
    timeoutMs: number,
    abortSignal: AbortSignal
  ): Promise<{
    success: boolean;
    pageUpdates?: Record<number, PdfTranslatedBlock[]>;
    aborted?: boolean;
    keyExhausted?: boolean;
    rateLimited?: boolean;
    retryable?: boolean;
    error?: string;
  }> => {
    const pageNum = unit.pageNumbers[0];
    const pageData = pageMap.get(pageNum);
    if (!pageData) {
      return { success: true, pageUpdates: { [pageNum]: [] } };
    }

    const rendered = await getOrRenderVisionPage(pageNum);
    if (effectiveStopSignal.current || abortSignal.aborted) {
      return { success: false, aborted: true, retryable: true };
    }

    const assetTokensDesc =
      pageData.assetIds.length > 0
        ? `Ảnh đã cắt sẵn trên trang: ${pageData.assetIds.map((id) => `[[PDF_IMG_${id}]]`).join(', ')}`
        : 'Không có ảnh nhúng.';

    const promptText = [
      `Trang ${pageNum}/${totalPages} · Chương: ${pageData.chapterTitle}`,
      assetTokensDesc,
      `<digital_text>\n${pageData.rawDigitalText || '(Không có chữ số hóa)'}\n</digital_text>`,
      `Hãy dịch toàn bộ nội dung trang này sang tiếng Việt tự nhiên theo mảng JSON [{tag, html}].`,
    ].join('\n\n');

    const res = await executePdfVisionFlashLiteWithKey({
      key: apiKey,
      systemInstruction: visionSystemInstruction,
      promptText,
      imageBase64: rendered.base64,
      imageMimeType: rendered.mimeType,
      responseSchema: VISION_PAGE_RESPONSE_SCHEMA,
      preferredModels,
      timeoutMs,
      abortSignal,
      stopSignal: effectiveStopSignal,
    });

    if (effectiveStopSignal.current || res.aborted || abortSignal.aborted) {
      return { success: false, aborted: true, retryable: true };
    }

    if (!res.success || !Array.isArray(res.data)) {
      return {
        success: false,
        keyExhausted: res.keyExhausted,
        rateLimited: res.rateLimited,
        retryable: res.retryable,
        error: res.error,
      };
    }

    const rawBlocks: PdfTranslatedBlock[] = [];
    for (const item of res.data) {
      if (item && typeof item.html === 'string' && item.html.trim()) {
        rawBlocks.push({
          tag: sanitizeTag(item.tag),
          html: item.html.trim(),
        });
      }
    }

    const safeguarded = ensurePageAssetsIncluded(rawBlocks, pageData.assetIds);
    return {
      success: true,
      pageUpdates: { [pageNum]: safeguarded },
    };
  };

  interface TextInputItem {
    page: number;
    blockId: number;
    tag: PdfBlockTag;
    text: string;
  }

  const translateTextItemsBatch = async (
    items: TextInputItem[],
    apiKey: string,
    preferredModels: string[],
    timeoutMs: number,
    abortSignal: AbortSignal
  ): Promise<{
    success: boolean;
    translatedMap: Map<string, { tag: PdfBlockTag; html: string }>;
    aborted?: boolean;
    keyExhausted?: boolean;
    rateLimited?: boolean;
    retryable?: boolean;
    error?: string;
  }> => {
    const prompt = `Dịch ${items.length} khối văn bản sau sang tiếng Việt, giữ nguyên {page, blockId, tag} và mã [[PDF_IMG_...]]:\n${JSON.stringify(items)}`;

    const res = await executeEpubFlashLiteWithKey({
      key: apiKey,
      systemInstruction: textSystemInstruction,
      promptText: prompt,
      responseSchema: TEXT_CHUNK_RESPONSE_SCHEMA,
      preferredModels,
      timeoutMs,
      abortSignal,
      stopSignal: effectiveStopSignal,
    });

    const outMap = new Map<string, { tag: PdfBlockTag; html: string }>();
    if (effectiveStopSignal.current || res.aborted || abortSignal.aborted) {
      return { success: false, translatedMap: outMap, aborted: true, retryable: true };
    }

    if (!res.success || !Array.isArray(res.data)) {
      return {
        success: false,
        translatedMap: outMap,
        keyExhausted: res.keyExhausted,
        rateLimited: res.rateLimited,
        retryable: res.retryable,
        error: res.error,
      };
    }

    for (const item of res.data) {
      if (
        item &&
        typeof item.page === 'number' &&
        typeof item.blockId === 'number' &&
        typeof item.translated === 'string' &&
        item.translated.trim()
      ) {
        outMap.set(`${item.page}_${item.blockId}`, {
          tag: sanitizeTag(item.tag),
          html: item.translated.trim(),
        });
      }
    }

    return { success: true, translatedMap: outMap };
  };

  const translateTextChunkUnit = async (
    unit: PdfTranslationUnit,
    apiKey: string,
    preferredModels: string[],
    attemptsBefore: number,
    timeoutMs: number,
    abortSignal: AbortSignal
  ): Promise<{
    success: boolean;
    pageUpdates?: Record<number, PdfTranslatedBlock[]>;
    aborted?: boolean;
    keyExhausted?: boolean;
    rateLimited?: boolean;
    retryable?: boolean;
    error?: string;
  }> => {
    const inputItems: TextInputItem[] = [];
    const figureBlocksByPage = new Map<number, PdfTranslatedBlock[]>();

    for (const pageNum of unit.pageNumbers) {
      const p = pageMap.get(pageNum);
      if (!p) continue;
      for (const b of p.blocks) {
        if (b.isFigure || b.tag === 'figure') {
          const list = figureBlocksByPage.get(pageNum) || [];
          list.push({ tag: 'figure', html: b.text });
          figureBlocksByPage.set(pageNum, list);
        } else {
          inputItems.push({
            page: pageNum,
            blockId: b.blockId,
            tag: b.tag,
            text: b.text,
          });
        }
      }
    }

    if (inputItems.length === 0) {
      const pageUpdates: Record<number, PdfTranslatedBlock[]> = {};
      for (const pageNum of unit.pageNumbers) {
        pageUpdates[pageNum] = figureBlocksByPage.get(pageNum) || [];
      }
      return { success: true, pageUpdates };
    }

    let finalMap = new Map<string, { tag: PdfBlockTag; html: string }>();

    if (attemptsBefore >= 2 && inputItems.length > 4) {
      const half = Math.ceil(inputItems.length / 2);
      const halves = [inputItems.slice(0, half), inputItems.slice(half)];
      for (const part of halves) {
        if (part.length === 0) continue;
        const r = await translateTextItemsBatch(
          part,
          apiKey,
          [EPUB_TRANSLATION_MODEL],
          timeoutMs,
          abortSignal
        );
        if (!r.success) return r;
        r.translatedMap.forEach((v, k) => finalMap.set(k, v));
      }
    } else {
      const r = await translateTextItemsBatch(
        inputItems,
        apiKey,
        preferredModels,
        timeoutMs,
        abortSignal
      );
      if (!r.success) return r;
      finalMap = r.translatedMap;

      // Chỉ dịch bù đúng những block bị thiếu thay vì gửi lại toàn bộ chunk
      const missingItems = inputItems.filter(
        (it) => !finalMap.has(`${it.page}_${it.blockId}`)
      );
      if (missingItems.length > Math.max(1, Math.floor(inputItems.length * 0.15))) {
        const deltaRes = await translateTextItemsBatch(
          missingItems,
          apiKey,
          [EPUB_TRANSLATION_MODEL],
          timeoutMs,
          abortSignal
        );
        if (deltaRes.success) {
          deltaRes.translatedMap.forEach((v, k) => finalMap.set(k, v));
        }
      }
    }

    const pageUpdates: Record<number, PdfTranslatedBlock[]> = {};
    for (const pageNum of unit.pageNumbers) {
      const p = pageMap.get(pageNum);
      if (!p) continue;
      const blocks: PdfTranslatedBlock[] = [];
      for (const b of p.blocks) {
        if (b.isFigure || b.tag === 'figure') {
          blocks.push({ tag: 'figure', html: b.text });
        } else {
          const hit = finalMap.get(`${pageNum}_${b.blockId}`);
          blocks.push(
            hit
              ? { tag: hit.tag, html: hit.html }
              : { tag: b.tag, html: b.text }
          );
        }
      }
      pageUpdates[pageNum] = ensurePageAssetsIncluded(blocks, p.assetIds);
    }

    return { success: true, pageUpdates };
  };

  const tryClaimHedgeUnit = (slot: TranslationChannelSlot): InFlightPdfUnitEntry | null => {
    const now = Date.now();
    let bestCandidate: InFlightPdfUnitEntry | null = null;
    let oldestAge = -1;

    for (const entry of inFlightUnits.values()) {
      if (completedUnitSet.has(entry.unitIdx) || failedUnitSet.has(entry.unitIdx)) {
        continue;
      }
      const unit = units[entry.unitIdx];
      if (!unit) continue;

      const elapsed = now - entry.startedAt;
      const threshold = unit.kind === 'vision-page' ? VISION_HEDGE_DELAY_MS : TEXT_HEDGE_DELAY_MS;
      if (elapsed < threshold) continue;

      const maxRacers = elapsed >= threshold + 12_000 ? 3 : 2;
      if (entry.activeAttempts >= maxRacers) continue;

      const canUseKey =
        !entry.ownerKeys.has(slot.apiKey) ||
        (availableKeys.length === 1 && !entry.ownerModels.has(slot.primaryModel));
      if (!canUseKey) continue;

      if (elapsed > oldestAge) {
        oldestAge = elapsed;
        bestCandidate = entry;
      }
    }

    return bestCandidate;
  };

  let allSettledResolved = false;
  let resolveAllSettled!: () => void;
  const allSettledPromise = new Promise<void>((resolve) => {
    resolveAllSettled = () => {
      if (allSettledResolved) return;
      allSettledResolved = true;
      resolve();
    };
  });

  const checkAllDone = () => {
    if (completedUnitSet.size + failedUnitSet.size >= totalUnits) {
      finishedSignal.current = true;
      resolveAllSettled();
      return true;
    }
    return false;
  };

  try {
    const runChannelWorker = async (slot: TranslationChannelSlot) => {
      // Lệch pha ngắn để đồng bộ mượt với bộ khóa RPM 2.2s/key
      const staggerMs = slot.slotIndex * (availableKeys.length >= 4 ? 140 : 280);
      if (staggerMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, staggerMs));
      }

      try {
        while (!effectiveStopSignal.current) {
          if (checkAllDone()) break;

          let unitIdx = pendingQueue.shift();
          let isHedge = false;
          let flightEntry: InFlightPdfUnitEntry | undefined;
          const abortCtrl = new AbortController();

          if (unitIdx !== undefined) {
            flightEntry = {
              unitIdx,
              startedAt: Date.now(),
              ownerKeys: new Set([slot.apiKey]),
              ownerModels: new Set([slot.primaryModel]),
              activeAttempts: 1,
              abortControllers: [abortCtrl],
            };
            inFlightUnits.set(unitIdx, flightEntry);
          } else {
            const hedgeCandidate = tryClaimHedgeUnit(slot);
            if (hedgeCandidate) {
              isHedge = true;
              unitIdx = hedgeCandidate.unitIdx;
              hedgeCandidate.ownerKeys.add(slot.apiKey);
              hedgeCandidate.ownerModels.add(slot.primaryModel);
              hedgeCandidate.activeAttempts += 1;
              hedgeCandidate.abortControllers.push(abortCtrl);
              flightEntry = hedgeCandidate;
            } else {
              if (inFlightUnits.size === 0) break;
              await new Promise((resolve) => setTimeout(resolve, 250));
              continue;
            }
          }

          try {
            const unit = units[unitIdx];
            if (!unit || completedUnitSet.has(unitIdx)) {
              flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);
              continue;
            }

            const attemptsBefore = unitRetryCounts.get(unitIdx) || 0;
            const preferredModels = [EPUB_TRANSLATION_MODEL];

            const timeoutMs =
              unit.kind === 'vision-page'
                ? isHedge
                  ? 38_000
                  : 46_000
                : isHedge
                ? 34_000
                : 42_000;

            const res =
              unit.kind === 'vision-page'
                ? await translateVisionUnit(
                    unit,
                    slot.apiKey,
                    preferredModels,
                    timeoutMs,
                    abortCtrl.signal
                  )
                : await translateTextChunkUnit(
                    unit,
                    slot.apiKey,
                    preferredModels,
                    attemptsBefore,
                    timeoutMs,
                    abortCtrl.signal
                  );

            flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);

            if (effectiveStopSignal.current || abortCtrl.signal.aborted || res.aborted) {
              if (stopSignal.current && !completedUnitSet.has(unitIdx) && !isHedge) {
                inFlightUnits.delete(unitIdx);
                pendingQueue.unshift(unitIdx);
              } else if (flightEntry.activeAttempts === 0 && !completedUnitSet.has(unitIdx)) {
                inFlightUnits.delete(unitIdx);
              }
              break;
            }

            if (completedUnitSet.has(unitIdx)) {
              // Một luồng đua song song đã hoàn tất unit này trước
              continue;
            }

            if (res.success && res.pageUpdates) {
              completedUnitSet.add(unitIdx);
              failedUnitSet.delete(unitIdx);
              inFlightUnits.delete(unitIdx);

              // Hủy các request chạy đua còn lại cho unit này nếu có
              for (const otherCtrl of flightEntry.abortControllers) {
                if (otherCtrl !== abortCtrl && !otherCtrl.signal.aborted) {
                  otherCtrl.abort();
                }
              }

              if (unit.kind === 'vision-page') {
                renderedPageCache.delete(unit.pageNumbers[0]);
              }

              Object.assign(translatedPdfPages, res.pageUpdates);

              const writePromise = recordPdfUnitCheckpoint(
                job.jobId,
                unitIdx,
                res.pageUpdates,
                getElapsedMs?.()
              ).finally(() => {
                activeCheckpointWrites.delete(writePromise);
              });
              activeCheckpointWrites.add(writePromise);
              await writePromise;

              if (onJobStateSync && !stopSignal.current) {
                onJobStateSync({
                  translatedPdfPages: { ...translatedPdfPages },
                  completedChunkIds: Array.from(completedUnitSet),
                  failedChunkIds: Array.from(failedUnitSet),
                });
              }

              emitProgress(`Đang dịch PDF (${completedUnitSet.size}/${totalUnits})`);
              if (checkAllDone()) break;
              continue;
            }

            if (res.keyExhausted) {
              lastFatalOrKeyError = res.error || 'Key đã hết hạn ngạch.';
              if (flightEntry.activeAttempts === 0 && !completedUnitSet.has(unitIdx)) {
                inFlightUnits.delete(unitIdx);
                pendingQueue.unshift(unitIdx);
              }
              break;
            }

            // Nếu đây là luồng hedge lỗi nhưng luồng chính vẫn đang chạy thì không đẩy lại vào queue
            if (flightEntry.activeAttempts > 0) {
              continue;
            }

            inFlightUnits.delete(unitIdx);
            const attempts = attemptsBefore + 1;
            unitRetryCounts.set(unitIdx, attempts);

            if (res.retryable !== false && attempts < MAX_RETRIES_PER_UNIT) {
              if (res.rateLimited) {
                emitProgress(`Đang giãn nhịp RPM (${completedUnitSet.size}/${totalUnits})...`);
                await new Promise((resolve) => setTimeout(resolve, 3500 + attempts * 1000));
              } else {
                await new Promise((resolve) => setTimeout(resolve, 900 * attempts));
              }
              if (!completedUnitSet.has(unitIdx) && !effectiveStopSignal.current) {
                pendingQueue.push(unitIdx);
              }
            } else {
              failedUnitSet.add(unitIdx);
              lastFatalOrKeyError = res.error || lastFatalOrKeyError;
              emitProgress(`${completedUnitSet.size}/${totalUnits} · ${failedUnitSet.size} lỗi`);
              if (checkAllDone()) break;
            }
          } catch (err: unknown) {
            flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);
            if (effectiveStopSignal.current) break;
            if (completedUnitSet.has(unitIdx) || flightEntry.activeAttempts > 0) {
              continue;
            }

            inFlightUnits.delete(unitIdx);
            const attempts = (unitRetryCounts.get(unitIdx) || 0) + 1;
            unitRetryCounts.set(unitIdx, attempts);
            lastFatalOrKeyError = err instanceof Error ? err.message : String(err);

            if (attempts < MAX_RETRIES_PER_UNIT) {
              await new Promise((resolve) => setTimeout(resolve, 900 * attempts));
              if (!completedUnitSet.has(unitIdx) && !effectiveStopSignal.current) {
                pendingQueue.push(unitIdx);
              }
            } else {
              failedUnitSet.add(unitIdx);
              if (checkAllDone()) break;
            }
          }
        }
      } finally {
        activeWorkersCount = Math.max(0, activeWorkersCount - 1);
        if (activeWorkersCount === 0) {
          resolveAllSettled();
        }
      }
    };

    const workersPromise = Promise.all(channelSlots.map((slot) => runChannelWorker(slot)));
    await Promise.race([allSettledPromise, workersPromise]);
    finishedSignal.current = true;

    if (activeCheckpointWrites.size > 0) {
      await Promise.allSettled(Array.from(activeCheckpointWrites));
    }
  } finally {
    finishedSignal.current = true;
    renderedPageCache.clear();
    if (sharedLoadingTask) {
      await sharedLoadingTask.destroy().catch(() => {});
    }
  }

  const isStopped = Boolean(stopSignal.current);
  const allCompleted =
    !isStopped && failedUnitSet.size === 0 && completedUnitSet.size === totalUnits;

  const finalStatus: EpubTranslationJob['status'] = allCompleted
    ? 'completed'
    : isStopped
    ? 'paused'
    : 'error';

  await updateEpubJobMetadata(job.jobId, {
    status: finalStatus,
    failedChunkIds: Array.from(failedUnitSet),
    completedChunkIds: Array.from(completedUnitSet),
    translatedPdfPages,
    ...(getElapsedMs ? { elapsedMs: getElapsedMs() } : {}),
    ...(allCompleted ? { completedAt: Date.now() } : {}),
    lastError: allCompleted ? undefined : lastFatalOrKeyError || undefined,
  });

  emitProgress(
    allCompleted
      ? `Hoàn tất ${totalUnits}/${totalUnits}`
      : isStopped
      ? `Đã tạm dừng (${completedUnitSet.size}/${totalUnits})`
      : `Còn ${failedUnitSet.size} phần lỗi`
  );

  return {
    completed: allCompleted,
    stopped: isStopped,
    translatedPdfPages,
    completedChunkIds: Array.from(completedUnitSet),
    failedChunkIds: Array.from(failedUnitSet),
    errorMessage: allCompleted
      ? undefined
      : isStopped
      ? undefined
      : lastFatalOrKeyError || 'Một số phần chưa dịch xong.',
  };
}
