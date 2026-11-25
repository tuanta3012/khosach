import { BookRecord } from '../types';
import {
  BookCoverCandidate,
  findBookCoverCandidates,
  verifyCoverImageLoadable,
  fetchOgImageFromBookPage,
} from './bookLookupService';
import {
  ensureGeminiAccessAvailable,
  getEffectiveGeminiKeys,
  getSafeAiConcurrency,
  resolveBookCoverQueriesBatch,
  searchBookCoverWithGeminiGrounding,
} from './geminiService';

export interface BatchCoverProgress {
  phase: 'catalog' | 'ai-hints' | 'ai-grounding' | 'done';
  processed: number;
  total: number;
  foundCount: number;
  statusMessage: string;
}

export interface PrecomputedCoverHint {
  originalTitle?: string;
  isbn?: string;
  searchQuery?: string;
  alreadyAnalyzedByAi?: boolean;
}

export interface BatchFindCoversOptions {
  overwriteExisting?: boolean;
  enrichSummary?: boolean;
  useAiFallback?: boolean;
  skipGrounding?: boolean;
  catalogWorkers?: number;
  precomputedHints?: Map<string, PrecomputedCoverHint>;
  stopSignal?: { current: boolean };
  onProgress?: (progress: BatchCoverProgress) => void;
  onChunkSave?: (updatedBooks: BookRecord[]) => Promise<void>;
}

export interface BatchFindCoversResult {
  updatedCount: number;
  processedCount: number;
  stopped: boolean;
}

/**
 * Chọn ứng viên ảnh bìa đầu tiên thực sự tải được trên thiết bị.
 */
export async function pickFirstLoadableCover(
  candidates: BookCoverCandidate[],
  maxProbe = 4,
  timeoutMs = 2800
): Promise<BookCoverCandidate | null> {
  for (const cand of candidates.slice(0, maxProbe)) {
    const ok = await verifyCoverImageLoadable(cand.coverUrl, timeoutMs);
    if (ok) return cand;
  }
  return null;
}

/**
 * Tìm đa nguồn ứng viên ảnh bìa cho 1 cuốn sách (dùng cho Modal thêm/sửa sách).
 * Kết hợp các nguồn mở trước, sau đó tự động bổ sung Gemini + Google Search Grounding nếu chưa đủ.
 */
