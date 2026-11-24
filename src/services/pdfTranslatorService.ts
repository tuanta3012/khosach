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
  EPUB_BACKUP_MODEL,
  EPUB_TRANSLATION_MODEL,
  executeEpubFlashLiteWithKey,
  executePdfVisionFlashLiteWithKey,
  getAvailableEpubTranslationKeys,
} from './geminiService';
import { getEpubGenreConfig } from './epubTranslatorService';
import { recordPdfUnitCheckpoint, updateEpubJobMetadata } from './epubCheckpointDb';
import { buildPdfTranslationUnits, renderPdfPageForVision } from './pdfDigitalService';

const MAX_RETRIES_PER_UNIT = 5;

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

  const unitRetryCounts = new Map<number, number>();
  const workerCount = Math.min(availableKeys.length, pendingQueue.length);
  let activeWorkersCount = workerCount;
  let inFlightCount = 0;
  let lastFatalOrKeyError = '';

  const countCompletedPages = () => Object.keys(translatedPdfPages).length;

  const emitProgress = (statusMessage: string) => {
    onProgress({
      completedChunks: completedUnitSet.size,
      totalChunks: totalUnits,
      completedSegments: Math.min(totalPages, countCompletedPages()),
      totalSegments: totalPages,
      failedChunks: failedUnitSet.size,
      activeWorkers: activeWorkersCount,
      totalKeys: availableKeys.length,
      statusMessage,
    });
  };

  emitProgress(`Đang dịch PDF (${workerCount} luồng)...`);

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
    let release!: () => void;
    const prev = renderMutex;
    renderMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await renderPdfPageForVision(sharedPdfDoc, pageNumber);
    } finally {
      release();
    }
  };

  const translateVisionUnit = async (
    unit: PdfTranslationUnit,
    apiKey: string,
    preferredModels: string[]
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

    const rendered = await renderPageSerialized(pageNum);
    if (stopSignal.current) {
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
      stopSignal,
    });

    if (stopSignal.current || res.aborted) {
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
    preferredModels: string[]
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
      stopSignal,
    });

    const outMap = new Map<string, { tag: PdfBlockTag; html: string }>();
    if (stopSignal.current || res.aborted) {
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
    attemptsBefore: number
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

    const preferredModels =
      attemptsBefore >= 1
        ? [EPUB_BACKUP_MODEL, EPUB_TRANSLATION_MODEL]
        : [EPUB_TRANSLATION_MODEL, EPUB_BACKUP_MODEL];

    let finalMap = new Map<string, { tag: PdfBlockTag; html: string }>();

    if (attemptsBefore >= 2 && inputItems.length > 4) {
      const half = Math.ceil(inputItems.length / 2);
      const halves = [inputItems.slice(0, half), inputItems.slice(half)];
      for (const part of halves) {
        if (part.length === 0) continue;
        const r = await translateTextItemsBatch(part, apiKey, [
          EPUB_BACKUP_MODEL,
          EPUB_TRANSLATION_MODEL,
        ]);
        if (!r.success) return r;
        r.translatedMap.forEach((v, k) => finalMap.set(k, v));
      }
    } else {
      const r = await translateTextItemsBatch(inputItems, apiKey, preferredModels);
      if (!r.success) return r;
      finalMap = r.translatedMap;

      const missingCount = inputItems.filter(
        (it) => !finalMap.has(`${it.page}_${it.blockId}`)
      ).length;
      if (missingCount > Math.max(2, Math.floor(inputItems.length * 0.25))) {
        const retryBackup = await translateTextItemsBatch(inputItems, apiKey, [
          EPUB_BACKUP_MODEL,
        ]);
        if (retryBackup.success && retryBackup.translatedMap.size > finalMap.size) {
          finalMap = retryBackup.translatedMap;
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

  try {
    const runKeyWorker = async (workerIndex: number, apiKey: string) => {
      if (workerIndex > 0) {
        await new Promise((resolve) => setTimeout(resolve, workerIndex * 280));
      }

      while (!stopSignal.current) {
        const unitIdx = pendingQueue.shift();
        if (unitIdx === undefined) {
          if (inFlightCount === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 180));
          continue;
        }

        inFlightCount += 1;
        try {
          const unit = units[unitIdx];
          if (!unit) continue;

          const attemptsBefore = unitRetryCounts.get(unitIdx) || 0;
          const preferredModels =
            attemptsBefore >= 1
              ? [EPUB_BACKUP_MODEL, EPUB_TRANSLATION_MODEL]
              : [EPUB_TRANSLATION_MODEL, EPUB_BACKUP_MODEL];

          const res =
            unit.kind === 'vision-page'
              ? await translateVisionUnit(unit, apiKey, preferredModels)
              : await translateTextChunkUnit(unit, apiKey, attemptsBefore);

          if (stopSignal.current || res.aborted) {
            pendingQueue.unshift(unitIdx);
            break;
          }

          if (res.success && res.pageUpdates) {
            Object.assign(translatedPdfPages, res.pageUpdates);
            completedUnitSet.add(unitIdx);
            failedUnitSet.delete(unitIdx);

            await recordPdfUnitCheckpoint(job.jobId, unitIdx, res.pageUpdates, getElapsedMs?.());
            if (onJobStateSync) {
              onJobStateSync({
                translatedPdfPages: { ...translatedPdfPages },
                completedChunkIds: Array.from(completedUnitSet),
                failedChunkIds: Array.from(failedUnitSet),
              });
            }

            emitProgress(`Đang dịch PDF (${completedUnitSet.size}/${totalUnits})`);
            continue;
          }

          if (res.keyExhausted) {
            lastFatalOrKeyError = res.error || 'Key đã hết hạn ngạch.';
            pendingQueue.unshift(unitIdx);
            break;
          }

          const attempts = attemptsBefore + 1;
          unitRetryCounts.set(unitIdx, attempts);

          if (res.retryable !== false && attempts < MAX_RETRIES_PER_UNIT) {
            if (res.rateLimited) {
              emitProgress(`Đang giãn nhịp RPM (${completedUnitSet.size}/${totalUnits})...`);
              await new Promise((resolve) => setTimeout(resolve, 4200 + attempts * 1200));
            } else {
              await new Promise((resolve) => setTimeout(resolve, 1400 * attempts));
            }
            pendingQueue.push(unitIdx);
          } else {
            failedUnitSet.add(unitIdx);
            lastFatalOrKeyError = res.error || lastFatalOrKeyError;
            emitProgress(`${completedUnitSet.size}/${totalUnits} · ${failedUnitSet.size} lỗi`);
          }
        } catch (err: unknown) {
          const attempts = (unitRetryCounts.get(unitIdx) || 0) + 1;
          unitRetryCounts.set(unitIdx, attempts);
          lastFatalOrKeyError = err instanceof Error ? err.message : String(err);
          if (attempts < MAX_RETRIES_PER_UNIT && !stopSignal.current) {
            await new Promise((resolve) => setTimeout(resolve, 1400 * attempts));
            pendingQueue.push(unitIdx);
          } else {
            failedUnitSet.add(unitIdx);
          }
        } finally {
          inFlightCount = Math.max(0, inFlightCount - 1);
        }
      }

      activeWorkersCount = Math.max(0, activeWorkersCount - 1);
    };

    await Promise.all(
      availableKeys.slice(0, workerCount).map((key, idx) => runKeyWorker(idx, key))
    );
  } finally {
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
