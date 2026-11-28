import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import {
  BookExportProgress,
  BookOutputFormat,
  BookQueueGlobalSettings,
  EpubGenreId,
  EpubTranslationJob,
  EpubTranslationProgress,
  ParsedEpubData,
  PdfExportRenderMode,
  PdfOutputFormat,
  PdfProcessingMode,
} from '../types';
import {
  buildEpubJobId,
  buildPdfJobId,
  clearCompletedEpubJobs,
  deleteEpubJob,
  getEpubJobById,
  getNextQueueOrder,
  loadAllEpubJobs,
  normalizeInterruptedJobsOnStartup,
  saveEpubJob,
  sortJobsByQueueOrder,
  updateEpubJobMetadata,
} from './epubCheckpointDb';
import {
  buildPdfExportInputFromTranslatedEpub,
  parseEpubFile,
  reassembleAndPackageEpub,
} from './epubService';
import { runParallelEpubTranslation } from './epubTranslatorService';
import {
  buildPdfTranslationUnits,
  exportTranslatedPdfFile,
  parseDigitalPdfFile,
  reassemblePdfTranslationToEpub,
} from './pdfDigitalService';
import { DIGITAL_PDF_PARSER_VERSION } from './pdfDigitalParserCore';
import { runParallelPdfTranslation } from './pdfTranslatorService';
import {
  getEpubKeyDiagnostics,
  refreshServerGeminiStatus,
} from './geminiService';
import {
  buildVietnameseBookFileName,
  SavedEpubResult,
  saveTranslatedEpubToDevice,
} from '../utils/epubFileSaver';
import {
  acquireBackgroundKeepAlive,
  refreshBackgroundKeepAlive,
  releaseBackgroundKeepAlive,
} from '../utils/wakeLockService';

export interface QueueNotice {
  id: number;
  text: string;
  type: 'success' | 'info' | 'warning' | 'error';
}

export interface BookPackagingProgress extends BookExportProgress {
  jobId: string;
}

const GLOBAL_SETTINGS_STORAGE_KEY = 'kho_sach_book_translator_global_settings_v1';

const DEFAULT_GLOBAL_SETTINGS: BookQueueGlobalSettings = {
  genre: 'van-hoc',
  outputFormat: 'original',
  pdfRenderMode: 'digital',
  customNotes: '',
};

function loadGlobalSettings(): BookQueueGlobalSettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_GLOBAL_SETTINGS };
    const raw = localStorage.getItem(GLOBAL_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GLOBAL_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<BookQueueGlobalSettings>;
    const validFmt: BookOutputFormat =
      parsed.outputFormat === 'epub' || parsed.outputFormat === 'pdf' || parsed.outputFormat === 'original'
        ? parsed.outputFormat
        : 'original';
    const validRenderMode: PdfExportRenderMode =
      parsed.pdfRenderMode === 'image' ? 'image' : 'digital';
    return {
      genre: parsed.genre || 'van-hoc',
      outputFormat: validFmt,
      pdfRenderMode: validRenderMode,
      customNotes: typeof parsed.customNotes === 'string' ? parsed.customNotes : '',
    };
  } catch {
    return { ...DEFAULT_GLOBAL_SETTINGS };
  }
}

function saveGlobalSettings(settings: BookQueueGlobalSettings): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(GLOBAL_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    }
  } catch {}
}

export interface BookQueueSnapshot {
  initialized: boolean;
  isLoading: boolean;
  jobs: EpubTranslationJob[];
  globalSettings: BookQueueGlobalSettings;
  isRunning: boolean;
  isStopping: boolean;
  activeJobId: string | null;
  activeProgress: EpubTranslationProgress | null;
  activeSessionStartedAt: number | null;
  activeBaseElapsedMs: number;
  isParsingFiles: boolean;
  parseStatusText: string;
  packagingJobId: string | null;
  packagingProgress: BookPackagingProgress | null;
  lastNotice: QueueNotice | null;
}

const listeners = new Set<() => void>();
let noticeSeq = 0;

let state: BookQueueSnapshot = {
  initialized: false,
  isLoading: true,
  jobs: [],
  globalSettings: loadGlobalSettings(),
  isRunning: false,
  isStopping: false,
  activeJobId: null,
  activeProgress: null,
  activeSessionStartedAt: null,
  activeBaseElapsedMs: 0,
  isParsingFiles: false,
  parseStatusText: '',
  packagingJobId: null,
  packagingProgress: null,
  lastNotice: null,
};

let initPromise: Promise<void> | null = null;
let stopSignal: { current: boolean } = { current: false };
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let unloadHandlersBound = false;

function emit() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {}
  }
}

function setState(partial: Partial<BookQueueSnapshot>) {
  state = { ...state, ...partial };
  emit();
}

function pushNotice(text: string, type: QueueNotice['type'] = 'info') {
  noticeSeq += 1;
  setState({
    lastNotice: { id: noticeSeq, text, type },
  });
}

function getJobTotalChunks(job: EpubTranslationJob): number {
  if (job.sourceType === 'pdf' && job.parsedPdfData) {
    return job.pdfUnits?.length || 0;
  }
  return job.parsedData?.chunks?.length || 0;
}

