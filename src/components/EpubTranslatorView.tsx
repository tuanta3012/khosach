import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  ExternalLink,
  FolderCheck,
  Languages,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  EpubGenreId,
  EpubTranslationJob,
  PdfOutputFormat,
  PdfProcessingMode,
} from '../types';
import {
  EPUB_BACKUP_MODEL,
  EPUB_TRANSLATION_MODEL,
  getEpubKeyDiagnostics,
  refreshServerGeminiStatus,
} from '../services/geminiService';
import { appendVnSuffix } from '../services/epubService';
import { EPUB_GENRES } from '../services/epubTranslatorService';
import {
  addFilesToQueue,
  clearCompletedFromQueue,
  exportBookJobToDevice,
  formatElapsedTime,
  getBookQueueSnapshot,
  getJobElapsedMs,
  initBookQueueManager,
  isJobCompleted,
  moveQueuedJob,
  pauseBookQueue,
  removeQueuedJob,
  resetQueuedJob,
  startOrResumeBookQueue,
  subscribeBookQueue,
  updateQueuedJobConfig,
} from '../services/bookTranslationQueueManager';
import {
  openSavedEpubFile,
  shareSavedEpubFile,
} from '../utils/epubFileSaver';
import { useToast } from '../context/ToastContext';

function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getJobStats(job: EpubTranslationJob) {
  const isPdf = job.sourceType === 'pdf' && Boolean(job.parsedPdfData);
  const totalChunks = isPdf
    ? job.pdfUnits?.length || 0
    : job.parsedData?.chunks?.length || 0;
  const completedChunks = job.completedChunkIds?.length || 0;
  const failedChunks = job.failedChunkIds?.length || 0;
  const totalUnitsCount = isPdf
    ? job.parsedPdfData?.totalPages || 0
    : job.parsedData?.segments?.length || 0;

  let completedUnitsCount = 0;
  if (isPdf) {
    completedUnitsCount = Math.min(
      totalUnitsCount,
      Object.keys(job.translatedPdfPages || {}).length
    );
  } else {
    for (const idx of job.completedChunkIds || []) {
      const ch = job.parsedData?.chunks?.[idx];
      if (ch) completedUnitsCount += ch.segmentIds.length;
    }
  }

  return {
    isPdf,
    totalChunks,
    completedChunks,
    failedChunks,
    totalUnitsCount,
    completedUnitsCount,
  };
}

