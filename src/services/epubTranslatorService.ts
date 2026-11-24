import {
  EpubGenreConfig,
  EpubGenreId,
  EpubTranslatableSegment,
  EpubTranslationJob,
  EpubTranslationProgress,
} from '../types';
import {
  EPUB_BACKUP_MODEL,
  EPUB_TRANSLATION_MODEL,
  executeEpubFlashLiteWithKey,
  getAvailableEpubTranslationKeys,
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
}

/**
 * Chạy dịch song song nhiều chunk dựa trên tổng số Gemini API Key hợp lệ đang có,
 * chỉ sử dụng model gemini-3.5-flash-lite và tôn trọng quota 15 RPM/key.
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
  const chunkRetryCounts = new Map<number, number>();
  const workerCount = Math.min(availableKeys.length, pendingQueue.length);
  let activeWorkersCount = workerCount;
  let inFlightCount = 0;
  let backupUsedCount = 0;
  let lastFatalOrKeyError = '';

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
      activeWorkers: activeWorkersCount,
      totalKeys: availableKeys.length,
      statusMessage,
    });
  };

  emitProgress(
    `Đang khởi động ${workerCount} luồng song song (${EPUB_TRANSLATION_MODEL} · dự phòng ${EPUB_BACKUP_MODEL})...`
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

  const translateItemsInSubBatches = async (
    items: Array<{ id: number; text: string }>,
    apiKey: string
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
    const subBatchSize = Math.max(1, Math.min(6, Math.ceil(items.length / 2)));
    let usedBackup = false;

    for (let offset = 0; offset < items.length; offset += subBatchSize) {
      if (stopSignal.current) {
        return { success: false, parsedMap: merged, aborted: true, retryable: true };
      }

      const subItems = items.slice(offset, offset + subBatchSize);
      const res = await executeEpubFlashLiteWithKey({
        key: apiKey,
        systemInstruction,
        promptText: buildChunkPrompt(subItems),
        responseSchema: CHUNK_RESPONSE_SCHEMA,
        preferredModels: [EPUB_BACKUP_MODEL, EPUB_TRANSLATION_MODEL],
        stopSignal,
      });

      if (res.usedModel === EPUB_BACKUP_MODEL) usedBackup = true;
      if (stopSignal.current || res.aborted) {
        return { success: false, parsedMap: merged, aborted: true, retryable: true };
      }
      if (!res.success || !Array.isArray(res.data)) {
        return {
          success: false,
          parsedMap: merged,
          keyExhausted: res.keyExhausted,
          rateLimited: res.rateLimited,
          retryable: res.retryable,
          error: res.error,
        };
      }

      const subMap = extractValidMap(res.data);
      for (const it of subItems) {
        const val = subMap.get(it.id);
        if (val && val.length > 0) {
          merged.set(it.id, val);
        }
      }
    }

    return { success: true, parsedMap: merged, usedBackup };
  };

  const runKeyWorker = async (workerIndex: number, apiKey: string) => {
    if (workerIndex > 0) {
      await new Promise((resolve) => setTimeout(resolve, workerIndex * 280));
    }

    while (!stopSignal.current) {
      const chunkIdx = pendingQueue.shift();
      if (chunkIdx === undefined) {
        if (inFlightCount === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 180));
        continue;
      }

      inFlightCount += 1;
      try {
        const chunk = job.parsedData.chunks[chunkIdx];
        if (!chunk) continue;

        const chunkSegments = chunk.segmentIds
          .map((id) => segmentMap.get(id))
          .filter((s): s is EpubTranslatableSegment => Boolean(s));

        const preservedSegments = chunkSegments.filter((s) => s.kind === 'opf-title');
        const inputItems = chunkSegments
          .filter((s) => s.kind !== 'opf-title')
          .map((s) => ({ id: s.segId, text: s.tokenText }));

        if (inputItems.length === 0) {
          if (preservedSegments.length > 0) {
            const preservedUpdates: Record<number, string> = {};
            for (const s of preservedSegments) {
              preservedUpdates[s.segId] = s.tokenText;
              translatedSegments[s.segId] = s.tokenText;
            }
            await recordChunkCheckpoint(job.jobId, chunkIdx, preservedUpdates, getElapsedMs?.());
          }
          completedChunkSet.add(chunkIdx);
          continue;
        }

        const attemptsBefore = chunkRetryCounts.get(chunkIdx) || 0;

        // Lần đầu ưu tiên 3.5 (tự failover sang 3.1 nếu 3.5 lỗi/rỗng/RPM);
        // Từ lần thử 2 trở đi: đảo ưu tiên sang 3.1-flash-lite làm backup chủ lực;
        // Nếu vẫn gặp khó trên chunk nhiều đoạn -> tự động chia nhỏ sub-batch để giải quyết dứt điểm.
        let finalParsedMap: Map<number, string> | null = null;
        let usedBackupModel = false;
        let lastCallFailure: {
          aborted?: boolean;
          keyExhausted?: boolean;
          rateLimited?: boolean;
          retryable?: boolean;
          error?: string;
        } | null = null;

        if (attemptsBefore >= 2 && inputItems.length > 1) {
          const splitRes = await translateItemsInSubBatches(inputItems, apiKey);
          if (splitRes.aborted) {
            pendingQueue.unshift(chunkIdx);
            break;
          }
          if (splitRes.usedBackup) usedBackupModel = true;
          if (splitRes.success) {
            finalParsedMap = splitRes.parsedMap;
          } else {
            lastCallFailure = splitRes;
          }
        } else {
          const preferredModels =
            attemptsBefore >= 1
              ? [EPUB_BACKUP_MODEL, EPUB_TRANSLATION_MODEL]
              : [EPUB_TRANSLATION_MODEL, EPUB_BACKUP_MODEL];

          const res = await executeEpubFlashLiteWithKey({
            key: apiKey,
            systemInstruction,
            promptText: buildChunkPrompt(inputItems),
            responseSchema: CHUNK_RESPONSE_SCHEMA,
            preferredModels,
            stopSignal,
          });

          if (stopSignal.current || res.aborted) {
            pendingQueue.unshift(chunkIdx);
            break;
          }

          if (res.usedModel === EPUB_BACKUP_MODEL) usedBackupModel = true;

          if (res.success && Array.isArray(res.data)) {
            const parsedMap = extractValidMap(res.data);
            const missingCount = inputItems.filter(
              (it) => !parsedMap.has(it.id) || !parsedMap.get(it.id)
            ).length;

            if (missingCount > Math.max(2, Math.floor(inputItems.length * 0.2))) {
              // Nếu 3.5 trả thiếu đoạn, chuyển ngay sang 3.1 (hoặc chia nhỏ) trước khi tính thất bại
              if (res.usedModel === EPUB_TRANSLATION_MODEL) {
                const backupRes = await executeEpubFlashLiteWithKey({
                  key: apiKey,
                  systemInstruction,
                  promptText: buildChunkPrompt(inputItems),
                  responseSchema: CHUNK_RESPONSE_SCHEMA,
                  preferredModels: [EPUB_BACKUP_MODEL],
                  stopSignal,
                });
                if (stopSignal.current || backupRes.aborted) {
                  pendingQueue.unshift(chunkIdx);
                  break;
                }
                if (backupRes.success && Array.isArray(backupRes.data)) {
                  const backupMap = extractValidMap(backupRes.data);
                  const backupMissing = inputItems.filter(
                    (it) => !backupMap.has(it.id) || !backupMap.get(it.id)
                  ).length;
                  if (backupMissing < missingCount) {
                    usedBackupModel = true;
                    finalParsedMap = backupMap;
                  }
                }
              }

              if (!finalParsedMap && inputItems.length > 1) {
                const splitRes = await translateItemsInSubBatches(inputItems, apiKey);
                if (splitRes.aborted) {
                  pendingQueue.unshift(chunkIdx);
                  break;
                }
                if (splitRes.success) {
                  usedBackupModel = true;
                  finalParsedMap = splitRes.parsedMap;
                }
              }

              if (!finalParsedMap) {
                const attemptsSoFar = attemptsBefore + 1;
                if (attemptsSoFar < MAX_RETRIES_PER_CHUNK) {
                  chunkRetryCounts.set(chunkIdx, attemptsSoFar);
                  pendingQueue.push(chunkIdx);
                  continue;
                }
                finalParsedMap = parsedMap;
              }
            } else {
              finalParsedMap = parsedMap;
            }
          } else {
            lastCallFailure = res;
          }
        }

        if (finalParsedMap) {
          if (usedBackupModel) backupUsedCount += 1;

          const chunkUpdates: Record<number, string> = {};
          for (const it of inputItems) {
            const translatedVal = finalParsedMap.get(it.id);
            const finalVal = translatedVal && translatedVal.length > 0 ? translatedVal : it.text;
            chunkUpdates[it.id] = finalVal;
            translatedSegments[it.id] = finalVal;
          }

          completedChunkSet.add(chunkIdx);
          failedChunkSet.delete(chunkIdx);

          await recordChunkCheckpoint(job.jobId, chunkIdx, chunkUpdates, getElapsedMs?.());
          if (onJobStateSync) {
            onJobStateSync({
              translatedSegments: { ...translatedSegments },
              completedChunkIds: Array.from(completedChunkSet),
              failedChunkIds: Array.from(failedChunkSet),
            });
          }

          const backupSuffix = backupUsedCount > 0 ? ` · dự phòng 3.1: ${backupUsedCount}` : '';
          emitProgress(
            `Đã dịch ${completedChunkSet.size}/${totalChunks} phần (${activeWorkersCount} luồng${backupSuffix})`
          );
          continue;
        }

        if (lastCallFailure?.keyExhausted) {
          lastFatalOrKeyError = lastCallFailure.error || 'Một API Key đã hết hạn ngạch hoặc không hợp lệ.';
          pendingQueue.unshift(chunkIdx);
          break;
        }

        const attempts = attemptsBefore + 1;
        chunkRetryCounts.set(chunkIdx, attempts);

        if (lastCallFailure?.retryable !== false && attempts < MAX_RETRIES_PER_CHUNK) {
          if (lastCallFailure?.rateLimited) {
            emitProgress(
              `Đã dịch ${completedChunkSet.size}/${totalChunks} phần (đang giãn nhịp RPM & chuyển 3.1-flash-lite)...`
            );
            await new Promise((resolve) => setTimeout(resolve, 4200 + attempts * 1200));
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1400 * attempts));
          }
          pendingQueue.push(chunkIdx);
        } else {
          failedChunkSet.add(chunkIdx);
          lastFatalOrKeyError = lastCallFailure?.error || lastFatalOrKeyError;
          emitProgress(
            `Đã dịch ${completedChunkSet.size}/${totalChunks} phần (${failedChunkSet.size} phần lỗi)`
          );
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

  return {
    completed: allCompleted,
    stopped: isStopped,
    translatedSegments,
    completedChunkIds: Array.from(completedChunkSet),
    failedChunkIds: Array.from(failedChunkSet),
    errorMessage: allCompleted
      ? undefined
      : isStopped
      ? undefined
      : lastFatalOrKeyError || 'Một số phần chưa dịch xong do hết quota hoặc lỗi mạng.',
  };
}