export async function findBookCoverCandidatesFull(
  title: string,
  author = '',
  publisher = '',
  options?: { allowAi?: boolean; stopSignal?: { current: boolean } }
): Promise<BookCoverCandidate[]> {
  const cleanTitle = (title || '').trim();
  if (!cleanTitle) return [];

  let candidates = await findBookCoverCandidates(cleanTitle, author);

  const allowAi = options?.allowAi !== false;
  if (allowAi && !options?.stopSignal?.current && (candidates.length === 0 || candidates[0].score < 85)) {
    const hasAi = await ensureGeminiAccessAvailable();
    if (hasAi) {
      const emptyGrounding: {
        pageUrls: string[];
        directImageUrls: string[];
        isbn?: string;
        originalTitle?: string;
      } = { pageUrls: [], directImageUrls: [] };

      const [batchHints, grounding] = await Promise.all([
        resolveBookCoverQueriesBatch(
          [{ id: 'single', title: cleanTitle, author, publisher }],
          options?.stopSignal
        ).catch(() => []),
        candidates.length === 0
          ? searchBookCoverWithGeminiGrounding(cleanTitle, author, publisher, options?.stopSignal).catch(
              () => emptyGrounding
            )
          : Promise.resolve(emptyGrounding),
      ]);

      const hint = batchHints[0];
      const extraOrig = grounding.originalTitle || hint?.originalTitle || '';
      const extraIsbn = grounding.isbn || hint?.isbn || '';

      if (extraOrig || extraIsbn || hint?.searchQuery) {
        const aiCatalogResults = await findBookCoverCandidates(cleanTitle, author, {
          originalTitle: extraOrig,
          originalAuthor: hint?.originalAuthor,
          altSearchQuery: hint?.searchQuery,
          isbn: extraIsbn,
          skipCache: true,
        });
        candidates = [...candidates, ...aiCatalogResults];
      }

      for (const directUrl of grounding.directImageUrls || []) {
        candidates.push({
          coverUrl: directUrl,
          title: cleanTitle,
          author,
          provider: 'Web',
          score: 80,
        });
      }

      if ((grounding.pageUrls || []).length > 0 && candidates.length < 3) {
        const ogResults = await Promise.all(
          grounding.pageUrls.slice(0, 3).map(async (pageUrl) => {
            const img = await fetchOgImageFromBookPage(pageUrl);
            if (!img) return null;
            return {
              coverUrl: img,
              title: cleanTitle,
              author,
              provider: 'Web' as const,
              score: 78,
              sourceUrl: pageUrl,
            } as BookCoverCandidate;
          })
        );
        for (const item of ogResults) {
          if (item) candidates.push(item);
        }
      }
    }
  }

  // Khử trùng và xác thực nhanh các ứng viên hàng đầu
  const dedupedMap = new Map<string, BookCoverCandidate>();
  for (const cand of candidates) {
    if (!cand.coverUrl) continue;
    const prev = dedupedMap.get(cand.coverUrl);
    if (!prev || cand.score > prev.score) {
      dedupedMap.set(cand.coverUrl, cand);
    }
  }

  const sorted = Array.from(dedupedMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const verified: BookCoverCandidate[] = [];
  await Promise.all(
    sorted.map(async (cand) => {
      const ok = await verifyCoverImageLoadable(cand.coverUrl, 4500);
      if (ok) verified.push(cand);
    })
  );

  return verified.sort((a, b) => b.score - a.score);
}

/**
 * Tìm 1 URL ảnh bìa hợp lệ tốt nhất cho 1 cuốn sách (kết hợp thư mục mở + AI fallback nếu cần).
 * Trả về 'NONE' nếu không tìm thấy ảnh bìa trực tuyến khả dụng.
 */
export async function resolveCoverUrlForBook(
  title: string,
  author = '',
  publisher = '',
  options?: { existingCoverUrl?: string; forceRefresh?: boolean; allowAi?: boolean; stopSignal?: { current: boolean } }
): Promise<string> {
  const existing = (options?.existingCoverUrl || '').trim();
  if (!options?.forceRefresh && existing && existing.toUpperCase() !== 'NONE') {
    return existing;
  }
  if (options?.stopSignal?.current) {
    return existing || '';
  }

  try {
    const candidates = await findBookCoverCandidatesFull(title, author, publisher, {
      allowAi: options?.allowAi !== false,
      stopSignal: options?.stopSignal,
    });
    if (candidates.length > 0 && candidates[0].coverUrl) {
      return candidates[0].coverUrl;
    }
  } catch (err) {
    console.warn('[CoverResolve] Không tìm được ảnh bìa:', title, err);
  }

  return options?.stopSignal?.current ? existing : 'NONE';
}

/**
 * Tìm & cập nhật ảnh bìa và tóm tắt hàng loạt cho kho sách:
 * - Vòng 1: Tra cứu miễn phí siêu tốc qua Goodreads, Apple Books, Open Library, Google Books, Wikipedia.
 * - Vòng 2 (cho sách còn thiếu bìa hoặc tóm tắt): Dùng Gemini giải mã tên gốc/ISBN + tạo tóm tắt nội dung 1-3 câu.
 * - Vòng 3 (cho sách Việt Nam đặc thù còn thiếu): Dùng Gemini Search Grounding + og:image.
 * - Đánh dấu 'NONE' ở cột H nếu không tìm thấy bìa để không bị quét lại các lần sau.
 */
export async function batchFindBookCovers(
  books: BookRecord[],
  options: BatchFindCoversOptions = {}
): Promise<BatchFindCoversResult> {
  const {
    overwriteExisting = false,
    enrichSummary = true,
    useAiFallback = true,
    skipGrounding = false,
    catalogWorkers = 12,
    precomputedHints,
    stopSignal,
    onProgress,
    onChunkSave,
  } = options;

  const targetBooks = overwriteExisting
    ? [...books]
    : books.filter((b) => {
        const hasCover = Boolean(b.cover_url && b.cover_url.trim());
        const hasSummary = Boolean(b.summary && b.summary.trim());
        if (enrichSummary) {
          return !hasCover || !hasSummary;
        }
        return !hasCover;
      });

  if (targetBooks.length === 0) {
    onProgress?.({
      phase: 'done',
      processed: 0,
      total: 0,
      foundCount: 0,
      statusMessage: 'Tất cả sách đã có ảnh bìa và tóm tắt.',
    });
    return { updatedCount: 0, processedCount: 0, stopped: false };
  }

  const batchStartedAt = Date.now();
  let totalFound = 0;
  let totalProcessed = 0;
  const pendingSaveBuffer: BookRecord[] = [];
  const foundIds = new Set<string>();
  const summaryMap = new Map<string, string>();

  console.log(
    `[CoverBatch] Bắt đầu tìm bìa: ${targetBooks.length} cuốn • workers=${catalogWorkers} • useAiFallback=${useAiFallback} • skipGrounding=${skipGrounding}`
  );

  const flushSaves = async (force = false) => {
    if (pendingSaveBuffer.length === 0) return;
    if (!force && pendingSaveBuffer.length < 8) return;
    const batch = pendingSaveBuffer.splice(0, pendingSaveBuffer.length);
    if (onChunkSave) {
      await onChunkSave(batch);
    }
  };

  const recordBookCover = async (book: BookRecord, coverUrl: string, summary?: string) => {
    foundIds.add(book.id);
    totalFound += 1;
    const finalSummary = (summary && summary.trim()) || summaryMap.get(book.id) || book.summary;
    pendingSaveBuffer.push({
      ...book,
      cover_url: coverUrl,
      ...(finalSummary ? { summary: finalSummary } : {}),
      updated_at: Date.now(),
    });
    await flushSaves(false);
  };

  // === VÒNG 1: TRA CỨU THƯ MỤC MỞ MIỄN PHÍ SONG SONG ===
  const v1StartedAt = Date.now();
  let catalogIdx = 0;
  const CATALOG_WORKERS = Math.max(1, Math.min(catalogWorkers, targetBooks.length));

  const runCatalogWorker = async () => {
    while (catalogIdx < targetBooks.length) {
      if (stopSignal?.current) break;
      const idx = catalogIdx++;
      if (idx >= targetBooks.length) break;

      const book = targetBooks[idx];
      // Nếu đã có cover và chỉ cần tóm tắt thì bỏ qua Vòng 1 catalog cover
      if (book.cover_url && book.cover_url.trim() && book.cover_url.trim().toUpperCase() !== 'NONE' && !overwriteExisting) {
        totalProcessed += 1;
        continue;
      }

      try {
        const preHint = precomputedHints?.get(book.id);
        const candidates = await findBookCoverCandidates(book.title, book.author || '', {
          ...(preHint?.originalTitle ? { originalTitle: preHint.originalTitle } : {}),
          ...(preHint?.isbn ? { isbn: preHint.isbn } : {}),
          ...(preHint?.searchQuery ? { altSearchQuery: preHint.searchQuery } : {}),
        });
        const best = await pickFirstLoadableCover(candidates, 2, 2400);
        if (best) {
          await recordBookCover(book, best.coverUrl);
        }
      } catch (err) {
        console.warn('[CoverBatch] Catalog lookup warning:', book.title, err);
      }

      totalProcessed += 1;
      onProgress?.({
        phase: 'catalog',
        processed: totalProcessed,
        total: targetBooks.length,
        foundCount: totalFound,
        statusMessage: `Đang tìm bìa (${totalProcessed}/${targetBooks.length}) • Đã khớp ${totalFound} bìa`,
      });
    }
  };

  await Promise.all(Array.from({ length: CATALOG_WORKERS }, () => runCatalogWorker()));
  await flushSaves(true);

  console.log(
    `[CoverBatch] Xong Vòng 1 (catalog) sau ${((Date.now() - v1StartedAt) / 1000).toFixed(1)}s: ` +
      `khớp ${totalFound}/${targetBooks.length} cuốn`
  );

  if (stopSignal?.current) {
    return {
      updatedCount: totalFound,
      processedCount: totalProcessed,
      stopped: true,
    };
  }

  // === VÒNG 2 & 3: BỔ SUNG BẰNG GEMINI AI CHO CÁC CUỐN CÒN THIẾU BÌA HOẶC TÓM TẮT ===
  const remainingBooks = targetBooks.filter((b) => {
    const missingCover = !foundIds.has(b.id);
    const missingSummary = enrichSummary && (!b.summary || !b.summary.trim());
    if (missingSummary) return true;
    if (!missingCover) return false;
    // Nếu Phase 1 (batchNormalize) đã phân tích cuốn này rồi hoặc đã có hint thì không gọi AI hint lặp lại
    const pre = precomputedHints?.get(b.id);
    if (pre?.alreadyAnalyzedByAi || pre?.originalTitle || pre?.isbn) {
      return false;
    }
    return true;
  });

  if (useAiFallback && (remainingBooks.length > 0 || (!skipGrounding && targetBooks.some((b) => !foundIds.has(b.id)))) && (await ensureGeminiAccessAvailable())) {
    const keys = getEffectiveGeminiKeys();
    const concurrency = getSafeAiConcurrency(keys.length, 12);

    // Vòng 2: Giải mã tên gốc quốc tế / từ khóa sạch / ISBN + Tóm tắt nội dung theo lô 10 cuốn
    const CHUNK_SIZE = 10;
    const chunks: BookRecord[][] = [];
    for (let i = 0; i < remainingBooks.length; i += CHUNK_SIZE) {
      chunks.push(remainingBooks.slice(i, i + CHUNK_SIZE));
    }

    let chunkCursor = 0;
    let aiProcessed = 0;
    const v2StartedAt = Date.now();
    if (chunks.length > 0) {
      console.log(
        `[CoverBatch] Vòng 2 (AI hints): ${remainingBooks.length} cuốn -> ${chunks.length} lô với ${Math.min(concurrency, chunks.length)} luồng`
      );
    }

    const runAiHintWorker = async (workerIdx: number) => {
      const pinnedKey = keys.length > 0 ? keys[workerIdx % keys.length] : undefined;
      const staggerMs = keys.length >= 4 ? 120 : 300;
      if (workerIdx > 0) {
        await new Promise((r) => setTimeout(r, workerIdx * staggerMs));
      }
      while (chunkCursor < chunks.length) {
        if (stopSignal?.current) break;
        const cIdx = chunkCursor++;
        if (cIdx >= chunks.length) break;

        const chunk = chunks[cIdx];
        const hints = await resolveBookCoverQueriesBatch(
          chunk.map((b) => ({ id: b.id, title: b.title, author: b.author, publisher: b.publisher })),
          stopSignal,
          pinnedKey
        );
        const hintMap = new Map(hints.map((h) => [h.id, h]));

        await Promise.all(
          chunk.map(async (book) => {
            if (stopSignal?.current) return;
            const hint = hintMap.get(book.id);
            if (hint?.summary) {
              summaryMap.set(book.id, hint.summary);
            }
            if (!foundIds.has(book.id) && hint && (hint.originalTitle || hint.searchQuery || hint.isbn)) {
              const candidates = await findBookCoverCandidates(book.title, book.author || '', {
                originalTitle: hint.originalTitle,
                originalAuthor: hint.originalAuthor,
                altSearchQuery: hint.searchQuery,
                isbn: hint.isbn,
                skipCache: true,
              });
              const best = await pickFirstLoadableCover(candidates, 2, 2400);
              if (best) {
                await recordBookCover(book, best.coverUrl, hint.summary);
              }
            }
            aiProcessed += 1;
            onProgress?.({
              phase: 'ai-hints',
              processed: aiProcessed,
              total: remainingBooks.length,
              foundCount: totalFound,
              statusMessage: `AI phân tích tên gốc/ISBN (${aiProcessed}/${remainingBooks.length}) • Tổng ${totalFound} bìa`,
            });
          })
        );
      }
    };

    if (chunks.length > 0) {
      await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, (_, i) => runAiHintWorker(i)));
      await flushSaves(true);
      console.log(
        `[CoverBatch] Xong Vòng 2 sau ${((Date.now() - v2StartedAt) / 1000).toFixed(1)}s • Tổng khớp=${totalFound} bìa`
      );
    }

    // Vòng 3: Google Search Grounding (chỉ chạy khi không skipGrounding)
    const stillMissing = targetBooks.filter((b) => !foundIds.has(b.id));
    if (!skipGrounding && !stopSignal?.current && stillMissing.length > 0) {
      const v3StartedAt = Date.now();
      let groundCursor = 0;
      let groundProcessed = 0;
      const groundWorkers = Math.max(1, Math.min(keys.length, 6, stillMissing.length));
      console.log(`[CoverBatch] Vòng 3 (AI Grounding): ${stillMissing.length} cuốn với ${groundWorkers} luồng`);

      const runGroundWorker = async (wIdx: number) => {
        const pinnedKey = keys.length > 0 ? keys[wIdx % keys.length] : undefined;
        if (wIdx > 0) await new Promise((r) => setTimeout(r, wIdx * 150));
        while (groundCursor < stillMissing.length) {
          if (stopSignal?.current) break;
          const gIdx = groundCursor++;
          if (gIdx >= stillMissing.length) break;

          const book = stillMissing[gIdx];
          try {
            const ground = await searchBookCoverWithGeminiGrounding(
              book.title,
              book.author || '',
              book.publisher || '',
              stopSignal,
              pinnedKey
            );

            const extraCandidates: BookCoverCandidate[] = [];
            for (const url of ground.directImageUrls || []) {
              extraCandidates.push({
                coverUrl: url,
                title: book.title,
                author: book.author || '',
                provider: 'Web',
                score: 82,
              });
            }

            if (ground.isbn || ground.originalTitle) {
              const catMore = await findBookCoverCandidates(book.title, book.author || '', {
                originalTitle: ground.originalTitle,
                isbn: ground.isbn,
                skipCache: true,
              });
              extraCandidates.push(...catMore);
            }

            if (extraCandidates.length === 0 && (ground.pageUrls || []).length > 0) {
              for (const pageUrl of ground.pageUrls.slice(0, 2)) {
                if (stopSignal?.current) break;
                const ogImg = await fetchOgImageFromBookPage(pageUrl);
                if (ogImg) {
                  extraCandidates.push({
                    coverUrl: ogImg,
                    title: book.title,
                    author: book.author || '',
                    provider: 'Web',
                    score: 76,
                    sourceUrl: pageUrl,
                  });
                }
              }
            }

            const verified = await pickFirstLoadableCover(extraCandidates, 3, 2600);
            if (verified) {
              await recordBookCover(book, verified.coverUrl, summaryMap.get(book.id));
            }
          } catch {}

          groundProcessed += 1;
          onProgress?.({
            phase: 'ai-grounding',
            processed: groundProcessed,
            total: stillMissing.length,
            foundCount: totalFound,
            statusMessage: `Tìm web cho sách Việt (${groundProcessed}/${stillMissing.length}) • Tổng ${totalFound} bìa`,
          });
        }
      };

      await Promise.all(Array.from({ length: groundWorkers }, (_, i) => runGroundWorker(i)));
      await flushSaves(true);
      console.log(
        `[CoverBatch] Xong Vòng 3 sau ${((Date.now() - v3StartedAt) / 1000).toFixed(1)}s • Tổng khớp=${totalFound} bìa`
      );
    }
  }

  // Đánh dấu 'NONE' ở cột H cho các sách không tìm thấy bìa để không quét lại lần sau
  if (!stopSignal?.current) {
    const notFoundBooks = targetBooks.filter((b) => !foundIds.has(b.id));
    for (const book of notFoundBooks) {
      const summaryToSave = summaryMap.get(book.id) || book.summary;
      const currentCover = (book.cover_url || '').trim();
      const finalCover = currentCover && currentCover !== 'NONE' ? currentCover : 'NONE';
      pendingSaveBuffer.push({
        ...book,
        cover_url: finalCover,
        ...(summaryToSave ? { summary: summaryToSave } : {}),
        updated_at: Date.now(),
      });
    }
    await flushSaves(true);
  }

  console.log(
    `[CoverBatch] Hoàn tất sau ${((Date.now() - batchStartedAt) / 1000).toFixed(1)}s: ` +
      `đã cập nhật ${totalFound}/${targetBooks.length} bìa (NONE=${targetBooks.length - totalFound})`
  );

  onProgress?.({
    phase: 'done',
    processed: targetBooks.length,
    total: targetBooks.length,
    foundCount: totalFound,
    statusMessage: `Hoàn tất: đã cập nhật ${totalFound} ảnh bìa.`,
  });

  return {
    updatedCount: totalFound,
    processedCount: targetBooks.length,
    stopped: Boolean(stopSignal?.current),
  };
}
