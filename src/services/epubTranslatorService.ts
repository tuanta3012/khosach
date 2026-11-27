import {
  EpubGenreConfig,
  EpubGenreId,
  EpubTranslatableSegment,
  EpubTranslationJob,
  EpubTranslationProgress,
} from '../types';
import {
  buildTranslationChannelSlots,
  EPUB_TRANSLATION_MODEL,
  executeEpubFlashLiteWithKey,
  getAvailableEpubTranslationKeys,
  TranslationChannelSlot,
} from './geminiService';
import {
  recordChunkCheckpoint,
  updateEpubJobMetadata,
} from './epubCheckpointDb';

export const EPUB_GENRES: EpubGenreConfig[] = [
  {
    id: 'van-hoc',
    label: 'Văn học & Tiểu thuyết',
    shortDesc: 'Mượt mà, giàu cảm xúc, tự nhiên',
    libraryCategoryHint: 'Văn học hiện đại',
    stylePrompt:
      'Dịch theo văn phong văn học tiếng Việt mượt mà, giàu hình ảnh và nhịp điệu. Chọn từ ngữ tinh tế, giữ trọn sắc thái cảm xúc của nhân vật, đại từ xưng hô tự nhiên theo bối cảnh và lứa tuổi. Chuyển ngữ thành ngữ/ẩn dụ khéo léo sang tiếng Việt tương đương.',
  },
  {
    id: 'cong-nghe',
    label: 'Công nghệ & Lập trình',
    shortDesc: 'Chuẩn thuật ngữ IT, giữ code/API',
    libraryCategoryHint: 'Khoa học',
    stylePrompt:
      'Dịch theo văn phong sách kỹ thuật, công nghệ thông tin chuẩn xác và súc tích. Giữ nguyên thuật ngữ chuyên ngành phổ biến bằng tiếng Anh (API, SDK, framework, thread, compiler, kernel, Docker, cloud...) cũng như tên biến, hàm, câu lệnh; chỉ dịch phần giải thích và lập luận sang tiếng Việt rõ ràng.',
  },
  {
    id: 'y-khoa',
    label: 'Y khoa & Sức khỏe',
    shortDesc: 'Chuẩn thuật ngữ giải phẫu, dược lý',
    libraryCategoryHint: 'Y học - Sức khỏe',
    stylePrompt:
      'Dịch theo văn phong y học chuẩn mực, khách quan và chính xác cao. Sử dụng đúng thuật ngữ giải phẫu, sinh lý, bệnh học và dược lý theo từ điển y khoa Việt Nam (có thể giữ nguyên tên hoạt chất/thuật ngữ Latinh hoặc tiếng Anh chuyên sâu trong ngoặc nếu cần đối chiếu chính xác).',
  },
  {
    id: 'kinh-te',
    label: 'Kinh tế & Kinh doanh',
    shortDesc: 'Sắc sảo, chuẩn tài chính & quản trị',
    libraryCategoryHint: 'Quản trị - Kinh doanh',
    stylePrompt:
      'Dịch theo văn phong kinh tế, tài chính và quản trị doanh nghiệp chuyên nghiệp, sắc sảo. Sử dụng chính xác các thuật ngữ kinh doanh, đầu tư, marketing, chuỗi cung ứng và vĩ mô thông dụng tại Việt Nam.',
  },
  {
    id: 'khoa-hoc',
    label: 'Khoa học & Tự nhiên',
    shortDesc: 'Logic, khách quan, giữ ký hiệu',
    libraryCategoryHint: 'Khoa học',
    stylePrompt:
      'Dịch theo văn phong khoa học phổ thông hoặc chuyên khảo rõ ràng, logic, khách quan. Giữ nguyên công thức, ký hiệu toán học/vật lý/hóa học, hằng số và đơn vị đo lường quốc tế.',
  },
  {
    id: 'lich-su-triet',
    label: 'Lịch sử & Triết học',
    shortDesc: 'Trang trọng, chuẩn niên đại & khái niệm',
    libraryCategoryHint: 'Lịch sử',
    stylePrompt:
      'Dịch theo văn phong sử học và triết học trang trọng, chặt chẽ, mạch lạc. Bảo toàn chính xác niên đại, sự kiện, tên nhân vật/triều đại, địa danh lịch sử và các phạm trù triết học kinh điển.',
  },
  {
    id: 'tam-ly-ky-nang',
    label: 'Tâm lý & Kỹ năng sống',
    shortDesc: 'Gần gũi, thấu cảm, dễ áp dụng',
    libraryCategoryHint: 'Kỹ năng sống',
    stylePrompt:
      'Dịch theo văn phong sách tâm lý học ứng dụng và phát triển bản thân: gần gũi, đồng cảm, mạch lạc, truyền cảm hứng và dễ áp dụng vào đời sống hằng ngày.',
  },
  {
    id: 'giao-trinh',
    label: 'Giáo trình & Học thuật',
    shortDesc: 'Sư phạm, nhất quán định nghĩa',
    libraryCategoryHint: 'Giáo dục - Gia đình',
    stylePrompt:
      'Dịch theo văn phong giáo trình sư phạm, nghiên cứu học thuật: nhất quán tuyệt đối trong hệ thống thuật ngữ, định nghĩa, lập luận rõ ràng, chuẩn mực tiếng Việt học thuật.',
  },
  {
    id: 'tong-hop',
    label: 'Tổng hợp (Chung)',
    shortDesc: 'Cân bằng, tự nhiên mọi chủ đề',
    libraryCategoryHint: 'Chung',
    stylePrompt:
      'Dịch sang tiếng Việt tự nhiên, trong sáng, chuẩn chính tả và trung thành tuyệt đối với nội dung nguyên tác.',
  },
];