export const EpubTranslatorView: React.FC = () => {
  const { showToast } = useToast();
  const queue = useSyncExternalStore(
    subscribeBookQueue,
    getBookQueueSnapshot,
    getBookQueueSnapshot
  );

  const [defaultGenre, setDefaultGenre] = useState<EpubGenreId>('van-hoc');
  const [expandedConfigIds, setExpandedConfigIds] = useState<Record<string, boolean>>({});
  const [tickNow, setTickNow] = useState<number>(() => Date.now());
  const [keyDiag, setKeyDiag] = useState(() => getEpubKeyDiagnostics());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastSeenNoticeIdRef = useRef<number>(0);

  const refreshKeyDiagnostics = useCallback(() => {
    setKeyDiag(getEpubKeyDiagnostics());
  }, []);

  useEffect(() => {
    void initBookQueueManager();
    void refreshServerGeminiStatus().then(() => {
      refreshKeyDiagnostics();
    });

    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshKeyDiagnostics();
      }
    };
    window.addEventListener('focus', refreshKeyDiagnostics);
    window.addEventListener('gemini-keys-updated', refreshKeyDiagnostics);
    window.addEventListener('storage', refreshKeyDiagnostics);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    return () => {
      window.removeEventListener('focus', refreshKeyDiagnostics);
      window.removeEventListener('gemini-keys-updated', refreshKeyDiagnostics);
      window.removeEventListener('storage', refreshKeyDiagnostics);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    };
  }, [refreshKeyDiagnostics]);

  // Chuyển các thông báo mới từ Queue Singleton ra Toast UI
  useEffect(() => {
    const notice = queue.lastNotice;
    if (notice && notice.id > lastSeenNoticeIdRef.current) {
      lastSeenNoticeIdRef.current = notice.id;
      showToast(notice.text, notice.type);
      refreshKeyDiagnostics();
    }
  }, [queue.lastNotice, showToast, refreshKeyDiagnostics]);

  // Bộ đếm nhịp 1 giây cập nhật đồng hồ khi có sách đang dịch
  useEffect(() => {
    if (!queue.isRunning) return;
    setTickNow(Date.now());
    const timer = setInterval(() => {
      setTickNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [queue.isRunning, queue.activeJobId]);

  const handleSelectFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (picked.length === 0) return;

    await addFilesToQueue(picked, defaultGenre, '');
  };

  const toggleConfig = (jobId: string) => {
    setExpandedConfigIds((prev) => ({
      ...prev,
      [jobId]: !prev[jobId],
    }));
  };

  const completedCount = useMemo(
    () => queue.jobs.filter((j) => j.status === 'completed' || isJobCompleted(j)).length,
    [queue.jobs]
  );
  const pendingCount = queue.jobs.length - completedCount;
  const hasPausedOrStartedPending = useMemo(
    () =>
      queue.jobs.some(
        (j) =>
          !(j.status === 'completed' || isJobCompleted(j)) &&
          (j.status === 'paused' || j.completedChunkIds.length > 0)
      ),
    [queue.jobs]
  );

  return (
    <div className="space-y-4 pb-8">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".epub,.pdf,application/epub+zip,application/pdf"
        onChange={handleSelectFiles}
        className="hidden"
      />

      {/* Header + Chọn nhiều sách */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-sky-50 border border-sky-200 text-[#0284C7] flex items-center justify-center shrink-0">
              <Languages className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-extrabold text-slate-900 tracking-tight">
                Dịch Sách EPUB / PDF
              </h2>
              <div className="flex items-center gap-1.5 mt-1 text-xs font-medium text-slate-600 tabular-nums">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    keyDiag.readyKeys > 0
                      ? 'bg-[#10B981]'
                      : keyDiag.totalKeys > 0
                      ? 'bg-amber-500'
                      : 'bg-rose-500'
                  }`}
                />
                <span className="truncate">
                  {keyDiag.totalKeys === 0
                    ? `Chưa có API Key (Cài đặt ⚙️)`
                    : `${keyDiag.readyKeys}/${keyDiag.totalKeys} Key · ${EPUB_TRANSLATION_MODEL} / ${EPUB_BACKUP_MODEL}`}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={queue.isParsingFiles}
              onClick={() => fileInputRef.current?.click()}
              className="min-h-[44px] w-full sm:w-auto px-4 py-2 rounded-xl bg-[#0284C7] hover:bg-sky-700 disabled:opacity-50 text-white text-xs sm:text-sm font-bold inline-flex items-center justify-center gap-1.5 shadow-xs transition active:scale-95 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span>{queue.jobs.length > 0 ? 'Thêm sách' : 'Chọn EPUB / PDF'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Trạng thái đang đọc tệp vừa chọn */}
      {queue.isParsingFiles && (
        <div className="bg-sky-50 border border-sky-200 rounded-2xl px-4 py-3 text-xs sm:text-sm font-bold text-[#0284C7]">
          {queue.parseStatusText || 'Đang xử lý tệp...'}
        </div>
      )}

      {/* Trạng thái rỗng / Đang nạp */}
      {queue.isLoading ? (
        <div className="bg-white rounded-2xl border border-slate-200/80 p-8 text-center text-sm text-slate-500">
          Đang tải...
        </div>
      ) : queue.jobs.length === 0 ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={queue.isParsingFiles}
          className="w-full bg-white hover:bg-sky-50/40 rounded-2xl border-2 border-dashed border-slate-300 hover:border-[#0284C7] p-8 sm:p-10 text-center transition group"
        >
          <div className="w-14 h-14 mx-auto rounded-2xl bg-sky-50 border border-sky-200 text-[#0284C7] flex items-center justify-center group-hover:scale-105 transition">
            <BookOpen className="w-7 h-7" />
          </div>
          <p className="mt-3 text-sm sm:text-base font-bold text-slate-800">
            {queue.isParsingFiles
              ? queue.parseStatusText || 'Đang xử lý tệp...'
              : 'Chọn 1 hoặc nhiều sách .EPUB / .PDF Digital'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Dịch tuần tự theo hàng chờ · Tạm dừng/tiếp tục · Lưu vào Download
          </p>
        </button>
      ) : (
        <>
          {/* Thanh điều khiển hàng chờ */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2 text-xs sm:text-sm font-bold text-slate-800 tabular-nums">
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  queue.isRunning
                    ? 'bg-[#0284C7] animate-pulse'
                    : pendingCount === 0
                    ? 'bg-[#10B981]'
                    : 'bg-amber-500'
                }`}
              />
              <span>
                Hàng chờ: {completedCount}/{queue.jobs.length} xong
                {queue.isRunning ? ' · Đang dịch ngầm ổn định' : ''}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {pendingCount > 0 && !queue.isRunning && (
                <button
                  type="button"
                  onClick={() => void startOrResumeBookQueue()}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-[#10B981] hover:bg-emerald-600 text-white text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 shadow-xs transition active:scale-95"
                >
                  {hasPausedOrStartedPending ? (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      <span>Tiếp tục hàng chờ</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>Dịch tuần tự ({pendingCount})</span>
                    </>
                  )}
                </button>
              )}

              {queue.isRunning && (
                <button
                  type="button"
                  disabled={queue.isStopping}
                  onClick={pauseBookQueue}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-slate-950 text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 shadow-xs transition active:scale-95"
                >
                  <Pause className="w-4 h-4 fill-current" />
                  <span>{queue.isStopping ? 'Đang dừng...' : 'Tạm dừng'}</span>
                </button>
              )}

              {completedCount > 0 && (
                <button
                  type="button"
                  onClick={() => void clearCompletedFromQueue()}
                  className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-bold inline-flex items-center gap-1.5 transition active:scale-95"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Xóa đã xong</span>
                </button>
              )}
            </div>
          </div>

          {/* Danh sách từng cuốn trong hàng chờ */}
          <div className="space-y-3">
            {queue.jobs.map((job, idx) => {
              const isActive = queue.isRunning && queue.activeJobId === job.jobId;
              const stats = getJobStats(job);
              const done = job.status === 'completed' || isJobCompleted(job);
              const isPackaging = queue.packagingJobId === job.jobId;
              const activeProg = isActive ? queue.activeProgress : null;

              const doneChunks =
                activeProg && activeProg.totalChunks > 0
                  ? activeProg.completedChunks
                  : stats.completedChunks;
              const allChunks =
                activeProg && activeProg.totalChunks > 0
                  ? activeProg.totalChunks
                  : stats.totalChunks;

              const percent =
                allChunks <= 0
                  ? 0
                  : done || doneChunks >= allChunks
                  ? 100
                  : Math.min(99, Math.round((doneChunks / allChunks) * 100));

              const elapsedMs = getJobElapsedMs(job, tickNow);
              const elapsedLabel = formatElapsedTime(elapsedMs);

              const rawTitle =
                job.parsedPdfData?.bookTitle ||
                job.parsedData?.bookTitle ||
                job.fileName.replace(/\.(epub|pdf)$/i, '');
              const displayTitle = done ? appendVnSuffix(rawTitle) : rawTitle;
              const configOpen =
                expandedConfigIds[job.jobId] ??
                (queue.jobs.length === 1 && !done);

              const lockedConfig = isActive;
              const outFmt: PdfOutputFormat = job.pdfOutputFormat || 'epub';
              const procMode: PdfProcessingMode = job.pdfProcessingMode || 'hybrid-digital';

              return (
                <div
                  key={job.jobId}
                  className={`bg-white rounded-2xl border shadow-xs p-4 space-y-3 transition ${
                    isActive
                      ? 'border-[#0284C7] ring-2 ring-sky-100'
                      : done
                      ? 'border-emerald-200 bg-emerald-50/20'
                      : 'border-slate-200/80'
                  }`}
                >
                  {/* Hàng 1: STT + Tên sách + Badge trạng thái + Đồng hồ + Xóa/Di chuyển */}
                  <div className="flex items-start justify-between gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 mb-1">
                        <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[11px] font-extrabold tabular-nums">
                          #{idx + 1}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-md text-[11px] font-bold ${
                            isActive
                              ? 'bg-sky-100 text-[#0284C7]'
                              : done
                              ? 'bg-emerald-100 text-emerald-700'
                              : job.status === 'paused'
                              ? 'bg-amber-100 text-amber-800'
                              : job.status === 'error'
                              ? 'bg-rose-100 text-rose-700'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {isActive
                            ? 'Đang dịch'
                            : done
                            ? 'Xong'
                            : job.status === 'paused'
                            ? 'Tạm dừng'
                            : job.status === 'error'
                            ? 'Lỗi'
                            : 'Chờ dịch'}
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[11px] font-bold tabular-nums">
                          <Clock className="w-3 h-3 text-slate-500" />
                          {elapsedLabel}
                        </span>
                      </div>

                      <h3 className="text-sm sm:text-base font-extrabold text-slate-900 truncate">
                        {displayTitle}
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5 tabular-nums truncate">
                        {stats.isPdf && job.parsedPdfData
                          ? `PDF · ${job.parsedPdfData.totalPages} trang · ${formatFileSize(job.fileSize)}`
                          : `EPUB · ${allChunks} phần · ${formatFileSize(job.fileSize)}`}
                      </p>
                    </div>

                    {!isActive && (
                      <div className="flex items-center gap-1 shrink-0">
                        {!done && queue.jobs.length > 1 && (
                          <>
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => void moveQueuedJob(job.jobId, 'up')}
                              title="Lên"
                              className="min-w-[38px] min-h-[38px] p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 flex items-center justify-center"
                            >
                              <ArrowUp className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === queue.jobs.length - 1}
                              onClick={() => void moveQueuedJob(job.jobId, 'down')}
                              title="Xuống"
                              className="min-w-[38px] min-h-[38px] p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 flex items-center justify-center"
                            >
                              <ArrowDown className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => void removeQueuedJob(job.jobId)}
                          title="Xóa"
                          className="min-w-[38px] min-h-[38px] p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Hàng 2: Thanh tiến độ */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs tabular-nums">
                      <span className="text-slate-600 font-medium truncate pr-2">
                        {isActive && activeProg?.statusMessage
                          ? activeProg.statusMessage
                          : done
                          ? `Hoàn tất ${allChunks}/${allChunks} phần`
                          : stats.completedChunks > 0
                          ? `Đã lưu ${stats.completedChunks}/${allChunks} phần (${stats.completedUnitsCount}/${stats.totalUnitsCount} ${
                              stats.isPdf ? 'trang' : 'đoạn'
                            })`
                          : `Chưa dịch (${allChunks} phần)`}
                      </span>
                      <span className="font-black text-[#0284C7] shrink-0">
                        {percent}%
                      </span>
                    </div>

                    <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden border border-slate-200/60">
                      <div
                        className={`h-full transition-all duration-300 rounded-full ${
                          done
                            ? 'bg-[#10B981]'
                            : job.status === 'error'
                            ? 'bg-rose-500'
                            : isActive
                            ? 'bg-[#0284C7]'
                            : 'bg-amber-500'
                        }`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>

                  {job.lastError && !isActive && !done && (
                    <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 font-medium">
                      {job.lastError}
                    </div>
                  )}

                  {/* Hàng 3: Tùy chọn cấu hình thu gọn / mở rộng */}
                  {!done && (
                    <div className="pt-1 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => toggleConfig(job.jobId)}
                        className="w-full py-1.5 flex items-center justify-between text-xs font-bold text-slate-600 hover:text-slate-900"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <SlidersHorizontal className="w-3.5 h-3.5" />
                          <span>
                            {EPUB_GENRES.find((g) => g.id === job.genre)?.label || 'Thể loại'}
                            {stats.isPdf ? ` · Xuất ${outFmt.toUpperCase()}` : ''}
                          </span>
                        </span>
                        {configOpen ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </button>

                      {configOpen && (
                        <div className="mt-2.5 space-y-3 pt-2 border-t border-slate-100">
                          {stats.isPdf && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                              <div>
                                <span className="block text-[11px] font-bold text-slate-700 mb-1">
                                  Đầu ra
                                </span>
                                <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl">
                                  {(['epub', 'pdf'] as PdfOutputFormat[]).map((fmt) => (
                                    <button
                                      key={fmt}
                                      type="button"
                                      disabled={lockedConfig || isPackaging}
                                      onClick={() =>
                                        void updateQueuedJobConfig(job.jobId, {
                                          pdfOutputFormat: fmt,
                                        })
                                      }
                                      className={`min-h-[38px] rounded-lg text-xs font-bold uppercase transition ${
                                        outFmt === fmt
                                          ? 'bg-white text-[#0284C7] shadow-xs'
                                          : 'text-slate-600'
                                      } disabled:opacity-60`}
                                    >
                                      {fmt}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              <div>
                                <span className="block text-[11px] font-bold text-slate-700 mb-1">
                                  Xử lý
                                </span>
                                <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl">
                                  {(
                                    [
                                      { id: 'hybrid-digital', label: 'Tối ưu Digital' },
                                      { id: 'full-vision', label: 'Vision toàn trang' },
                                    ] as const
                                  ).map((opt) => (
                                    <button
                                      key={opt.id}
                                      type="button"
                                      disabled={lockedConfig || stats.completedChunks > 0}
                                      onClick={() =>
                                        void updateQueuedJobConfig(job.jobId, {
                                          pdfProcessingMode: opt.id,
                                        })
                                      }
                                      className={`min-h-[38px] px-2 rounded-lg text-xs font-bold truncate transition ${
                                        procMode === opt.id
                                          ? 'bg-white text-[#0284C7] shadow-xs'
                                          : 'text-slate-600'
                                      } disabled:opacity-60`}
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                            <div>
                              <span className="block text-[11px] font-bold text-slate-700 mb-1">
                                Thể loại
                              </span>
                              <select
                                value={job.genre}
                                disabled={lockedConfig}
                                onChange={(e) => {
                                  const val = e.target.value as EpubGenreId;
                                  setDefaultGenre(val);
                                  void updateQueuedJobConfig(job.jobId, { genre: val });
                                }}
                                className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm font-semibold text-slate-800 disabled:bg-slate-50"
                              >
                                {EPUB_GENRES.map((g) => (
                                  <option key={g.id} value={g.id}>
                                    {g.label}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div>
                              <span className="block text-[11px] font-bold text-slate-700 mb-1">
                                Ghi chú dịch
                              </span>
                              <input
                                type="text"
                                disabled={lockedConfig}
                                value={job.customNotes}
                                onChange={(e) =>
                                  void updateQueuedJobConfig(job.jobId, {
                                    customNotes: e.target.value,
                                  })
                                }
                                placeholder="Xưng hô, tên riêng, thuật ngữ..."
                                className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm text-slate-800 placeholder:text-slate-400 disabled:bg-slate-50"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Hàng 4: Nút thao tác theo từng cuốn */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {!done && !queue.isRunning && (
                      <button
                        type="button"
                        onClick={() => void startOrResumeBookQueue(job.jobId)}
                        className="min-h-[42px] px-4 py-2 rounded-xl bg-[#10B981] hover:bg-emerald-600 text-white text-xs font-bold inline-flex items-center gap-1.5 shadow-xs transition active:scale-95"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>
                          {stats.completedChunks > 0 ? 'Tiếp tục cuốn này' : 'Dịch từ cuốn này'}
                        </span>
                      </button>
                    )}

                    {!done && stats.completedChunks > 0 && !isActive && (
                      <button
                        type="button"
                        onClick={() => void resetQueuedJob(job.jobId)}
                        className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-bold inline-flex items-center gap-1.5 transition active:scale-95"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Dịch lại</span>
                      </button>
                    )}

                    {done && (
                      <>
                        {job.lastSavedLocation && (
                          <p className="w-full text-xs text-emerald-800 flex items-center gap-1.5 break-all">
                            <CheckCircle2 className="w-3.5 h-3.5 text-[#10B981] shrink-0" />
                            <FolderCheck className="w-3.5 h-3.5 shrink-0" />
                            <span>{job.lastSavedLocation}</span>
                          </p>
                        )}

                        {stats.isPdf && (
                          <div className="inline-flex p-0.5 bg-slate-100 rounded-xl">
                            {(['epub', 'pdf'] as PdfOutputFormat[]).map((fmt) => (
                              <button
                                key={fmt}
                                type="button"
                                disabled={isPackaging}
                                onClick={() =>
                                  void updateQueuedJobConfig(job.jobId, {
                                    pdfOutputFormat: fmt,
                                  })
                                }
                                className={`min-h-[38px] px-3 rounded-lg text-xs font-bold uppercase ${
                                  outFmt === fmt
                                    ? 'bg-white text-[#0284C7] shadow-xs'
                                    : 'text-slate-600'
                                }`}
                              >
                                {fmt}
                              </button>
                            ))}
                          </div>
                        )}

                        <button
                          type="button"
                          disabled={isPackaging}
                          onClick={() =>
                            void exportBookJobToDevice(job.jobId, {
                              outputFormat: outFmt,
                            })
                          }
                          className="min-h-[42px] px-4 py-2 rounded-xl bg-[#0284C7] hover:bg-sky-700 disabled:opacity-60 text-white text-xs font-bold inline-flex items-center gap-1.5 shadow-xs transition active:scale-95"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>
                            {isPackaging
                              ? 'Đang xuất...'
                              : job.lastSavedLocation
                              ? 'Xuất lại'
                              : 'Lưu vào Download'}
                          </span>
                        </button>

                        {job.lastSavedFileUri && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                openSavedEpubFile(
                                  job.lastSavedFileUri,
                                  job.lastSavedFileName
                                )
                              }
                              className="min-h-[42px] px-3.5 py-2 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-800 text-xs font-bold inline-flex items-center gap-1.5 transition active:scale-95"
                            >
                              <ExternalLink className="w-3.5 h-3.5 text-[#0284C7]" />
                              <span>Mở sách</span>
                            </button>

                            <button
                              type="button"
                              onClick={() =>
                                shareSavedEpubFile(
                                  job.lastSavedFileUri,
                                  displayTitle || job.lastSavedFileName
                                )
                              }
                              className="min-h-[42px] px-3.5 py-2 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-800 text-xs font-bold inline-flex items-center gap-1.5 transition active:scale-95"
                            >
                              <Share2 className="w-3.5 h-3.5 text-[#0284C7]" />
                              <span>Chia sẻ</span>
                            </button>
                          </>
                        )}

                        <button
                          type="button"
                          disabled={queue.isRunning}
                          onClick={() => void resetQueuedJob(job.jobId)}
                          className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-700 text-xs font-bold inline-flex items-center gap-1.5 transition active:scale-95"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Dịch lại</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