export function isJobCompleted(job: EpubTranslationJob): boolean {
  const total = getJobTotalChunks(job);
  return (
    total > 0 &&
    job.completedChunkIds.length === total &&
    job.failedChunkIds.length === 0
  );
}

export function getJobElapsedMs(job: EpubTranslationJob, now = Date.now()): number {
  if (
    state.isRunning &&
    state.activeJobId === job.jobId &&
    state.activeSessionStartedAt !== null
  ) {
    return Math.max(
      job.elapsedMs || 0,
      state.activeBaseElapsedMs + Math.max(0, now - state.activeSessionStartedAt)
    );
  }
  return job.elapsedMs || 0;
}

function getCurrentActiveElapsedMs(now = Date.now()): number {
  if (state.activeSessionStartedAt === null) {
    return state.activeBaseElapsedMs;
  }
  return state.activeBaseElapsedMs + Math.max(0, now - state.activeSessionStartedAt);
}

export function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

// Using acquireBackgroundKeepAlive and releaseBackgroundKeepAlive from wakeLockService

async function sendBackgroundNotification(title: string, body: string): Promise<void> {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    return;
  }
  if (!Capacitor.isNativePlatform()) return;
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LocalNotifications.requestPermissions();
      if (req.display !== 'granted') return;
    }
    await LocalNotifications.schedule({
      notifications: [
        {
          id: Math.floor(Date.now() % 1000000),
          title,
          body,
          schedule: { at: new Date(Date.now() + 200) },
        },
      ],
    });
  } catch {}
}

function bindUnloadRecoveryHandlers() {
  if (unloadHandlersBound || typeof window === 'undefined') return;
  unloadHandlersBound = true;

  const handlePageUnload = () => {
    if (!state.isRunning || !state.activeJobId) return;
    stopSignal.current = true;
    const finalizedElapsed = getCurrentActiveElapsedMs();
    const targetId = state.activeJobId;
    // Lưu đồng bộ best-effort vào IndexedDB trước khi tiến trình WebView đóng
    void updateEpubJobMetadata(targetId, {
      status: 'paused',
      elapsedMs: finalizedElapsed,
    });
  };

  window.addEventListener('pagehide', handlePageUnload);
  window.addEventListener('beforeunload', handlePageUnload);

  // Tự động xin lại WakeLock nếu người dùng mở lại app trong khi đang dịch, tách hoặc xuất file
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (
        document.visibilityState === 'visible' &&
        (state.isRunning || Boolean(state.packagingJobId) || state.isParsingFiles)
      ) {
        void refreshBackgroundKeepAlive();
      }
    });
  }
}

export async function initBookQueueManager(): Promise<void> {
  if (initPromise) return initPromise;
  bindUnloadRecoveryHandlers();

  initPromise = (async () => {
    try {
      const normalized = await normalizeInterruptedJobsOnStartup();
      const syncedJobs: EpubTranslationJob[] = [];

      for (const job of normalized) {
        if (
          job.sourceType === 'pdf' &&
          job.parsedPdfData &&
          job.status !== 'completed' &&
          (job.completedChunkIds?.length || 0) === 0
        ) {
          const mode: PdfProcessingMode = 'auto';
          const freshUnits = buildPdfTranslationUnits(job.parsedPdfData, mode);
          const prevCount = job.pdfUnits?.length || 0;
          const prevKinds = (job.pdfUnits || []).map((u) => u.kind).join(',');
          const nextKinds = freshUnits.map((u) => u.kind).join(',');
          if (
            job.pdfProcessingMode !== mode ||
            freshUnits.length !== prevCount ||
            prevKinds !== nextKinds
          ) {
            const updated: EpubTranslationJob = {
              ...job,
              pdfProcessingMode: mode,
              pdfUnits: freshUnits,
            };
            syncedJobs.push(updated);
            void updateEpubJobMetadata(job.jobId, {
              pdfProcessingMode: mode,
              pdfUnits: freshUnits,
            });
            continue;
          }
        }
        syncedJobs.push(job);
      }

      setState({
        initialized: true,
        isLoading: false,
        jobs: syncedJobs,
      });
    } catch {
      setState({
        initialized: true,
        isLoading: false,
      });
    }
  })();

  return initPromise;
}

export function subscribeBookQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getBookQueueSnapshot(): BookQueueSnapshot {
  return state;
}

export async function refreshBookQueueFromDb(): Promise<void> {
  const jobs = await loadAllEpubJobs();
  setState({ jobs });
}

function updateJobInMemory(jobId: string, updater: (job: EpubTranslationJob) => EpubTranslationJob) {
  setState({
    jobs: state.jobs.map((j) => (j.jobId === jobId ? updater(j) : j)),
  });
}

const stopParsingRef = { current: false };

export function cancelFileParsing(): void {
  stopParsingRef.current = true;
  setState({
    isParsingFiles: false,
    parseStatusText: '',
  });
}

