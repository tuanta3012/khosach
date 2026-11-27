import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import {
  EpubGenreId,
  EpubTranslationJob,
  EpubTranslationProgress,
  ParsedEpubData,
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
import { parseEpubFile, reassembleAndPackageEpub } from './epubService';
import { runParallelEpubTranslation } from './epubTranslatorService';
import {
  buildPdfTranslationUnits,
  exportTranslatedPdfFile,
  parseDigitalPdfFile,
  reassemblePdfTranslationToEpub,
} from './pdfDigitalService';
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

export interface QueueNotice {
  id: number;
  text: string;
  type: 'success' | 'info' | 'warning' | 'error';
}

export interface BookQueueSnapshot {
  initialized: boolean;
  isLoading: boolean;
  jobs: EpubTranslationJob[];
  isRunning: boolean;
  isStopping: boolean;
  activeJobId: string | null;
  activeProgress: EpubTranslationProgress | null;
  activeSessionStartedAt: number | null;
  activeBaseElapsedMs: number;
  isParsingFiles: boolean;
  parseStatusText: string;
  packagingJobId: string | null;
  lastNotice: QueueNotice | null;
}

const listeners = new Set<() => void>();
let noticeSeq = 0;

let state: BookQueueSnapshot = {
  initialized: false,
  isLoading: true,
  jobs: [],
  isRunning: false,
  isStopping: false,
  activeJobId: null,
  activeProgress: null,
  activeSessionStartedAt: null,
  activeBaseElapsedMs: 0,
  isParsingFiles: false,
  parseStatusText: '',
  packagingJobId: null,
  lastNotice: null,
};

let initPromise: Promise<void> | null = null;
let stopSignal: { current: boolean } = { current: false };
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let wakeLockSentinel: WakeLockSentinel | null = null;
let keepAliveAudioCtx: AudioContext | null = null;
let keepAliveOscillator: OscillatorNode | null = null;
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

async function acquireBackgroundKeepAlive(): Promise<void> {
  // 1. Screen/CPU WakeLock (trình duyệt & Android WebView)
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> } }) : null;
    if (nav?.wakeLock && !wakeLockSentinel) {
      wakeLockSentinel = await nav.wakeLock.request('screen');
      wakeLockSentinel.addEventListener?.('release', () => {
        wakeLockSentinel = null;
      });
    }
  } catch {}

  // 2. Audio im lặng giữ WebView không bị hệ điều hành bóp CPU timer khi chạy ngầm
  try {
    if (typeof window !== 'undefined' && !keepAliveAudioCtx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.00001; // Gần như im lặng hoàn toàn
        osc.frequency.value = 30;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => {});
        }
        keepAliveAudioCtx = ctx;
        keepAliveOscillator = osc;
      }
    }
  } catch {}
}