export function getEpubGenreConfig(genreId: EpubGenreId): EpubGenreConfig {
  return EPUB_GENRES.find((g) => g.id === genreId) || EPUB_GENRES[EPUB_GENRES.length - 1];
}

export function mapEpubGenreToLibraryCategory(
  genreId: EpubGenreId,
  libraryCategories: string[]
): string {
  const cfg = getEpubGenreConfig(genreId);
  if (libraryCategories.includes(cfg.libraryCategoryHint)) {
    return cfg.libraryCategoryHint;
  }
  const fallbackMap: Record<EpubGenreId, string[]> = {
    'van-hoc': ['Văn học hiện đại', 'Văn học kinh điển', 'Văn học Việt Nam', 'Chung'],
    'cong-nghe': ['Khoa học', 'Kỹ năng sống', 'Chung'],
    'y-khoa': ['Y học - Sức khỏe', 'Khoa học', 'Chung'],
    'kinh-te': ['Quản trị - Kinh doanh', 'Kinh tế', 'Chung'],
    'khoa-hoc': ['Khoa học', 'Chung'],
    'lich-su-triet': ['Lịch sử', 'Triết học', 'Chung'],
    'tam-ly-ky-nang': ['Tâm lý', 'Kỹ năng sống', 'Chung'],
    'giao-trinh': ['Giáo dục - Gia đình', 'Khoa học', 'Chung'],
    'tong-hop': ['Chung'],
  };
  for (const candidate of fallbackMap[genreId] || ['Chung']) {
    if (libraryCategories.includes(candidate)) return candidate;
  }
  return libraryCategories[0] || 'Chung';
}