export async function addFilesToQueue(
  files: File[],
  defaultGenre?: EpubGenreId,
  defaultNotes?: string
): Promise<{ addedCount: number; restoredCount: number; skippedCount: number }> {
  await initBookQueueManager();
  if (!files || files.length === 0) {
    return { addedCount: 0, restoredCount: 0, skippedCount: 0 };
  }
  const effectiveGenre = defaultGenre ?? state.globalSettings.genre;
  const effectiveNotes = defaultNotes ?? state.globalSettings.customNotes;

  await acquireBackgroundKeepAlive();
  stopParsingRef.current = false;
  setState({ isParsingFiles: true, parseStatusText: `Đang kiểm tra ${files.length} tệp...` });

  let addedCount = 0;
  let restoredCount = 0;
  let skippedCount = 0;
  let firstFailedName = '';
  let firstSkipReason = '';
  let workingJobs = [...state.jobs];

  try {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const lowerName = file.name.toLowerCase();
      const isEpub = lowerName.endsWith('.epub');
      const isPdf = lowerName.endsWith('.pdf');

      if (!isEpub && !isPdf) {
        skippedCount += 1;
        if (!firstSkipReason) {
          firstFailedName = file.name;
          firstSkipReason = 'Chỉ hỗ trợ tệp .EPUB hoặc .PDF';
        }
        continue;
      }

      const prefix = files.length > 1 ? `(${i + 1}/${files.length}) ` : '';
      setState({
        parseStatusText: `${prefix}Đang đọc ${file.name}...`,
      });

      try {
        if (isPdf) {
          const jobId = buildPdfJobId(file.name, file.size, file.lastModified);
          const alreadyInQueue = workingJobs.find((j) => j.jobId === jobId);
          if (alreadyInQueue) {
            restoredCount += 1;
            continue;
          }

          const existingDb = await getEpubJobById(jobId);
          const needsReparse =
            existingDb &&
            existingDb.parsedPdfData &&
            (existingDb.completedChunkIds?.length || 0) === 0 &&
            (existingDb.parsedPdfData.parserVersion || 1) < DIGITAL_PDF_PARSER_VERSION;

          if (existingDb && existingDb.parsedPdfData && !needsReparse) {
            const isDone =
              existingDb.status === 'completed' || isJobCompleted(existingDb);
            const resolvedPdfOut: PdfOutputFormat =
              state.globalSettings.outputFormat === 'epub' ? 'epub' : 'pdf';
            const restored: EpubTranslationJob = {
              ...existingDb,
              genre: isDone ? existingDb.genre : effectiveGenre,
              customNotes: isDone ? existingDb.customNotes : effectiveNotes,
              pdfOutputFormat: resolvedPdfOut,
              queueOrder: existingDb.queueOrder ?? getNextQueueOrder(workingJobs),
              createdAt: existingDb.createdAt ?? existingDb.updatedAt,
              elapsedMs: existingDb.elapsedMs ?? 0,
            };
            await saveEpubJob(restored);
            workingJobs = sortJobsByQueueOrder([...workingJobs, restored]);
            setState({ jobs: workingJobs });
            restoredCount += 1;
            continue;
          }

          const buffer = await file.arrayBuffer();
          const parsedPdf = await parseDigitalPdfFile(buffer, file.name, (cur, total) => {
            setState({
              parseStatusText: `${prefix}Tách PDF: ${cur}/${total} trang`,
            });
          }, stopParsingRef);

          const initialMode: PdfProcessingMode = 'auto';
          const initialUnits = buildPdfTranslationUnits(parsedPdf, initialMode);
          const placeholderParsedData: ParsedEpubData = {
            opfPath: '',
            opfDir: '',
            spineFilePaths: [],
            bookTitle: parsedPdf.bookTitle,
            bookAuthor: parsedPdf.bookAuthor,
            bookPublisher: parsedPdf.bookPublisher,
            bookLanguage: 'und',
            segments: [],
            chunks: [],
          };

          const now = Date.now();
          const resolvedPdfOut: PdfOutputFormat =
            state.globalSettings.outputFormat === 'epub' ? 'epub' : 'pdf';
          const newJob: EpubTranslationJob = {
            jobId,
            sourceType: 'pdf',
            fileName: file.name,
            fileSize: file.size,
            lastModified: file.lastModified,
            genre: effectiveGenre,
            customNotes: effectiveNotes,
            epubBuffer: buffer,
            parsedData: placeholderParsedData,
            translatedSegments: {},
            pdfOutputFormat: resolvedPdfOut,
            pdfProcessingMode: initialMode,
            parsedPdfData: parsedPdf,
            pdfUnits: initialUnits,
            translatedPdfPages: {},
            completedChunkIds: [],
            failedChunkIds: [],
            status: 'idle',
            queueOrder: existingDb?.queueOrder ?? getNextQueueOrder(workingJobs),
            createdAt: existingDb?.createdAt ?? now,
            elapsedMs: 0,
            updatedAt: now,
          };

          await saveEpubJob(newJob);
          workingJobs = sortJobsByQueueOrder([...workingJobs, newJob]);
          setState({ jobs: workingJobs });
          addedCount += 1;
        } else {
          const jobId = buildEpubJobId(file.name, file.size, file.lastModified);
          const alreadyInQueue = workingJobs.find((j) => j.jobId === jobId);
          if (alreadyInQueue) {
            restoredCount += 1;
            continue;
          }

          const existingDb = await getEpubJobById(jobId);
          if (existingDb) {
            const isDone =
              existingDb.status === 'completed' || isJobCompleted(existingDb);
            const restored: EpubTranslationJob = {
              ...existingDb,
              genre: isDone ? existingDb.genre : effectiveGenre,
              customNotes: isDone ? existingDb.customNotes : effectiveNotes,
              queueOrder: existingDb.queueOrder ?? getNextQueueOrder(workingJobs),
              createdAt: existingDb.createdAt ?? existingDb.updatedAt,
              elapsedMs: existingDb.elapsedMs ?? 0,
            };
            await saveEpubJob(restored);
            workingJobs = sortJobsByQueueOrder([...workingJobs, restored]);
            setState({ jobs: workingJobs });
            restoredCount += 1;
            continue;
          }

          const buffer = await file.arrayBuffer();
          const parsedData = await parseEpubFile(buffer);
          if (parsedData.segments.length === 0 || parsedData.chunks.length === 0) {
            skippedCount += 1;
            if (!firstSkipReason) {
              firstFailedName = file.name;
              firstSkipReason = 'Không tìm thấy nội dung văn bản trong EPUB.';
            }
            continue;
          }

          const now = Date.now();
          const newJob: EpubTranslationJob = {
            jobId,
            sourceType: 'epub',
            fileName: file.name,
            fileSize: file.size,
            lastModified: file.lastModified,
            genre: effectiveGenre,
            customNotes: effectiveNotes,
            epubBuffer: buffer,
            parsedData,
            translatedSegments: {},
            completedChunkIds: [],
            failedChunkIds: [],
            status: 'idle',
            queueOrder: getNextQueueOrder(workingJobs),
            createdAt: now,
            elapsedMs: 0,
            updatedAt: now,
          };

          await saveEpubJob(newJob);
          workingJobs = sortJobsByQueueOrder([...workingJobs, newJob]);
          setState({ jobs: workingJobs });
          addedCount += 1;
        }
      } catch (err) {
        console.warn('[BookQueue] Lỗi đọc tệp:', file.name, err);
        skippedCount += 1;
        if (!firstSkipReason) {
          firstFailedName = file.name;
          firstSkipReason = err instanceof Error ? err.message : 'Lỗi đọc tệp không xác định';
        }
        if (stopParsingRef.current) break;
      }
    }

    if (addedCount === 0 && restoredCount === 0 && skippedCount > 0 && firstSkipReason) {
      pushNotice(
        skippedCount === 1
          ? `${firstFailedName}: ${firstSkipReason}`
          : `Không thêm được ${skippedCount} tệp (${firstFailedName}: ${firstSkipReason})`,
        stopParsingRef.current ? 'info' : 'warning'
      );
    } else {
      const parts: string[] = [];
      if (addedCount > 0) parts.push(`Đã thêm ${addedCount} sách`);
      if (restoredCount > 0) parts.push(`đã có ${restoredCount} sách`);
      if (skippedCount > 0) parts.push(`bỏ qua ${skippedCount} tệp lỗi`);
      if (parts.length > 0) {
        pushNotice(parts.join(' · '), addedCount > 0 ? 'success' : 'info');
      }
    }
  } finally {
    setState({ isParsingFiles: false, parseStatusText: '' });
    await releaseBackgroundKeepAlive();
  }

  return { addedCount, restoredCount, skippedCount };
}