async function releaseBackgroundKeepAlive(): Promise<void> {
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch {}
    wakeLockSentinel = null;
  }
  if (keepAliveOscillator) {
    try {
      keepAliveOscillator.stop();
      keepAliveOscillator.disconnect();
    } catch {}
    keepAliveOscillator = null;
  }
  if (keepAliveAudioCtx) {
    try {
      await keepAliveAudioCtx.close();
    } catch {}
    keepAliveAudioCtx = null;
  }
}

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

  // Tự động xin lại WakeLock nếu người dùng mở lại app trong khi hàng chờ vẫn đang dịch ngầm
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.isRunning) {
        void acquireBackgroundKeepAlive();
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
          const mode: PdfProcessingMode = 'hybrid-digital';
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
  defaultGenre: EpubGenreId = 'van-hoc',
  defaultNotes = ''
): Promise<{ addedCount: number; restoredCount: number; skippedCount: number }> {
  await initBookQueueManager();
  if (!files || files.length === 0) {
    return { addedCount: 0, restoredCount: 0, skippedCount: 0 };
  }

  stopParsingRef.current = false;
  setState({ isParsingFiles: true, parseStatusText: `Đang kiểm tra ${files.length} tệp...` });

  let addedCount = 0;
  let restoredCount = 0;
  let skippedCount = 0;
  let workingJobs = [...state.jobs];

  try {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const lowerName = file.name.toLowerCase();
      const isEpub = lowerName.endsWith('.epub');
      const isPdf = lowerName.endsWith('.pdf');

      if (!isEpub && !isPdf) {
        skippedCount += 1;
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
          if (existingDb && existingDb.parsedPdfData) {
            const restored: EpubTranslationJob = {
              ...existingDb,
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

          const initialMode: PdfProcessingMode = 'hybrid-digital';
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
          const newJob: EpubTranslationJob = {
            jobId,
            sourceType: 'pdf',
            fileName: file.name,
            fileSize: file.size,
            lastModified: file.lastModified,
            genre: defaultGenre,
            customNotes: defaultNotes,
            epubBuffer: buffer,
            parsedData: placeholderParsedData,
            translatedSegments: {},
            pdfOutputFormat: 'epub',
            pdfProcessingMode: initialMode,
            parsedPdfData: parsedPdf,
            pdfUnits: initialUnits,
            translatedPdfPages: {},
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
        } else {
          const jobId = buildEpubJobId(file.name, file.size, file.lastModified);
          const alreadyInQueue = workingJobs.find((j) => j.jobId === jobId);
          if (alreadyInQueue) {
            restoredCount += 1;
            continue;
          }

          const existingDb = await getEpubJobById(jobId);
          if (existingDb) {
            const restored: EpubTranslationJob = {
              ...existingDb,
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
            continue;
          }

          const now = Date.now();
          const newJob: EpubTranslationJob = {
            jobId,
            sourceType: 'epub',
            fileName: file.name,
            fileSize: file.size,
            lastModified: file.lastModified,
            genre: defaultGenre,
            customNotes: defaultNotes,
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
      }
    }

    const parts: string[] = [];
    if (addedCount > 0) parts.push(`Đã thêm ${addedCount} sách`);
    if (restoredCount > 0) parts.push(`đã có ${restoredCount} sách`);
    if (skippedCount > 0) parts.push(`bỏ qua ${skippedCount} tệp lỗi`);
    if (parts.length > 0) {
      pushNotice(parts.join(' · '), addedCount > 0 ? 'success' : 'info');
    }
  } finally {
    setState({ isParsingFiles: false, parseStatusText: '' });
  }

  return { addedCount, restoredCount, skippedCount };
}

export async function exportBookJobToDevice(
  jobId: string,
  options?: { outputFormat?: PdfOutputFormat; silentToast?: boolean }
): Promise<SavedEpubResult | null> {
  const targetJob = state.jobs.find((j) => j.jobId === jobId) || (await getEpubJobById(jobId));
  if (!targetJob) return null;

  setState({ packagingJobId: jobId });
  try {
    const isPdfJob = targetJob.sourceType === 'pdf' && Boolean(targetJob.parsedPdfData);
    let blob: Blob;
    let nextTitle: string;
    let ext: 'epub' | 'pdf' = 'epub';

    if (isPdfJob && targetJob.parsedPdfData) {
      const outFmt = options?.outputFormat || targetJob.pdfOutputFormat || 'epub';
      ext = outFmt;
      const finalPdfPages = targetJob.translatedPdfPages || {};
      if (outFmt === 'pdf') {
        const exported = await exportTranslatedPdfFile(
          targetJob.parsedPdfData,
          finalPdfPages,
          targetJob.fileName
        );
        blob = exported.blob;
        nextTitle = exported.translatedTitle;
      } else {
        const exported = await reassemblePdfTranslationToEpub(
          targetJob.parsedPdfData,
          finalPdfPages,
          targetJob.fileName
        );
        blob = exported.blob;
        nextTitle = exported.translatedTitle;
      }
    } else {
      const exported = await reassembleAndPackageEpub(
        targetJob.parsedData,
        targetJob.translatedSegments,
        targetJob.epubBuffer
      );
      blob = exported.blob;
      nextTitle = exported.translatedTitle;
    }

    const outFileName = buildVietnameseBookFileName(nextTitle, targetJob.fileName, ext);
    const saved = await saveTranslatedEpubToDevice(blob, outFileName);

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
    if (state.packagingJobId === jobId) {
      setState({ packagingJobId: null });
    }
  }
}

export async function updateQueuedJobConfig(
  jobId: string,
  updates: Partial<{
    genre: EpubGenreId;
    customNotes: string;
    pdfOutputFormat: PdfOutputFormat;
    pdfProcessingMode: PdfProcessingMode;
  }>
): Promise<void> {
  if (state.isRunning && state.activeJobId === jobId) return;
  const target = state.jobs.find((j) => j.jobId === jobId);
  if (!target) return;

  let rebuiltUnits = target.pdfUnits;
  const nextUpdates: Partial<EpubTranslationJob> = { ...updates };

  if (
    updates.pdfProcessingMode &&
    target.sourceType === 'pdf' &&
    target.parsedPdfData &&
    target.completedChunkIds.length === 0
  ) {
    rebuiltUnits = buildPdfTranslationUnits(target.parsedPdfData, updates.pdfProcessingMode);
    nextUpdates.pdfUnits = rebuiltUnits;
  }

  updateJobInMemory(jobId, (j) => ({
    ...j,
    ...nextUpdates,
    updatedAt: Date.now(),
  }));

  await updateEpubJobMetadata(jobId, {
    ...(updates.genre ? { genre: updates.genre } : {}),
    ...(typeof updates.customNotes === 'string' ? { customNotes: updates.customNotes } : {}),
    ...(updates.pdfOutputFormat ? { pdfOutputFormat: updates.pdfOutputFormat } : {}),
    ...(updates.pdfProcessingMode && rebuiltUnits
      ? { pdfProcessingMode: updates.pdfProcessingMode, pdfUnits: rebuiltUnits }
      : {}),
  });
}

export async function resetQueuedJob(jobId: string): Promise<void> {
  if (state.isRunning && state.activeJobId === jobId) return;
  const job = state.jobs.find((j) => j.jobId === jobId);
  if (!job) return;

  const isPdfJob = job.sourceType === 'pdf' && Boolean(job.parsedPdfData);
  const rebuiltUnits =
    isPdfJob && job.parsedPdfData
      ? buildPdfTranslationUnits(job.parsedPdfData, job.pdfProcessingMode || 'hybrid-digital')
      : job.pdfUnits;

  const resetJob: EpubTranslationJob = {
    ...job,
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
  pushNotice(`Đã đặt lại "${job.parsedPdfData?.bookTitle || job.parsedData.bookTitle || job.fileName}"`, 'info');
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
          processingMode: currentJob.pdfProcessingMode || 'hybrid-digital',
          genre: currentJob.genre,
          customNotes: currentJob.customNotes,
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
            pushNotice(`Xong "${title}" (${formatElapsedTime(finalElapsed)}) · Đã lưu`, 'success');
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
          genre: currentJob.genre,
          customNotes: currentJob.customNotes,
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
            pushNotice(`Xong "${title}" (${formatElapsedTime(finalElapsed)}) · Đã lưu`, 'success');
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