export function buildEpubSystemInstruction(
  genreId: EpubGenreId,
  customNotes?: string
): string {
  const genre = getEpubGenreConfig(genreId);
  const cleanNotes = (customNotes || '').trim();

  return [
    `Bạn là dịch giả sách chuyên nghiệp sang tiếng Việt, chuyên thể loại: ${genre.label}.`,
    `ĐỊNH HƯỚNG VĂN PHONG: ${genre.stylePrompt}`,
    `QUY TẮC BẮT BUỘC:`,
    `1. Dịch THUẦN TIẾNG VIỆT hoàn chỉnh thay thế toàn bộ văn bản gốc. Diễn đạt tự nhiên như sách xuất bản chính thức tại Việt Nam, không dịch word-by-word thô cứng.`,
    `2. KHÔNG tóm tắt, KHÔNG lược bỏ câu chữ, KHÔNG thêm lời bình luận hay chú thích thừa ngoài văn bản gốc.`,
    `3. BẢO TOÀN ĐÁNH DẤU HTML: Trong văn bản có các thẻ đánh dấu dạng [[E0]]...[[/E0]], [[E1]]...[[/E1]] hoặc [[V0]], [[V1]]. Bắt buộc giữ nguyên tên và mã số các thẻ [[...]] này và đặt đúng cặp thẻ bao quanh cụm từ tiếng Việt tương ứng sau khi dịch (không dịch nội dung bên trong dấu [[ ]]).`,
    `4. Trả về đúng mảng JSON gồm từng phần tử { "id": number, "translated": string } tương ứng chính xác 1-1 với danh sách đầu vào, không bỏ sót bất kỳ "id" nào.`,
    cleanNotes ? `5. GHI CHÚ RIÊNG TỪ NGƯỜI DÙNG (ƯU TIÊN TUÂN THỦ):\n${cleanNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const CHUNK_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'INTEGER', description: 'Giữ nguyên id của đoạn gốc' },
      translated: { type: 'STRING', description: 'Bản dịch tiếng Việt hoàn chỉnh giữ nguyên các thẻ [[E...]] / [[V...]]' },
    },
    required: ['id', 'translated'],
  },
};

const MAX_RETRIES_PER_CHUNK = 5;
const EPUB_HEDGE_DELAY_MS = 13_000;

export interface RunEpubTranslationOptions {
  job: EpubTranslationJob;
  genre: EpubGenreId;
  customNotes: string;
  stopSignal: { current: boolean };
  getElapsedMs?: () => number;
  onProgress: (progress: EpubTranslationProgress) => void;
  onJobStateSync?: (updates: {
    translatedSegments: Record<number, string>;
    completedChunkIds: number[];
    failedChunkIds: number[];
  }) => void;
}

export interface RunEpubTranslationResult {
  completed: boolean;
  stopped: boolean;
  translatedSegments: Record<number, string>;
  completedChunkIds: number[];
  failedChunkIds: number[];
  errorMessage?: string;
  warningMessage?: string;
}

interface InFlightEpubChunkEntry {
  chunkIdx: number;
  startedAt: number;
  ownerKeys: Set<string>;
  ownerModels: Set<string>;
  activeAttempts: number;
  abortControllers: AbortController[];
}

/**
 * Chạy dịch song song nhiều chunk với 1 luồng/key trên model duy nhất gemini-3.5-flash-lite,
 * kết hợp đánh chặn phần cuối (tail hedging) và chỉ dịch bù các đoạn còn thiếu.
 */
export async function runParallelEpubTranslation(
  options: RunEpubTranslationOptions
): Promise<RunEpubTranslationResult> {
  const { job, genre, customNotes, stopSignal, getElapsedMs, onProgress, onJobStateSync } = options;
  const availableKeys = getAvailableEpubTranslationKeys();

  const totalChunks = job.parsedData.chunks.length;
  const totalSegments = job.parsedData.segments.length;
  const translatedSegments: Record<number, string> = { ...(job.translatedSegments || {}) };
  const completedChunkSet = new Set<number>(job.completedChunkIds || []);
  const failedChunkSet = new Set<number>();

  if (availableKeys.length === 0) {
    return {
      completed: false,
      stopped: false,
      translatedSegments,
      completedChunkIds: Array.from(completedChunkSet),
      failedChunkIds: job.failedChunkIds || [],
      errorMessage: 'Chưa có Gemini API Key khả dụng (hoặc tất cả Key đều đang hết lượt / cooldown).',
    };
  }

  const segmentMap = new Map<number, EpubTranslatableSegment>();
  for (const seg of job.parsedData.segments) {
    segmentMap.set(seg.segId, seg);
  }

  // Hàng đợi các chunk chưa hoàn thành (bao gồm cả chunk lỗi từ lần trước nếu có)
  const pendingQueue: number[] = [];
  for (const chunk of job.parsedData.chunks) {
    if (!completedChunkSet.has(chunk.chunkIndex)) {
      pendingQueue.push(chunk.chunkIndex);
    }
  }

  if (pendingQueue.length === 0) {
    return {
      completed: true,
      stopped: false,
      translatedSegments,
      completedChunkIds: Array.from(completedChunkSet),
      failedChunkIds: [],
    };
  }

  await updateEpubJobMetadata(job.jobId, {
    genre,
    customNotes,
    status: 'translating',
    failedChunkIds: [],
    lastError: undefined,
  });

  const systemInstruction = buildEpubSystemInstruction(genre, customNotes);
  const channelSlots: TranslationChannelSlot[] = buildTranslationChannelSlots(availableKeys, 12);
  if (channelSlots.length === 0) {
    return {
      completed: false,
      stopped: false,
      translatedSegments,
      completedChunkIds: Array.from(completedChunkSet),
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

  const chunkRetryCounts = new Map<number, number>();
  const inFlightChunks = new Map<number, InFlightEpubChunkEntry>();
  const activeCheckpointWrites = new Set<Promise<void>>();

  let activeWorkersCount = channelSlots.length;
  let lastFatalOrKeyError = '';
  let contentFilteredSegmentsCount = 0;
  let lastContentFilterReason = '';

  const countCompletedSegments = () => {
    let count = 0;
    for (const chunkIdx of completedChunkSet) {
      const ch = job.parsedData.chunks[chunkIdx];
      if (ch) count += ch.segmentIds.length;
    }
    return count;
  };

  const emitProgress = (statusMessage: string) => {
    onProgress({
      completedChunks: completedChunkSet.size,
      totalChunks,
      completedSegments: countCompletedSegments(),
      totalSegments,
      failedChunks: failedChunkSet.size,
      activeWorkers: Math.max(1, activeWorkersCount),
      totalKeys: availableKeys.length,
      statusMessage,
    });
  };

  emitProgress(
    `Đang khởi động ${channelSlots.length} luồng song song (${availableKeys.length} key · 3.5 Flash Lite)...`
  );

  const buildChunkPrompt = (items: Array<{ id: number; text: string }>) =>
    `Hãy dịch toàn bộ ${items.length} đoạn dưới đây sang tiếng Việt tự nhiên theo đúng thể loại sách, giữ nguyên cấu trúc thẻ [[E...]] và [[V...]], và trả về đúng mảng JSON:\n${JSON.stringify(items)}`;

  const extractValidMap = (data: unknown): Map<number, string> => {
    const parsedMap = new Map<number, string>();
    if (!Array.isArray(data)) return parsedMap;
    for (const item of data) {
      if (item && typeof item.id === 'number' && typeof item.translated === 'string') {
        parsedMap.set(item.id, item.translated.trim());
      }
    }
    return parsedMap;
  };

  const translateItemsWithIsolation = async (
    items: Array<{ id: number; text: string }>,
    apiKey: string,
    timeoutMs: number,
    abortSignal: AbortSignal
  ): Promise<{
    success: boolean;
    parsedMap: Map<number, string>;
    aborted?: boolean;
    keyExhausted?: boolean;
    rateLimited?: boolean;
    retryable?: boolean;
    contentBlockedReason?: string;
    error?: string;
  }> => {
    const firstTry = await executeEpubFlashLiteWithKey({
      key: apiKey,
      systemInstruction,
      promptText: buildChunkPrompt(items),
      responseSchema: CHUNK_RESPONSE_SCHEMA,
      preferredModels: [EPUB_TRANSLATION_MODEL],
      timeoutMs,
      abortSignal,
      stopSignal: effectiveStopSignal,
    });

    if (effectiveStopSignal.current || abortSignal.aborted || firstTry.aborted) {
      return { success: false, parsedMap: new Map(), aborted: true, retryable: true };
    }

    if (firstTry.success && Array.isArray(firstTry.data)) {
      return { success: true, parsedMap: extractValidMap(firstTry.data) };
    }

    if (firstTry.keyExhausted) {
      return {
        success: false,
        parsedMap: new Map(),
        keyExhausted: true,
        retryable: true,
        error: firstTry.error,
      };
    }

    const isNonRetryableOrBlocked =
      Boolean(firstTry.contentBlockedReason) || firstTry.retryable === false;
    if (!isNonRetryableOrBlocked) {
      return {
        success: false,
        parsedMap: new Map(),
        rateLimited: firstTry.rateLimited,
        retryable: firstTry.retryable,
        error: firstTry.error,
      };
    }

    if (items.length > 1) {
      const merged = new Map<number, string>();
      const mid = Math.ceil(items.length / 2);
      const halves = [items.slice(0, mid), items.slice(mid)];
      for (const half of halves) {
        if (half.length === 0) continue;
        const halfRes = await translateItemsWithIsolation(half, apiKey, timeoutMs, abortSignal);
        if (!halfRes.success) return halfRes;
        halfRes.parsedMap.forEach((v, k) => merged.set(k, v));
      }
      return { success: true, parsedMap: merged };
    }

    if (firstTry.contentBlockedReason === 'RECITATION') {
      const rephraseRes = await executeEpubFlashLiteWithKey({
        key: apiKey,
        systemInstruction,
        promptText: `${buildChunkPrompt(items)}\n\nLưu ý: Dịch thoát ý sang tiếng Việt tự nhiên, diễn đạt lại mạch lạc thay vì bám sát từng cụm từ gốc.`,
        responseSchema: CHUNK_RESPONSE_SCHEMA,
        preferredModels: [EPUB_TRANSLATION_MODEL],
        timeoutMs,
        temperature: 0.45,
        abortSignal,
        stopSignal: effectiveStopSignal,
      });
      if (effectiveStopSignal.current || abortSignal.aborted || rephraseRes.aborted) {
        return { success: false, parsedMap: new Map(), aborted: true, retryable: true };
      }
      if (rephraseRes.keyExhausted) {
        return {
          success: false,
          parsedMap: new Map(),
          keyExhausted: true,
          retryable: true,
          error: rephraseRes.error,
        };
      }
      if (rephraseRes.success && Array.isArray(rephraseRes.data)) {
        return { success: true, parsedMap: extractValidMap(rephraseRes.data) };
      }
      if (rephraseRes.contentBlockedReason) {
        contentFilteredSegmentsCount += 1;
        lastContentFilterReason = rephraseRes.contentBlockedReason;
        return { success: true, parsedMap: new Map() };
      }
      return {
        success: false,
        parsedMap: new Map(),
        rateLimited: rephraseRes.rateLimited,
        retryable: rephraseRes.retryable,
        error: rephraseRes.error,
      };
    }

    if (firstTry.contentBlockedReason) {
      contentFilteredSegmentsCount += 1;
      lastContentFilterReason = firstTry.contentBlockedReason;
      return { success: true, parsedMap: new Map() };
    }

    return {
      success: false,
      parsedMap: new Map(),
      retryable: firstTry.retryable,
      error: firstTry.error,
    };
  };

  const translateItemsInSubBatches = async (
    items: Array<{ id: number; text: string }>,
    apiKey: string,
    timeoutMs: number,
    abortSignal: AbortSignal
  ): Promise<{
    success: boolean;
    parsedMap: Map<number, string>;
    aborted?: boolean;
    keyExhausted?: boolean;
    rateLimited?: boolean;
    retryable?: boolean;
    error?: string;
    usedBackup?: boolean;
  }> => {
    const merged = new Map<number, string>();
    const subBatchSize = Math.max(1, Math.min(8, Math.ceil(items.length / 2)));

    for (let offset = 0; offset < items.length; offset += subBatchSize) {
      if (effectiveStopSignal.current || abortSignal.aborted) {
        return { success: false, parsedMap: merged, aborted: true, retryable: true };
      }

      const subItems = items.slice(offset, offset + subBatchSize);
      const res = await translateItemsWithIsolation(subItems, apiKey, timeoutMs, abortSignal);
      if (res.aborted) {
        return { success: false, parsedMap: merged, aborted: true, retryable: true };
      }
      if (!res.success) {
        return {
          success: false,
          parsedMap: merged,
          keyExhausted: res.keyExhausted,
          rateLimited: res.rateLimited,
          retryable: res.retryable,
          error: res.error,
        };
      }

      for (const it of subItems) {
        const val = res.parsedMap.get(it.id);
        if (val && val.length > 0) {
          merged.set(it.id, val);
        }
      }
    }

    return { success: true, parsedMap: merged };
  };

  const tryClaimHedgeChunk = (slot: TranslationChannelSlot): InFlightEpubChunkEntry | null => {
    const now = Date.now();
    let bestCandidate: InFlightEpubChunkEntry | null = null;
    let oldestAge = -1;

    for (const entry of inFlightChunks.values()) {
      if (completedChunkSet.has(entry.chunkIdx) || failedChunkSet.has(entry.chunkIdx)) {
        continue;
      }
      const elapsed = now - entry.startedAt;
      if (elapsed < EPUB_HEDGE_DELAY_MS) continue;

      const maxRacers = elapsed >= EPUB_HEDGE_DELAY_MS + 12_000 ? 3 : 2;
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
    if (completedChunkSet.size + failedChunkSet.size >= totalChunks) {
      finishedSignal.current = true;
      resolveAllSettled();
      return true;
    }
    return false;
  };

  const runChannelWorker = async (slot: TranslationChannelSlot) => {
    const staggerMs = slot.slotIndex * (availableKeys.length >= 4 ? 140 : 280);
    if (staggerMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, staggerMs));
    }

    try {
      while (!effectiveStopSignal.current) {
        if (checkAllDone()) break;

        let chunkIdx = pendingQueue.shift();
        let isHedge = false;
        let flightEntry: InFlightEpubChunkEntry | undefined;
        const abortCtrl = new AbortController();

        if (chunkIdx !== undefined) {
          flightEntry = {
            chunkIdx,
            startedAt: Date.now(),
            ownerKeys: new Set([slot.apiKey]),
            ownerModels: new Set([slot.primaryModel]),
            activeAttempts: 1,
            abortControllers: [abortCtrl],
          };
          inFlightChunks.set(chunkIdx, flightEntry);
        } else {
          const hedgeCandidate = tryClaimHedgeChunk(slot);
          if (hedgeCandidate) {
            isHedge = true;
            chunkIdx = hedgeCandidate.chunkIdx;
            hedgeCandidate.ownerKeys.add(slot.apiKey);
            hedgeCandidate.ownerModels.add(slot.primaryModel);
            hedgeCandidate.activeAttempts += 1;
            hedgeCandidate.abortControllers.push(abortCtrl);
            flightEntry = hedgeCandidate;
          } else {
            if (inFlightChunks.size === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
        }

        try {
          const chunk = job.parsedData.chunks[chunkIdx];
          if (!chunk || completedChunkSet.has(chunkIdx)) {
            flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);
            continue;
          }

          const chunkSegments = chunk.segmentIds
            .map((id) => segmentMap.get(id))
            .filter((s): s is EpubTranslatableSegment => Boolean(s));

          const preservedSegments = chunkSegments.filter((s) => s.kind === 'opf-title');
          const inputItems = chunkSegments
            .filter((s) => s.kind !== 'opf-title')
            .map((s) => ({ id: s.segId, text: s.tokenText }));

          if (inputItems.length === 0) {
            flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);
            inFlightChunks.delete(chunkIdx);
            if (preservedSegments.length > 0) {
              const preservedUpdates: Record<number, string> = {};
              for (const s of preservedSegments) {
                preservedUpdates[s.segId] = s.tokenText;
                translatedSegments[s.segId] = s.tokenText;
              }
              await recordChunkCheckpoint(job.jobId, chunkIdx, preservedUpdates, getElapsedMs?.());
            }
            completedChunkSet.add(chunkIdx);
            if (checkAllDone()) break;
            continue;
          }

          const attemptsBefore = chunkRetryCounts.get(chunkIdx) || 0;
          const timeoutMs = isHedge ? 34_000 : 42_000;

          let finalParsedMap: Map<number, string> | null = null;
          let lastCallFailure: {
            aborted?: boolean;
            keyExhausted?: boolean;
            rateLimited?: boolean;
            retryable?: boolean;
            error?: string;
          } | null = null;

          if (attemptsBefore >= 2 && inputItems.length > 1) {
            const splitRes = await translateItemsInSubBatches(
              inputItems,
              slot.apiKey,
              timeoutMs,
              abortCtrl.signal
            );
            if (splitRes.aborted || effectiveStopSignal.current || abortCtrl.signal.aborted) {
              flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);
              if (stopSignal.current && !completedChunkSet.has(chunkIdx) && !isHedge) {
                inFlightChunks.delete(chunkIdx);
                pendingQueue.unshift(chunkIdx);
              }
              break;
            }
            if (splitRes.success) {
              finalParsedMap = splitRes.parsedMap;
            } else {
              lastCallFailure = splitRes;
            }
          } else {
            const res = await translateItemsWithIsolation(
              inputItems,
              slot.apiKey,
              timeoutMs,
              abortCtrl.signal
            );

            if (effectiveStopSignal.current || abortCtrl.signal.aborted || res.aborted) {
              flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);
              if (stopSignal.current && !completedChunkSet.has(chunkIdx) && !isHedge) {
                inFlightChunks.delete(chunkIdx);
                pendingQueue.unshift(chunkIdx);
              }
              break;
            }

            if (res.success) {
              const parsedMap = res.parsedMap;
              const missingItems = inputItems.filter(
                (it) => !parsedMap.has(it.id) || !parsedMap.get(it.id)
              );

              if (missingItems.length > Math.max(1, Math.floor(inputItems.length * 0.15))) {
                // Chỉ gửi dịch bù đúng các đoạn còn thiếu (Delta Retry)
                const deltaRes =
                  missingItems.length <= 8
                    ? await translateItemsWithIsolation(
                        missingItems,
                        slot.apiKey,
                        32_000,
                        abortCtrl.signal
                      )
                    : await translateItemsInSubBatches(
                        missingItems,
                        slot.apiKey,
                        32_000,
                        abortCtrl.signal
                      );

                if (effectiveStopSignal.current || abortCtrl.signal.aborted || deltaRes.aborted) {
                  flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);
                  if (stopSignal.current && !completedChunkSet.has(chunkIdx) && !isHedge) {
                    inFlightChunks.delete(chunkIdx);
                    pendingQueue.unshift(chunkIdx);
                  }
                  break;
                }

                if (deltaRes.success) {
                  deltaRes.parsedMap.forEach((val, keyId) => {
                    if (val) parsedMap.set(keyId, val);
                  });
                }

                const stillMissingCount = inputItems.filter(
                  (it) => !parsedMap.has(it.id) || !parsedMap.get(it.id)
                ).length;

                if (
                  stillMissingCount > Math.max(2, Math.floor(inputItems.length * 0.25)) &&
                  attemptsBefore + 1 < MAX_RETRIES_PER_CHUNK &&
                  flightEntry.activeAttempts <= 1
                ) {
                  flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);
                  inFlightChunks.delete(chunkIdx);
                  chunkRetryCounts.set(chunkIdx, attemptsBefore + 1);
                  pendingQueue.push(chunkIdx);
                  continue;
                }
              }

              finalParsedMap = parsedMap;
            } else {
              lastCallFailure = res;
            }
          }

          flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);

          if (completedChunkSet.has(chunkIdx)) {
            continue;
          }

          if (finalParsedMap) {
            completedChunkSet.add(chunkIdx);
            failedChunkSet.delete(chunkIdx);
            inFlightChunks.delete(chunkIdx);

            for (const otherCtrl of flightEntry.abortControllers) {
              if (otherCtrl !== abortCtrl && !otherCtrl.signal.aborted) {
                otherCtrl.abort();
              }
            }

            const chunkUpdates: Record<number, string> = {};
            for (const it of inputItems) {
              const translatedVal = finalParsedMap.get(it.id);
              const finalVal = translatedVal && translatedVal.length > 0 ? translatedVal : it.text;
              chunkUpdates[it.id] = finalVal;
              translatedSegments[it.id] = finalVal;
            }

            const writePromise = recordChunkCheckpoint(
              job.jobId,
              chunkIdx,
              chunkUpdates,
              getElapsedMs?.()
            ).finally(() => {
              activeCheckpointWrites.delete(writePromise);
            });
            activeCheckpointWrites.add(writePromise);
            await writePromise;

            if (onJobStateSync && !stopSignal.current) {
              onJobStateSync({
                translatedSegments: { ...translatedSegments },
                completedChunkIds: Array.from(completedChunkSet),
                failedChunkIds: Array.from(failedChunkSet),
              });
            }

            emitProgress(
              `Đã dịch ${completedChunkSet.size}/${totalChunks} phần (${channelSlots.length} luồng)`
            );
            if (checkAllDone()) break;
            continue;
          }

          if (lastCallFailure?.keyExhausted) {
            lastFatalOrKeyError = lastCallFailure.error || 'Một API Key đã hết hạn ngạch hoặc không hợp lệ.';
            if (flightEntry.activeAttempts === 0 && !completedChunkSet.has(chunkIdx)) {
              inFlightChunks.delete(chunkIdx);
              pendingQueue.unshift(chunkIdx);
            }
            break;
          }

          if (flightEntry.activeAttempts > 0) {
            continue;
          }

          inFlightChunks.delete(chunkIdx);
          const attempts = attemptsBefore + 1;
          chunkRetryCounts.set(chunkIdx, attempts);

          if (lastCallFailure?.retryable !== false && attempts < MAX_RETRIES_PER_CHUNK) {
            if (lastCallFailure?.rateLimited) {
              emitProgress(
                `Đã dịch ${completedChunkSet.size}/${totalChunks} phần (đang giãn nhịp RPM)...`
              );
              await new Promise((resolve) => setTimeout(resolve, 3500 + attempts * 1000));
            } else {
              await new Promise((resolve) => setTimeout(resolve, 900 * attempts));
            }
            if (!completedChunkSet.has(chunkIdx) && !effectiveStopSignal.current) {
              pendingQueue.push(chunkIdx);
            }
          } else {
            failedChunkSet.add(chunkIdx);
            lastFatalOrKeyError = lastCallFailure?.error || lastFatalOrKeyError;
            emitProgress(
              `Đã dịch ${completedChunkSet.size}/${totalChunks} phần (${failedChunkSet.size} phần lỗi)`
            );
            if (checkAllDone()) break;
          }
        } catch (err: unknown) {
          flightEntry.activeAttempts = Math.max(0, flightEntry.activeAttempts - 1);
          if (effectiveStopSignal.current) break;
          if (completedChunkSet.has(chunkIdx) || flightEntry.activeAttempts > 0) {
            continue;
          }

          inFlightChunks.delete(chunkIdx);
          const attempts = (chunkRetryCounts.get(chunkIdx) || 0) + 1;
          chunkRetryCounts.set(chunkIdx, attempts);
          lastFatalOrKeyError = err instanceof Error ? err.message : String(err);

          if (attempts < MAX_RETRIES_PER_CHUNK) {
            await new Promise((resolve) => setTimeout(resolve, 900 * attempts));
            if (!completedChunkSet.has(chunkIdx) && !effectiveStopSignal.current) {
              pendingQueue.push(chunkIdx);
            }
          } else {
            failedChunkSet.add(chunkIdx);
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

  const isStopped = Boolean(stopSignal.current);
  const allCompleted =
    !isStopped &&
    failedChunkSet.size === 0 &&
    completedChunkSet.size === totalChunks;

  const finalStatus: EpubTranslationJob['status'] = allCompleted
    ? 'completed'
    : isStopped
    ? 'paused'
    : 'error';

  await updateEpubJobMetadata(job.jobId, {
    status: finalStatus,
    failedChunkIds: Array.from(failedChunkSet),
    completedChunkIds: Array.from(completedChunkSet),
    translatedSegments,
    ...(getElapsedMs ? { elapsedMs: getElapsedMs() } : {}),
    ...(allCompleted ? { completedAt: Date.now() } : {}),
    lastError: allCompleted ? undefined : lastFatalOrKeyError || undefined,
  });

  emitProgress(
    allCompleted
      ? `Hoàn tất dịch ${totalChunks}/${totalChunks} phần!`
      : isStopped
      ? `Đã tạm dừng (${completedChunkSet.size}/${totalChunks} phần đã lưu checkpoint).`
      : `Dừng với ${failedChunkSet.size} phần chưa hoàn tất (${completedChunkSet.size}/${totalChunks} đã lưu).`
  );

  const warningMessage =
    allCompleted && contentFilteredSegmentsCount > 0
      ? `Có ${contentFilteredSegmentsCount} đoạn giữ nguyên bản gốc do bộ lọc Google AI (${lastContentFilterReason || 'SAFETY/RECITATION'}).`
      : undefined;

  return {
    completed: allCompleted,
    stopped: isStopped,
    translatedSegments,
    completedChunkIds: Array.from(completedChunkSet),
    failedChunkIds: Array.from(failedChunkSet),
    ...(warningMessage ? { warningMessage } : {}),
    errorMessage: allCompleted
      ? undefined
      : isStopped
      ? undefined
      : lastFatalOrKeyError || 'Một số phần chưa dịch xong do hết quota hoặc lỗi mạng.',
  };
}