export function resolveEffectiveOutputFormat(
  job: EpubTranslationJob,
  requested?: BookOutputFormat
): 'epub' | 'pdf' {
  const fmt = requested || state.globalSettings.outputFormat || 'original';
  if (fmt === 'original') {
    return job.sourceType === 'pdf' ? 'pdf' : 'epub';
  }
  return fmt;
}

export async function exportBookJobToDevice(
  jobId: string,
  options?: { outputFormat?: BookOutputFormat; silentToast?: boolean }
): Promise<SavedEpubResult | null> {
  if (state.packagingJobId === jobId) return null;
  const targetJob = state.jobs.find((j) => j.jobId === jobId) || (await getEpubJobById(jobId));
  if (!targetJob) return null;

  const exportStartedAt = Date.now();
  const exportStopSignal = { current: false };
  let lastProgressEmitAt = Date.now();
  let lastProgressStage = 'Đang chuẩn bị xuất tệp...';
  let lastProgressPct = 1;

  const updateExportProgress = (prog: BookExportProgress, force = false) => {
    const now = Date.now();
    const clampedPct = Math.max(0, Math.min(100, Math.round(prog.percent)));
    if (
      !force &&
      now - lastProgressEmitAt < 80 &&
      clampedPct === lastProgressPct &&
      prog.stage === lastProgressStage
    ) {
      return;
    }
    lastProgressEmitAt = now;
    lastProgressStage = prog.stage;
    lastProgressPct = clampedPct;
    setState({
      packagingProgress: {
        jobId,
        stage: prog.stage,
        current: prog.current,
        total: prog.total,
        percent: clampedPct,
      },
    });
  };

  setState({
    packagingJobId: jobId,
    packagingProgress: {
      jobId,
      stage: lastProgressStage,
      current: 0,
      total: 100,
      percent: 1,
    },
  });

  await acquireBackgroundKeepAlive();

  // Watchdog & heartbeat định kỳ (không phụ thuộc touch event) giữ UI cập nhật và phát hiện treo
  const packagingWatchdogTimer = setInterval(() => {
    if (state.packagingJobId !== jobId) return;
    const now = Date.now();
    const idleMs = now - lastProgressEmitAt;
    if (idleMs > 120_000) {
      exportStopSignal.current = true;
      return;
    }
    if (idleMs >= 1500) {
      const elapsedSec = Math.max(1, Math.round((now - exportStartedAt) / 1000));
      const cleanBaseStage = lastProgressStage.replace(/\s*\(\d+s\)$/, '');
      setState({
        packagingProgress: {
          jobId,
          stage: `${cleanBaseStage} (${elapsedSec}s)`,
          current: state.packagingProgress?.current ?? 0,
          total: state.packagingProgress?.total ?? 100,
          percent: lastProgressPct,
        },
      });
    }
  }, 1000);

  try {
    const isPdfJob = targetJob.sourceType === 'pdf' && Boolean(targetJob.parsedPdfData);
    const ext = resolveEffectiveOutputFormat(targetJob, options?.outputFormat);
    const pdfRenderMode: PdfExportRenderMode = state.globalSettings.pdfRenderMode || 'digital';
    let blob: Blob;
    let nextTitle: string;

    if (isPdfJob && targetJob.parsedPdfData) {
      const finalPdfPages = targetJob.translatedPdfPages || {};
      if (ext === 'pdf') {
        const exported = await exportTranslatedPdfFile(
          targetJob.parsedPdfData,
          finalPdfPages,
          targetJob.fileName,
          (p) => updateExportProgress(p),
          targetJob.epubBuffer,
          exportStopSignal,
          pdfRenderMode
        );
        blob = exported.blob;
        nextTitle = exported.translatedTitle;
      } else {
        const exported = await reassemblePdfTranslationToEpub(
          targetJob.parsedPdfData,
          finalPdfPages,
          targetJob.fileName,
          (p) => updateExportProgress(p),
          targetJob.epubBuffer
        );
        blob = exported.blob;
        nextTitle = exported.translatedTitle;
      }
    } else if (ext === 'pdf') {
      updateExportProgress({
        stage: 'Đang chuyển nội dung & ảnh EPUB sang PDF...',
        current: 1,
        total: 100,
        percent: 2,
      }, true);
      const converted = await buildPdfExportInputFromTranslatedEpub(
        targetJob.parsedData,
        targetJob.translatedSegments,
        targetJob.epubBuffer
      );
      const exported = await exportTranslatedPdfFile(
        converted.parsedPdf,
        converted.translatedPages,
        targetJob.fileName,
        (p) => updateExportProgress(p),
        undefined,
        exportStopSignal,
        pdfRenderMode
      );
      blob = exported.blob;
      nextTitle = exported.translatedTitle;
    } else {
      const exported = await reassembleAndPackageEpub(
        targetJob.parsedData,
        targetJob.translatedSegments,
        targetJob.epubBuffer,
        (p) => updateExportProgress(p)
      );
      blob = exported.blob;
      nextTitle = exported.translatedTitle;
    }

    const outFileName = buildVietnameseBookFileName(nextTitle, targetJob.fileName, ext);
    const saved = await saveTranslatedEpubToDevice(blob, outFileName, (p) =>
      updateExportProgress(p, true)
    );

    updateExportProgress(
      {
        stage: `Hoàn tất lưu "${saved.fileName}"`,
        current: 100,
        total: 100,
        percent: 100,
      },
      true
    );

    updateJobInMemory(jobId, (j) => ({
      ...j,
      lastSavedLocation: saved.locationLabel,
      lastSavedFileName: saved.fileName,
      lastSavedFileUri: saved.fileUri,
      updatedAt: Date.now(),
    }));
    await updateEpubJobMetadata(jobId, {
      lastSavedLocation: saved.locationLabel,
      lastSavedFileName: saved.fileName,
      lastSavedFileUri: saved.fileUri,
    });

    if (!options?.silentToast) {
      pushNotice(`Đã lưu "${saved.fileName}"`, 'success');
    }
    return saved;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xuất file.';
    pushNotice(msg, 'error');
    return null;
  } finally {
    clearInterval(packagingWatchdogTimer);
    if (state.packagingJobId === jobId) {
      setState({ packagingJobId: null, packagingProgress: null });
    }
    await releaseBackgroundKeepAlive();
  }
}

