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
  Download,
  ExternalLink,
  Languages,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Share2,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  EpubGenreId,
  EpubTranslationJob,
  PdfOutputFormat,
} from '../types';
import {
  getEpubKeyDiagnostics,
  refreshServerGeminiStatus,
} from '../services/geminiService';
import { appendVnSuffix } from '../services/epubService';
import { EPUB_GENRES } from '../services/epubTranslatorService';
import {
  addFilesToQueue,
  cancelFileParsing,
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

  return {
    isPdf,
    totalChunks,
    completedChunks,
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

  useEffect(() => {
    const notice = queue.lastNotice;
    if (notice && notice.id > lastSeenNoticeIdRef.current) {
      lastSeenNoticeIdRef.current = notice.id;
      showToast(notice.text, notice.type);
      refreshKeyDiagnostics();
    }
  }, [queue.lastNotice, showToast, refreshKeyDiagnostics]);

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
    <div className="space-y-3 pb-8">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".epub,.pdf,application/epub+zip,application/pdf"
        onChange={handleSelectFiles}
        className="hidden"
      />

      {/* Thanh tiêu đề & thao tác chính */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-sky-50 border border-sky-200/80 text-[#0284C7] flex items-center justify-center shrink-0">
            <Languages className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-extrabold text-slate-900 truncate">
              Dịch Sách EPUB / PDF
            </h2>
            <p
              className={`text-xs font-medium tabular-nums truncate ${
                keyDiag.totalKeys === 0
                  ? 'text-rose-600'
                  : keyDiag.readyKeys > 0
                  ? 'text-slate-500'
                  : 'text-amber-600'
              }`}
            >
              {keyDiag.totalKeys === 0
                ? 'Chưa có API Key'
                : `${keyDiag.readyKeys}/${keyDiag.totalKeys} Key sẵn sàng`}
            </p>
          </div>
        </div>

        {queue.jobs.length > 0 && (
          <button
            type="button"
            disabled={queue.isParsingFiles}
            onClick={() => fileInputRef.current?.click()}
            className="min-h-[44px] px-4 py-2 rounded-xl bg-[#0284C7] hover:bg-sky-700 disabled:opacity-50 text-white text-xs sm:text-sm font-bold inline-flex items-center justify-center gap-1.5 shadow-xs transition active:scale-95 whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>Thêm sách</span>
          </button>
        )}
      </div>

      {/* Tiến trình tách trang PDF */}
      {queue.isParsingFiles && (
        <div className="bg-sky-50 border border-sky-200 rounded-2xl px-4 py-2.5 flex items-center justify-between gap-3 text-xs sm:text-sm font-bold text-[#0284C7]">
          <span className="truncate tabular-nums">
            {queue.parseStatusText || 'Đang xử lý tệp...'}
          </span>
          <button
            type="button"
            onClick={cancelFileParsing}
            className="min-h-[38px] px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl shadow-xs transition active:scale-95 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Hủy / Dừng
          </button>
        </div>
      )}

      {/* Trạng thái rỗng / Đang nạp */}
      {queue.isLoading ? (
        <div className="bg-white rounded-2xl border border-slate-200/80 p-8 text-center text-sm text-slate-500">
          Đang tải...
        </div>
      ) : queue.jobs.length === 0 ? (
        <div className="flex justify-center py-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={queue.isParsingFiles}
            className="min-h-[48px] px-5 py-3 rounded-2xl bg-[#0284C7] hover:bg-sky-700 disabled:opacity-60 text-white text-sm font-bold inline-flex items-center justify-center gap-2 shadow-xs transition active:scale-[0.98] cursor-pointer"
          >
            <Upload className="w-4 h-4 shrink-0" />
            <span>
              {queue.isParsingFiles
                ? queue.parseStatusText || 'Đang xử lý tệp...'
                : 'Chọn file .EPUB hoặc .PDF'}
            </span>
          </button>
        </div>
      ) : (
        <>
          {/* Thanh điều khiển hàng chờ gọn */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs px-3.5 py-2.5 flex items-center justify-between gap-2">
            <span className="text-xs sm:text-sm font-bold text-slate-700 tabular-nums truncate">
              {completedCount}/{queue.jobs.length} hoàn tất
              {queue.packagingJobId
                ? ' · Đang xuất file'
                : queue.isRunning
                ? ' · Đang dịch'
                : ''}
            </span>

            <div className="flex items-center gap-2 shrink-0">
              {pendingCount > 0 && !queue.isRunning && (
                <button
                  type="button"
                  onClick={() => void startOrResumeBookQueue()}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-[#10B981] hover:bg-emerald-600 text-white text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 shadow-xs transition active:scale-95 whitespace-nowrap"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>
                    {hasPausedOrStartedPending
                      ? `Tiếp tục (${pendingCount})`
                      : `Dịch toàn bộ (${pendingCount})`}
                  </span>
                </button>
              )}

              {queue.isRunning && (pendingCount > 0 || !queue.packagingJobId) && (
                <button
                  type="button"
                  disabled={queue.isStopping}
                  onClick={pauseBookQueue}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-slate-950 text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 shadow-xs transition active:scale-95 whitespace-nowrap"
                >
                  <Pause className="w-3.5 h-3.5 fill-current" />
                  <span>{queue.isStopping ? 'Đang dừng...' : 'Tạm dừng'}</span>
                </button>
              )}

              {completedCount > 0 && (
                <button
                  type="button"
                  onClick={() => void clearCompletedFromQueue()}
                  className="min-h-[44px] px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-bold inline-flex items-center gap-1.5 transition active:scale-95 whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Xóa xong</span>
                </button>
              )}
            </div>
          </div>

          {/* Danh sách file gọn */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs divide-y divide-slate-100 overflow-hidden">
            {queue.jobs.map((job, idx) => {
              const isActive = queue.isRunning && queue.activeJobId === job.jobId;
              const stats = getJobStats(job);
              const done = job.status === 'completed' || isJobCompleted(job);
              const isPackaging = queue.packagingJobId === job.jobId;
              const pkgProg =
                isPackaging && queue.packagingProgress?.jobId === job.jobId
                  ? queue.packagingProgress
                  : null;
              const isTranslatingActive = isActive && !done && !isPackaging;
              const activeProg = isTranslatingActive ? queue.activeProgress : null;

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
              const configOpen = Boolean(expandedConfigIds[job.jobId]);
              const outFmt: PdfOutputFormat = job.pdfOutputFormat || 'epub';
              const showProgressBar =
                isTranslatingActive ||
                isPackaging ||
                done ||
                stats.completedChunks > 0 ||
                job.status === 'error';

              return (
                <div
                  key={job.jobId}
                  className={`px-3.5 py-3 space-y-2 transition-colors ${
                    isTranslatingActive || isPackaging
                      ? 'bg-sky-50/50'
                      : done
                      ? 'bg-emerald-50/25'
                      : 'bg-white'
                  }`}
                >
                  {/* Hàng chính: STT + Tên + Metadata rút gọn | Nút thao tác */}
                  <div className="flex items-center justify-between gap-2.5">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-bold text-slate-900 truncate">
                        <span className="text-slate-400 font-semibold mr-1.5 tabular-nums">
                          {idx + 1}.
                        </span>
                        {displayTitle}
                      </h3>
                      <div className="flex items-center gap-1.5 mt-0.5 text-xs text-slate-500 tabular-nums truncate">
                        <span>
                          {stats.isPdf && job.parsedPdfData
                            ? `PDF · ${job.parsedPdfData.totalPages} tr`
                            : `EPUB · ${allChunks} phần`}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{formatFileSize(job.fileSize)}</span>
                        {isPackaging ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-[#0284C7]">
                              Xuất {pkgProg?.percent ?? 0}%
                            </span>
                          </>
                        ) : done ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-emerald-700">
                              Xong · {elapsedLabel}
                            </span>
                          </>
                        ) : isTranslatingActive ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-[#0284C7]">
                              {percent}% · {elapsedLabel}
                            </span>
                          </>
                        ) : job.status === 'error' ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-rose-600">Lỗi</span>
                          </>
                        ) : stats.completedChunks > 0 || job.status === 'paused' ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-amber-700">
                              {percent}% · {elapsedLabel}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {isTranslatingActive && (
                        <button
                          type="button"
                          disabled={queue.isStopping}
                          onClick={pauseBookQueue}
                          className="min-h-[44px] px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-slate-950 text-xs font-bold inline-flex items-center gap-1 whitespace-nowrap active:scale-95 transition"
                        >
                          <Pause className="w-3.5 h-3.5 fill-current" />
                          <span>Dừng</span>
                        </button>
                      )}

                      {!done && !queue.isRunning && (
                        <button
                          type="button"
                          onClick={() =>
                            void startOrResumeBookQueue(job.jobId, { singleJobOnly: true })
                          }
                          className="min-h-[44px] px-3 py-1.5 rounded-xl bg-[#10B981] hover:bg-emerald-600 text-white text-xs font-bold inline-flex items-center gap-1 whitespace-nowrap active:scale-95 transition"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>{stats.completedChunks > 0 ? 'Tiếp tục' : 'Dịch'}</span>
                        </button>
                      )}

                      {done && (
                        <>
                          <button
                            type="button"
                            disabled={isPackaging}
                            onClick={() =>
                              void exportBookJobToDevice(job.jobId, {
                                outputFormat: outFmt,
                              })
                            }
                            className="min-h-[44px] px-3 py-1.5 rounded-xl bg-[#0284C7] hover:bg-sky-700 disabled:opacity-75 text-white text-xs font-bold inline-flex items-center gap-1 whitespace-nowrap active:scale-95 transition tabular-nums"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>
                              {isPackaging
                                ? pkgProg
                                  ? `Xuất ${pkgProg.percent}%`
                                  : 'Đang xuất'
                                : 'Lưu'}
                            </span>
                          </button>

                          {job.lastSavedFileUri && !isPackaging && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  openSavedEpubFile(
                                    job.lastSavedFileUri,
                                    job.lastSavedFileName
                                  )
                                }
                                title="Mở sách"
                                aria-label="Mở sách"
                                className="min-w-[44px] min-h-[44px] rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 flex items-center justify-center active:scale-95 transition"
                              >
                                <ExternalLink className="w-4 h-4 text-[#0284C7]" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  shareSavedEpubFile(
                                    job.lastSavedFileUri,
                                    displayTitle || job.lastSavedFileName
                                  )
                                }
                                title="Chia sẻ"
                                aria-label="Chia sẻ"
                                className="min-w-[44px] min-h-[44px] rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 flex items-center justify-center active:scale-95 transition"
                              >
                                <Share2 className="w-4 h-4 text-[#0284C7]" />
                              </button>
                            </>
                          )}
                        </>
                      )}

                      {!isTranslatingActive && !isPackaging && (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleConfig(job.jobId)}
                            title="Tùy chọn"
                            aria-label="Tùy chọn"
                            className={`min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center transition ${
                              configOpen
                                ? 'bg-slate-100 text-slate-900'
                                : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                            }`}
                          >
                            <SlidersHorizontal className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeQueuedJob(job.jobId)}
                            title="Xóa"
                            aria-label="Xóa"
                            className="min-w-[44px] min-h-[44px] rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center transition"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Thanh tiến độ dịch / tiến trình xuất chi tiết */}
                  {showProgressBar && (
                    <div className="space-y-1">
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 rounded-full ${
                            isPackaging
                              ? 'bg-[#0284C7]'
                              : done
                              ? 'bg-[#10B981]'
                              : job.status === 'error'
                              ? 'bg-rose-500'
                              : isTranslatingActive
                              ? 'bg-[#0284C7]'
                              : 'bg-amber-500'
                          }`}
                          style={{
                            width: `${isPackaging ? Math.max(3, pkgProg?.percent ?? 0) : percent}%`,
                          }}
                        />
                      </div>

                      {isPackaging && pkgProg && (
                        <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-[#0284C7] tabular-nums">
                          <span className="break-words min-w-0 flex-1">{pkgProg.stage}</span>
                          <span className="font-bold shrink-0">{pkgProg.percent}%</span>
                        </div>
                      )}

                      {!isPackaging && isTranslatingActive && activeProg?.statusMessage && (
                        <p className="text-[11px] font-medium text-[#0284C7] truncate tabular-nums">
                          {activeProg.statusMessage}
                        </p>
                      )}
                    </div>
                  )}

                  {job.lastError && !isTranslatingActive && !done && (
                    <p className="text-xs text-rose-600 font-medium break-words leading-relaxed">
                      {job.lastError}
                    </p>
                  )}

                  {/* Bảng tùy chọn thu gọn theo từng file */}
                  {configOpen && !isTranslatingActive && !isPackaging && (
                    <div className="pt-2.5 border-t border-slate-100 space-y-2.5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <select
                          aria-label="Thể loại"
                          value={job.genre}
                          onChange={(e) => {
                            const val = e.target.value as EpubGenreId;
                            setDefaultGenre(val);
                            void updateQueuedJobConfig(job.jobId, { genre: val });
                          }}
                          className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-800"
                        >
                          {EPUB_GENRES.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.label}
                            </option>
                          ))}
                        </select>

                        <input
                          type="text"
                          aria-label="Ghi chú dịch"
                          value={job.customNotes}
                          onChange={(e) =>
                            void updateQueuedJobConfig(job.jobId, {
                              customNotes: e.target.value,
                            })
                          }
                          placeholder="Ghi chú: xưng hô, tên riêng..."
                          className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-xs text-slate-800 placeholder:text-slate-400"
                        />
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {stats.isPdf ? (
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
                                className={`min-h-[38px] px-3 rounded-lg text-xs font-bold uppercase transition ${
                                  outFmt === fmt
                                    ? 'bg-white text-[#0284C7] shadow-xs'
                                    : 'text-slate-600'
                                }`}
                              >
                                {fmt}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <span />
                        )}

                        <div className="flex items-center gap-1.5">
                          {!done && queue.jobs.length > 1 && (
                            <>
                              <button
                                type="button"
                                disabled={idx === 0}
                                onClick={() => void moveQueuedJob(job.jobId, 'up')}
                                title="Lên"
                                aria-label="Chuyển lên"
                                className="min-w-[40px] min-h-[40px] rounded-xl border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-35 text-slate-600 flex items-center justify-center"
                              >
                                <ArrowUp className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                disabled={idx === queue.jobs.length - 1}
                                onClick={() => void moveQueuedJob(job.jobId, 'down')}
                                title="Xuống"
                                aria-label="Chuyển xuống"
                                className="min-w-[40px] min-h-[40px] rounded-xl border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-35 text-slate-600 flex items-center justify-center"
                              >
                                <ArrowDown className="w-4 h-4" />
                              </button>
                            </>
                          )}

                          {(done || stats.completedChunks > 0) && !queue.isRunning && (
                            <button
                              type="button"
                              onClick={() => void resetQueuedJob(job.jobId)}
                              className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold inline-flex items-center gap-1 whitespace-nowrap"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Dịch lại</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