export async function updateGlobalQueueSettings(
  updates: Partial<BookQueueGlobalSettings>
): Promise<void> {
  const nextSettings: BookQueueGlobalSettings = {
    genre: updates.genre ?? state.globalSettings.genre,
    outputFormat: updates.outputFormat ?? state.globalSettings.outputFormat,
    pdfRenderMode: updates.pdfRenderMode ?? state.globalSettings.pdfRenderMode ?? 'digital',
    customNotes:
      typeof updates.customNotes === 'string'
        ? updates.customNotes
        : state.globalSettings.customNotes,
  };
  saveGlobalSettings(nextSettings);

  const resolvedPdfFmt: PdfOutputFormat =
    nextSettings.outputFormat === 'epub' ? 'epub' : 'pdf';
  const now = Date.now();
  const metadataUpdates: Array<Promise<void>> = [];

  const updatedJobs = state.jobs.map((job) => {
    const isActiveTranslating = state.isRunning && state.activeJobId === job.jobId;
    const isDone = job.status === 'completed' || isJobCompleted(job);
    const patch: Partial<EpubTranslationJob> = {};

    if (job.sourceType === 'pdf' && job.pdfOutputFormat !== resolvedPdfFmt) {
      patch.pdfOutputFormat = resolvedPdfFmt;
    }

    if (!isActiveTranslating && !isDone) {
      if (job.genre !== nextSettings.genre) {
        patch.genre = nextSettings.genre;
      }
      if (job.customNotes !== nextSettings.customNotes) {
        patch.customNotes = nextSettings.customNotes;
      }
    }

    if (Object.keys(patch).length === 0) {
      return job;
    }

    metadataUpdates.push(updateEpubJobMetadata(job.jobId, patch));
    return {
      ...job,
      ...patch,
      updatedAt: now,
    };
  });

  setState({
    globalSettings: nextSettings,
    jobs: updatedJobs,
  });

  if (metadataUpdates.length > 0) {
    await Promise.all(metadataUpdates);
  }
}

export async function resetQueuedJob(jobId: string): Promise<void> {
  if (state.isRunning && state.activeJobId === jobId) return;
  const job = state.jobs.find((j) => j.jobId === jobId);
  if (!job) return;

  const isPdfJob = job.sourceType === 'pdf' && Boolean(job.parsedPdfData);
  let nextParsedPdf = job.parsedPdfData;
  const targetMode: PdfProcessingMode = 'auto';

  if (
    isPdfJob &&
    job.epubBuffer &&
    (job.parsedPdfData?.parserVersion || 1) < DIGITAL_PDF_PARSER_VERSION
  ) {
    stopParsingRef.current = false;
    setState({ isParsingFiles: true, parseStatusText: `Đang tách lại ảnh & trang: ${job.fileName}...` });
    try {
      nextParsedPdf = await parseDigitalPdfFile(
        job.epubBuffer,
        job.fileName,
        (cur, total) => {
          setState({ parseStatusText: `Tách lại PDF: ${cur}/${total} trang` });
        },
        stopParsingRef
      );
    } catch (err) {
      console.warn('[BookQueue] Không tách lại được PDF khi reset:', err);
    } finally {
      setState({ isParsingFiles: false, parseStatusText: '' });
    }
  }

  const rebuiltUnits =
    isPdfJob && nextParsedPdf
      ? buildPdfTranslationUnits(nextParsedPdf, targetMode)
      : job.pdfUnits;

  const resetJob: EpubTranslationJob = {
    ...job,
    ...(nextParsedPdf ? { parsedPdfData: nextParsedPdf } : {}),
    pdfProcessingMode: isPdfJob ? targetMode : job.pdfProcessingMode,
    pdfUnits: rebuiltUnits,
    translatedSegments: {},
    translatedPdfPages: {},
    completedChunkIds: [],
    failedChunkIds: [],
    status: 'idle',
    elapsedMs: 0,
    completedAt: undefined,
    lastSavedLocation: undefined,
    lastSavedFileName: undefined,
    lastSavedFileUri: undefined,
    lastError: undefined,
    updatedAt: Date.now(),
  };

  await saveEpubJob(resetJob);
  updateJobInMemory(jobId, () => resetJob);
  pushNotice(`Đã đặt lại "${resetJob.parsedPdfData?.bookTitle || resetJob.parsedData.bookTitle || resetJob.fileName}"`, 'info');
}

export async function removeQueuedJob(jobId: string): Promise<void> {
  if (state.isRunning && state.activeJobId === jobId) {
    pushNotice('Hãy tạm dừng trước khi xóa sách đang dịch.', 'warning');
    return;
  }
  await deleteEpubJob(jobId);
  setState({
    jobs: state.jobs.filter((j) => j.jobId !== jobId),
  });
}

export async function moveQueuedJob(jobId: string, direction: 'up' | 'down'): Promise<void> {
  const index = state.jobs.findIndex((j) => j.jobId === jobId);
  if (index === -1) return;
  const swapIdx = direction === 'up' ? index - 1 : index + 1;
  if (swapIdx < 0 || swapIdx >= state.jobs.length) return;

  const current = state.jobs[index];
  const other = state.jobs[swapIdx];
  const orderA = current.queueOrder ?? index + 1;
  const orderB = other.queueOrder ?? swapIdx + 1;

  const updated = sortJobsByQueueOrder(
    state.jobs.map((j) => {
      if (j.jobId === current.jobId) return { ...j, queueOrder: orderB };
      if (j.jobId === other.jobId) return { ...j, queueOrder: orderA };
      return j;
    })
  );
  setState({ jobs: updated });

  await Promise.all([
    updateEpubJobMetadata(current.jobId, { queueOrder: orderB }),
    updateEpubJobMetadata(other.jobId, { queueOrder: orderA }),
  ]);
}

export async function clearCompletedFromQueue(): Promise<void> {
  if (state.isRunning) {
    // Chỉ giữ các sách chưa hoàn tất trong hàng chờ
    await clearCompletedEpubJobs();
    setState({
      jobs: state.jobs.filter((j) => j.status !== 'completed'),
    });
    return;
  }
  await clearCompletedEpubJobs();
  setState({
    jobs: state.jobs.filter((j) => j.status !== 'completed'),
  });
  pushNotice('Đã dọn các sách đã dịch xong.', 'info');
}

export function pauseBookQueue(): void {
  if (!state.isRunning) return;
  stopSignal.current = true;
  const activeId = state.activeJobId;
  const currentElapsed = getCurrentActiveElapsedMs();
  if (activeId) {
    updateJobInMemory(activeId, (j) => ({
      ...j,
      elapsedMs: Math.max(j.elapsedMs || 0, currentElapsed),
    }));
    void updateEpubJobMetadata(activeId, {
      elapsedMs: currentElapsed,
    });
  }
  setState({ isStopping: true });
  pushNotice('Đang tạm dừng hàng chờ...', 'info');
}

export async function startOrResumeBookQueue(
  startFromJobId?: string,
  options?: { singleJobOnly?: boolean }
): Promise<void> {
  await initBookQueueManager();
  if (state.isRunning) return;

  let diag = getEpubKeyDiagnostics();
  if (diag.totalKeys === 0) {
    await refreshServerGeminiStatus();
    diag = getEpubKeyDiagnostics();
  }
  if (diag.readyKeys === 0) {
    pushNotice(
      diag.totalKeys === 0
        ? 'Chưa có API Key (Cài đặt ⚙️)'
        : 'API Key đang hết lượt / tạm nghỉ',
      'warning'
    );
    return;
  }

  const orderedJobs = sortJobsByQueueOrder(state.jobs);
  const pendingJobs = orderedJobs.filter((j) => !isJobCompleted(j) && j.status !== 'completed');
  if (pendingJobs.length === 0) {
    pushNotice('Tất cả sách trong hàng chờ đã dịch xong.', 'info');
    return;
  }

  let queueOrderToRun = [...pendingJobs];
  if (startFromJobId) {
    if (options?.singleJobOnly) {
      const targetJob = pendingJobs.find((j) => j.jobId === startFromJobId);
      if (!targetJob) {
        pushNotice('Sách này đã dịch xong.', 'info');
        return;
      }
      queueOrderToRun = [targetJob];
    } else {
      const pickedIdx = queueOrderToRun.findIndex((j) => j.jobId === startFromJobId);
      if (pickedIdx > 0) {
        const [picked] = queueOrderToRun.splice(pickedIdx, 1);
        queueOrderToRun.unshift(picked);
      }
    }
  }

  stopSignal = { current: false };
  setState({
    isRunning: true,
    isStopping: false,
    activeJobId: null,
    activeProgress: null,
    activeSessionStartedAt: null,
    activeBaseElapsedMs: 0,
  });

  await acquireBackgroundKeepAlive();

  heartbeatTimer = setInterval(() => {
    if (!state.isRunning || !state.activeJobId || state.activeSessionStartedAt === null) return;
    const elapsed = getCurrentActiveElapsedMs();
    const id = state.activeJobId;
    updateJobInMemory(id, (j) => ({
      ...j,
      elapsedMs: Math.max(j.elapsedMs || 0, elapsed),
    }));
    void updateEpubJobMetadata(id, { elapsedMs: elapsed });
  }, 5000);

  let completedInSession = 0;
  let stoppedByUser = false;
  let stoppedByError = false;

  try {
    for (const queuedItem of queueOrderToRun) {
      if (stopSignal.current) {
        stoppedByUser = true;
        break;
      }

      // Đọc bản mới nhất từ state phòng khi người dùng chỉnh sửa config trước khi tới lượt
      const currentJob =
        state.jobs.find((j) => j.jobId === queuedItem.jobId) || queuedItem;
      if (!currentJob || currentJob.status === 'completed' || isJobCompleted(currentJob)) {
        continue;
      }

      const baseElapsed = currentJob.elapsedMs || 0;
      const sessionStart = Date.now();
      const getElapsedMs = () =>
        baseElapsed + Math.max(0, Date.now() - sessionStart);

      setState({
        activeJobId: currentJob.jobId,
        activeBaseElapsedMs: baseElapsed,
        activeSessionStartedAt: sessionStart,
        activeProgress: null,
      });

      updateJobInMemory(currentJob.jobId, (j) => ({
        ...j,
        status: 'translating',
        lastError: undefined,
        updatedAt: Date.now(),
      }));

      const isPdf = currentJob.sourceType === 'pdf' && Boolean(currentJob.parsedPdfData);

      if (isPdf && currentJob.parsedPdfData) {
        const res = await runParallelPdfTranslation({
          job: currentJob,
          parsedPdf: currentJob.parsedPdfData,
          processingMode: currentJob.pdfProcessingMode || 'auto',
          genre: state.globalSettings.genre,
          customNotes: state.globalSettings.customNotes,
          stopSignal,
          getElapsedMs,
          onProgress: (prog) => {
            setState({ activeProgress: prog });
          },
          onJobStateSync: (updates) => {
            updateJobInMemory(currentJob.jobId, (j) => ({
              ...j,
              translatedPdfPages: updates.translatedPdfPages,
              completedChunkIds: updates.completedChunkIds,
              failedChunkIds: updates.failedChunkIds,
              elapsedMs: Math.max(j.elapsedMs || 0, getElapsedMs()),
              updatedAt: Date.now(),
            }));
          },
        });

        const finalElapsed = getElapsedMs();
        const nextStatus: EpubTranslationJob['status'] = res.completed
          ? 'completed'
          : res.stopped
          ? 'paused'
          : 'error';

        updateJobInMemory(currentJob.jobId, (j) => ({
          ...j,
          translatedPdfPages: res.translatedPdfPages,
          completedChunkIds: res.completedChunkIds,
          failedChunkIds: res.failedChunkIds,
          status: nextStatus,
          elapsedMs: finalElapsed,
          ...(res.completed ? { completedAt: Date.now() } : {}),
          lastError: res.errorMessage,
          updatedAt: Date.now(),
        }));

        if (res.completed) {
          completedInSession += 1;
          const title = currentJob.parsedPdfData.bookTitle || currentJob.fileName;
          const saved = await exportBookJobToDevice(currentJob.jobId, { silentToast: true });
          if (saved) {
            pushNotice(
              res.warningMessage
                ? `Xong "${title}" (${formatElapsedTime(finalElapsed)}) · ${res.warningMessage}`
                : `Xong "${title}" (${formatElapsedTime(finalElapsed)}) · Đã lưu`,
              res.warningMessage ? 'info' : 'success'
            );
          }
          await sendBackgroundNotification(
            'Đã dịch xong sách',
            `${title} (${formatElapsedTime(finalElapsed)})`
          );
        } else if (res.stopped) {
          stoppedByUser = true;
          pushNotice(`Đã tạm dừng hàng chờ`, 'info');
          break;
        } else {
          stoppedByError = true;
          pushNotice(res.errorMessage || 'Dừng hàng chờ do lỗi API/mạng.', 'warning');
          break;
        }
      } else {
        const res = await runParallelEpubTranslation({
          job: currentJob,
          genre: state.globalSettings.genre,
          customNotes: state.globalSettings.customNotes,
          stopSignal,
          getElapsedMs,
          onProgress: (prog) => {
            setState({ activeProgress: prog });
          },
          onJobStateSync: (updates) => {
            updateJobInMemory(currentJob.jobId, (j) => ({
              ...j,
              translatedSegments: updates.translatedSegments,
              completedChunkIds: updates.completedChunkIds,
              failedChunkIds: updates.failedChunkIds,
              elapsedMs: Math.max(j.elapsedMs || 0, getElapsedMs()),
              updatedAt: Date.now(),
            }));
          },
        });

        const finalElapsed = getElapsedMs();
        const nextStatus: EpubTranslationJob['status'] = res.completed
          ? 'completed'
          : res.stopped
          ? 'paused'
          : 'error';

        updateJobInMemory(currentJob.jobId, (j) => ({
          ...j,
          translatedSegments: res.translatedSegments,
          completedChunkIds: res.completedChunkIds,
          failedChunkIds: res.failedChunkIds,
          status: nextStatus,
          elapsedMs: finalElapsed,
          ...(res.completed ? { completedAt: Date.now() } : {}),
          lastError: res.errorMessage,
          updatedAt: Date.now(),
        }));

        if (res.completed) {
          completedInSession += 1;
          const title = currentJob.parsedData?.bookTitle || currentJob.fileName;
          const saved = await exportBookJobToDevice(currentJob.jobId, { silentToast: true });
          if (saved) {
            pushNotice(
              res.warningMessage
                ? `Xong "${title}" (${formatElapsedTime(finalElapsed)}) · ${res.warningMessage}`
                : `Xong "${title}" (${formatElapsedTime(finalElapsed)}) · Đã lưu`,
              res.warningMessage ? 'info' : 'success'
            );
          }
          await sendBackgroundNotification(
            'Đã dịch xong sách',
            `${title} (${formatElapsedTime(finalElapsed)})`
          );
        } else if (res.stopped) {
          stoppedByUser = true;
          pushNotice(`Đã tạm dừng hàng chờ`, 'info');
          break;
        } else {
          stoppedByError = true;
          pushNotice(res.errorMessage || 'Dừng hàng chờ do lỗi API/mạng.', 'warning');
          break;
        }
      }
    }

    if (!stoppedByUser && !stoppedByError && completedInSession > 0) {
      pushNotice(`Hoàn tất ${completedInSession} cuốn sách`, 'success');
      await sendBackgroundNotification(
        'Hoàn tất hàng chờ dịch sách',
        `Đã dịch xong ${completedInSession} cuốn và lưu vào Download.`
      );
    }
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    await releaseBackgroundKeepAlive();
    setState({
      isRunning: false,
      isStopping: false,
      activeJobId: null,
      activeProgress: null,
      activeSessionStartedAt: null,
      activeBaseElapsedMs: 0,
    });
  }
}
