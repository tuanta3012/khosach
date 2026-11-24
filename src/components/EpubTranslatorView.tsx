import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Download,
  ExternalLink,
  FileUp,
  FolderCheck,
  Languages,
  Pause,
  Play,
  RotateCcw,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  EpubGenreId,
  EpubTranslationJob,
  EpubTranslationProgress,
  ParsedEpubData,
  PdfOutputFormat,
  PdfProcessingMode,
  PdfTranslatedBlock,
} from '../types';
import {
  EPUB_BACKUP_MODEL,
  EPUB_TRANSLATION_MODEL,
  getEpubKeyDiagnostics,
  refreshServerGeminiStatus,
} from '../services/geminiService';
import {
  appendVnSuffix,
  parseEpubFile,
  reassembleAndPackageEpub,
} from '../services/epubService';
import {
  buildEpubJobId,
  buildPdfJobId,
  deleteEpubJob,
  getEpubJobById,
  loadLatestEpubJob,
  saveEpubJob,
  updateEpubJobMetadata,
} from '../services/epubCheckpointDb';
import {
  EPUB_GENRES,
  runParallelEpubTranslation,
} from '../services/epubTranslatorService';
import {
  buildPdfTranslationUnits,
  exportTranslatedPdfFile,
  parseDigitalPdfFile,
  reassemblePdfTranslationToEpub,
} from '../services/pdfDigitalService';
import { runParallelPdfTranslation } from '../services/pdfTranslatorService';
import {
  buildVietnameseBookFileName,
  openSavedEpubFile,
  SavedEpubResult,
  saveTranslatedEpubToDevice,
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

export const EpubTranslatorView: React.FC = () => {
  const { showToast } = useToast();

  const [job, setJob] = useState<EpubTranslationJob | null>(null);
  const [genre, setGenre] = useState<EpubGenreId>('van-hoc');
  const [customNotes, setCustomNotes] = useState<string>('');
  const [pdfOutputFormat, setPdfOutputFormat] = useState<PdfOutputFormat>('epub');
  const [pdfProcessingMode, setPdfProcessingMode] = useState<PdfProcessingMode>('hybrid-digital');
  const [isLoadingJob, setIsLoadingJob] = useState<boolean>(true);
  const [isParsingFile, setIsParsingFile] = useState<boolean>(false);
  const [parseStatusText, setParseStatusText] = useState<string>('');
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [isPackaging, setIsPackaging] = useState<boolean>(false);
  const [savedResult, setSavedResult] = useState<SavedEpubResult | null>(null);
  const [translatedTitle, setTranslatedTitle] = useState<string>('');
  const [progress, setProgress] = useState<EpubTranslationProgress | null>(null);
  const [keyDiag, setKeyDiag] = useState(() => getEpubKeyDiagnostics());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const stopSignalRef = useRef<{ current: boolean }>({ current: false });
  const isMountedRef = useRef<boolean>(true);

  const refreshKeyDiagnostics = useCallback(() => {
    setKeyDiag(getEpubKeyDiagnostics());
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    void refreshServerGeminiStatus().then(() => {
      if (isMountedRef.current) {
        refreshKeyDiagnostics();
      }
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
      isMountedRef.current = false;
      stopSignalRef.current.current = true;
      window.removeEventListener('focus', refreshKeyDiagnostics);
      window.removeEventListener('gemini-keys-updated', refreshKeyDiagnostics);
      window.removeEventListener('storage', refreshKeyDiagnostics);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    };
  }, [refreshKeyDiagnostics]);

  // Nạp checkpoint gần nhất từ IndexedDB khi mở tab
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const latest = await loadLatestEpubJob();
        if (!active) return;
        if (latest) {
          setJob(latest);
          setGenre(latest.genre || 'van-hoc');
          setCustomNotes(latest.customNotes || '');
          setPdfOutputFormat(latest.pdfOutputFormat || 'epub');
          setPdfProcessingMode(latest.pdfProcessingMode || 'hybrid-digital');
          setTranslatedTitle(
            latest.parsedPdfData?.bookTitle || latest.parsedData?.bookTitle || ''
          );
        }
      } finally {
        if (active) setIsLoadingJob(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const isPdfJob = job?.sourceType === 'pdf' && Boolean(job?.parsedPdfData);

  const totalChunks = isPdfJob
    ? job?.pdfUnits?.length || 0
    : job?.parsedData.chunks.length || 0;
  const completedChunksCount = job?.completedChunkIds.length || 0;
  const failedChunksCount = job?.failedChunkIds.length || 0;

  const totalSegments = isPdfJob
    ? job?.parsedPdfData?.totalPages || 0
    : job?.parsedData.segments.length || 0;

  const completedSegmentsCount = useMemo(() => {
    if (!job) return 0;
    if (isPdfJob) {
      return Math.min(
        job.parsedPdfData?.totalPages || 0,
        Object.keys(job.translatedPdfPages || {}).length
      );
    }
    let count = 0;
    for (const chunkIdx of job.completedChunkIds) {
      const ch = job.parsedData.chunks[chunkIdx];
      if (ch) count += ch.segmentIds.length;
    }
    return count;
  }, [job, isPdfJob]);

  const progressPercent = useMemo(() => {
    const done =
      progress && progress.totalChunks > 0 ? progress.completedChunks : completedChunksCount;
    const total =
      progress && progress.totalChunks > 0 ? progress.totalChunks : totalChunks;
    if (total <= 0) return 0;
    if (done >= total) return 100;
    return Math.min(99, Math.round((done / total) * 100));
  }, [progress, completedChunksCount, totalChunks]);

  const isCompleted = Boolean(
    job && totalChunks > 0 && completedChunksCount === totalChunks && failedChunksCount === 0
  );

  const packageAndExportBook = useCallback(
    async (
      targetJob: EpubTranslationJob,
      overrides?: {
        segments?: Record<number, string>;
        pdfPages?: Record<number, PdfTranslatedBlock[]>;
        outputFormat?: PdfOutputFormat;
      },
      autoSave = true
    ): Promise<SavedEpubResult | null> => {
      setIsPackaging(true);
      try {
        const targetIsPdf = targetJob.sourceType === 'pdf' && Boolean(targetJob.parsedPdfData);
        let blob: Blob;
        let nextTitle: string;
        let ext: 'epub' | 'pdf' = 'epub';

        if (targetIsPdf && targetJob.parsedPdfData) {
          const outFmt = overrides?.outputFormat || targetJob.pdfOutputFormat || pdfOutputFormat;
          ext = outFmt;
          const finalPdfPages = overrides?.pdfPages || targetJob.translatedPdfPages || {};
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
          const finalSegments = overrides?.segments || targetJob.translatedSegments;
          const exported = await reassembleAndPackageEpub(
            targetJob.parsedData,
            finalSegments,
            targetJob.epubBuffer
          );
          blob = exported.blob;
          nextTitle = exported.translatedTitle;
        }

        if (isMountedRef.current) {
          setTranslatedTitle(nextTitle);
        }
        if (!autoSave) return null;

        const outFileName = buildVietnameseBookFileName(nextTitle, targetJob.fileName, ext);
        const saved = await saveTranslatedEpubToDevice(blob, outFileName);
        if (isMountedRef.current) {
          setSavedResult(saved);
        }
        showToast(`Đã lưu "${saved.fileName}"`, 'success');
        return saved;
      } catch (err: any) {
        const msg = err?.message || 'Không thể xuất file.';
        showToast(msg, 'error');
        return null;
      } finally {
        if (isMountedRef.current) {
          setIsPackaging(false);
        }
      }
    },
    [pdfOutputFormat, showToast]
  );

  const handleSelectBookFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const lowerName = file.name.toLowerCase();
    const isEpub = lowerName.endsWith('.epub');
    const isPdf = lowerName.endsWith('.pdf');

    if (!isEpub && !isPdf) {
      showToast('Chỉ hỗ trợ .epub hoặc .pdf', 'warning');
      return;
    }

    setIsParsingFile(true);
    setParseStatusText(isPdf ? 'Đang tách PDF...' : 'Đang đọc EPUB...');
    setSavedResult(null);
    setProgress(null);

    try {
      if (isPdf) {
        const jobId = buildPdfJobId(file.name, file.size, file.lastModified);
        const existing = await getEpubJobById(jobId);

        if (existing && existing.parsedPdfData) {
          setJob(existing);
          setGenre(existing.genre || genre);
          setCustomNotes(existing.customNotes || '');
          setPdfOutputFormat(existing.pdfOutputFormat || 'epub');
          setPdfProcessingMode(existing.pdfProcessingMode || 'hybrid-digital');
          setTranslatedTitle(existing.parsedPdfData.bookTitle || '');

          const doneCount = existing.completedChunkIds.length;
          const allCount = existing.pdfUnits?.length || 0;
          showToast(`Khôi phục ${doneCount}/${allCount} phần`, 'info');
          return;
        }

        const buffer = await file.arrayBuffer();
        const parsedPdf = await parseDigitalPdfFile(buffer, file.name, (cur, total) => {
          if (isMountedRef.current) {
            setParseStatusText(`Đang tách PDF: ${cur}/${total} trang`);
          }
        });

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

        const newJob: EpubTranslationJob = {
          jobId,
          sourceType: 'pdf',
          fileName: file.name,
          fileSize: file.size,
          lastModified: file.lastModified,
          genre,
          customNotes,
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
          updatedAt: Date.now(),
        };

        await saveEpubJob(newJob);
        setJob(newJob);
        setPdfOutputFormat('epub');
        setPdfProcessingMode(initialMode);
        setTranslatedTitle(parsedPdf.bookTitle || '');
        showToast(
          `Đã tách ${parsedPdf.totalPages} trang (${initialUnits.length} phần)`,
          'success'
        );
        return;
      }

      const jobId = buildEpubJobId(file.name, file.size, file.lastModified);
      const existing = await getEpubJobById(jobId);

      if (existing) {
        setJob(existing);
        setGenre(existing.genre || genre);
        setCustomNotes(existing.customNotes || '');
        setTranslatedTitle(existing.parsedData.bookTitle || '');

        const doneCount = existing.completedChunkIds.length;
        const allCount = existing.parsedData.chunks.length;
        showToast(`Khôi phục ${doneCount}/${allCount} phần`, 'info');
        return;
      }

      const buffer = await file.arrayBuffer();
      const parsedData = await parseEpubFile(buffer);

      if (parsedData.segments.length === 0 || parsedData.chunks.length === 0) {
        showToast('Không có nội dung văn bản để dịch.', 'warning');
        return;
      }

      const newJob: EpubTranslationJob = {
        jobId,
        sourceType: 'epub',
        fileName: file.name,
        fileSize: file.size,
        lastModified: file.lastModified,
        genre,
        customNotes,
        epubBuffer: buffer,
        parsedData,
        translatedSegments: {},
        completedChunkIds: [],
        failedChunkIds: [],
        status: 'idle',
        updatedAt: Date.now(),
      };

      await saveEpubJob(newJob);
      setJob(newJob);
      setTranslatedTitle(parsedData.bookTitle || '');
      showToast(`Sẵn sàng (${parsedData.chunks.length} phần)`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Tệp không hợp lệ', 'error');
    } finally {
      if (isMountedRef.current) {
        setIsParsingFile(false);
        setParseStatusText('');
      }
    }
  };

  const handleGenreChange = (nextGenre: EpubGenreId) => {
    setGenre(nextGenre);
    if (job && !isTranslating) {
      setJob((prev) => (prev ? { ...prev, genre: nextGenre, updatedAt: Date.now() } : prev));
      updateEpubJobMetadata(job.jobId, { genre: nextGenre }).catch(() => {});
    }
  };

  const handleNotesChange = (nextNotes: string) => {
    setCustomNotes(nextNotes);
    if (job && !isTranslating) {
      setJob((prev) => (prev ? { ...prev, customNotes: nextNotes, updatedAt: Date.now() } : prev));
      updateEpubJobMetadata(job.jobId, { customNotes: nextNotes }).catch(() => {});
    }
  };

  const handlePdfOutputFormatChange = (nextFormat: PdfOutputFormat) => {
    if (isTranslating || isPackaging) return;
    setPdfOutputFormat(nextFormat);
    setSavedResult(null);
    if (job && isPdfJob) {
      setJob((prev) =>
        prev ? { ...prev, pdfOutputFormat: nextFormat, updatedAt: Date.now() } : prev
      );
      updateEpubJobMetadata(job.jobId, { pdfOutputFormat: nextFormat }).catch(() => {});
    }
  };

  const handlePdfProcessingModeChange = (nextMode: PdfProcessingMode) => {
    if (!job || !isPdfJob || !job.parsedPdfData || isTranslating || completedChunksCount > 0) {
      return;
    }
    const rebuiltUnits = buildPdfTranslationUnits(job.parsedPdfData, nextMode);
    setPdfProcessingMode(nextMode);
    setProgress(null);
    setJob((prev) =>
      prev
        ? {
            ...prev,
            pdfProcessingMode: nextMode,
            pdfUnits: rebuiltUnits,
            updatedAt: Date.now(),
          }
        : prev
    );
    updateEpubJobMetadata(job.jobId, {
      pdfProcessingMode: nextMode,
      pdfUnits: rebuiltUnits,
    }).catch(() => {});
  };

  const handleStartOrResume = async () => {
    if (!job || isTranslating) return;

    let latestDiag = getEpubKeyDiagnostics();
    if (latestDiag.totalKeys === 0) {
      await refreshServerGeminiStatus();
      latestDiag = getEpubKeyDiagnostics();
    }
    setKeyDiag(latestDiag);

    if (latestDiag.readyKeys === 0) {
      showToast(
        latestDiag.totalKeys === 0
          ? 'Chưa có API Key (Cài đặt ⚙️)'
          : 'API Key đang hết lượt / tạm nghỉ',
        'warning'
      );
      return;
    }

    stopSignalRef.current.current = false;
    setIsTranslating(true);
    setSavedResult(null);

    const activeJobSnapshot: EpubTranslationJob = {
      ...job,
      genre,
      customNotes,
      pdfOutputFormat,
      pdfProcessingMode,
    };

    try {
      if (isPdfJob && activeJobSnapshot.parsedPdfData) {
        const result = await runParallelPdfTranslation({
          job: activeJobSnapshot,
          parsedPdf: activeJobSnapshot.parsedPdfData,
          processingMode: pdfProcessingMode,
          genre,
          customNotes,
          stopSignal: stopSignalRef.current,
          onProgress: (prog) => {
            if (isMountedRef.current) setProgress(prog);
          },
          onJobStateSync: (updates) => {
            if (!isMountedRef.current) return;
            setJob((prev) =>
              prev
                ? {
                    ...prev,
                    translatedPdfPages: updates.translatedPdfPages,
                    completedChunkIds: updates.completedChunkIds,
                    failedChunkIds: updates.failedChunkIds,
                    updatedAt: Date.now(),
                  }
                : prev
            );
          },
        });

        if (!isMountedRef.current) return;

        const updatedJob: EpubTranslationJob = {
          ...activeJobSnapshot,
          translatedPdfPages: result.translatedPdfPages,
          completedChunkIds: result.completedChunkIds,
          failedChunkIds: result.failedChunkIds,
          status: result.completed ? 'completed' : result.stopped ? 'paused' : 'error',
          lastError: result.errorMessage,
          updatedAt: Date.now(),
        };
        setJob(updatedJob);
        refreshKeyDiagnostics();

        if (result.completed) {
          await packageAndExportBook(
            updatedJob,
            { pdfPages: result.translatedPdfPages, outputFormat: pdfOutputFormat },
            true
          );
        } else if (result.stopped) {
          showToast(
            `Đã tạm dừng (${result.completedChunkIds.length}/${totalChunks} phần)`,
            'info'
          );
        } else if (result.errorMessage) {
          showToast(result.errorMessage, 'warning');
        }
        return;
      }

      const result = await runParallelEpubTranslation({
        job: activeJobSnapshot,
        genre,
        customNotes,
        stopSignal: stopSignalRef.current,
        onProgress: (prog) => {
          if (isMountedRef.current) {
            setProgress(prog);
          }
        },
        onJobStateSync: (updates) => {
          if (!isMountedRef.current) return;
          setJob((prev) =>
            prev
              ? {
                  ...prev,
                  translatedSegments: updates.translatedSegments,
                  completedChunkIds: updates.completedChunkIds,
                  failedChunkIds: updates.failedChunkIds,
                  updatedAt: Date.now(),
                }
              : prev
          );
        },
      });

      if (!isMountedRef.current) return;

      const updatedJob: EpubTranslationJob = {
        ...activeJobSnapshot,
        translatedSegments: result.translatedSegments,
        completedChunkIds: result.completedChunkIds,
        failedChunkIds: result.failedChunkIds,
        status: result.completed ? 'completed' : result.stopped ? 'paused' : 'error',
        lastError: result.errorMessage,
        updatedAt: Date.now(),
      };
      setJob(updatedJob);
      refreshKeyDiagnostics();

      if (result.completed) {
        await packageAndExportBook(updatedJob, { segments: result.translatedSegments }, true);
      } else if (result.stopped) {
        showToast(
          `Đã tạm dừng (${result.completedChunkIds.length}/${updatedJob.parsedData.chunks.length} phần)`,
          'info'
        );
      } else if (result.errorMessage) {
        showToast(result.errorMessage, 'warning');
      }
    } finally {
      if (isMountedRef.current) {
        setIsTranslating(false);
      }
    }
  };

  const handlePauseTranslation = () => {
    if (!isTranslating) return;
    stopSignalRef.current.current = true;
    showToast('Đang tạm dừng...', 'info');
  };

  const handleExportBook = async () => {
    if (!job || !isCompleted) return;
    await packageAndExportBook(job, { outputFormat: pdfOutputFormat }, true);
  };

  const handleResetProgress = async () => {
    if (!job || isTranslating) return;
    const rebuiltUnits =
      isPdfJob && job.parsedPdfData
        ? buildPdfTranslationUnits(job.parsedPdfData, pdfProcessingMode)
        : job.pdfUnits;

    const resetJob: EpubTranslationJob = {
      ...job,
      genre,
      customNotes,
      pdfOutputFormat,
      pdfProcessingMode,
      pdfUnits: rebuiltUnits,
      translatedSegments: {},
      translatedPdfPages: {},
      completedChunkIds: [],
      failedChunkIds: [],
      status: 'idle',
      lastError: undefined,
      updatedAt: Date.now(),
    };
    await saveEpubJob(resetJob);
    setJob(resetJob);
    setProgress(null);
    setSavedResult(null);
    setTranslatedTitle(
      job.parsedPdfData?.bookTitle || job.parsedData.bookTitle || ''
    );
    showToast('Đã đặt lại tiến độ', 'info');
  };

  const handleClearJob = async () => {
    if (!job || isTranslating) return;
    await deleteEpubJob(job.jobId);
    setJob(null);
    setProgress(null);
    setSavedResult(null);
    setTranslatedTitle('');
    showToast('Đã xóa phiên dịch', 'info');
  };

  const displayBookTitle = useMemo(() => {
    if (!job) return '';
    const raw =
      job.parsedPdfData?.bookTitle ||
      job.parsedData.bookTitle ||
      job.fileName.replace(/\.(epub|pdf)$/i, '');
    return isCompleted ? appendVnSuffix(raw) : raw;
  }, [job, isCompleted]);

  return (
    <div className="space-y-4 pb-8">
      <input
        ref={fileInputRef}
        type="file"
        accept=".epub,.pdf,application/epub+zip,application/pdf"
        onChange={handleSelectBookFile}
        className="hidden"
      />

      {/* Header gọn */}
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
                <span>
                  {keyDiag.totalKeys === 0
                    ? `Chưa có API Key (Cài đặt ⚙️)`
                    : `${keyDiag.readyKeys}/${keyDiag.totalKeys} Key sẵn sàng · ${EPUB_TRANSLATION_MODEL} / ${EPUB_BACKUP_MODEL}`}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={isTranslating || isParsingFile}
              onClick={() => fileInputRef.current?.click()}
              className="min-h-[44px] w-full sm:w-auto px-4 py-2 rounded-xl bg-[#0284C7] hover:bg-sky-700 disabled:opacity-50 text-white text-xs sm:text-sm font-bold inline-flex items-center justify-center gap-1.5 shadow-xs transition active:scale-95 whitespace-nowrap"
            >
              <FileUp className="w-4 h-4" />
              <span>{job ? 'Đổi tệp' : 'Chọn EPUB / PDF'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Trạng thái chưa chọn sách */}
      {isLoadingJob ? (
        <div className="bg-white rounded-2xl border border-slate-200/80 p-8 text-center text-sm text-slate-500">
          Đang tải...
        </div>
      ) : !job ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isParsingFile}
          className="w-full bg-white hover:bg-sky-50/40 rounded-2xl border-2 border-dashed border-slate-300 hover:border-[#0284C7] p-8 sm:p-10 text-center transition group"
        >
          <div className="w-14 h-14 mx-auto rounded-2xl bg-sky-50 border border-sky-200 text-[#0284C7] flex items-center justify-center group-hover:scale-105 transition">
            <BookOpen className="w-7 h-7" />
          </div>
          <p className="mt-3 text-sm sm:text-base font-bold text-slate-800">
            {isParsingFile ? parseStatusText || 'Đang xử lý tệp...' : 'Chọn tệp .EPUB hoặc .PDF Digital'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Giữ nguyên chương, bảng biểu & hình ảnh · Xuất vào Download
          </p>
        </button>
      ) : (
        <>
          {/* Thông tin sách + Tùy chọn tối giản */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 sm:p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-extrabold text-slate-900 truncate">
                  {displayBookTitle}
                </h3>
                <p className="text-xs text-slate-600 mt-1 tabular-nums">
                  {isPdfJob && job.parsedPdfData
                    ? `PDF Digital · ${job.parsedPdfData.totalPages} trang · ${job.parsedPdfData.chapters.length} chương · ${Object.keys(job.parsedPdfData.assets).length} ảnh · ${formatFileSize(job.fileSize)}`
                    : `EPUB · ${job.parsedData.spineFilePaths.length} mục · ${totalChunks} phần · ${formatFileSize(job.fileSize)}`}
                </p>
              </div>

              {!isTranslating && (
                <button
                  type="button"
                  onClick={handleClearJob}
                  title="Xóa phiên dịch"
                  className="min-w-[44px] min-h-[44px] p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition flex items-center justify-center shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Tùy chọn riêng cho PDF Digital */}
            {isPdfJob && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                <div>
                  <span className="block text-xs font-bold text-slate-700 mb-1.5">
                    Đầu ra
                  </span>
                  <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-xl">
                    {(['epub', 'pdf'] as PdfOutputFormat[]).map((fmt) => {
                      const active = pdfOutputFormat === fmt;
                      return (
                        <button
                          key={fmt}
                          type="button"
                          disabled={isTranslating || isPackaging}
                          onClick={() => handlePdfOutputFormatChange(fmt)}
                          className={`min-h-[40px] rounded-lg text-xs font-bold uppercase transition ${
                            active
                              ? 'bg-white text-[#0284C7] shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          } disabled:opacity-60`}
                        >
                          {fmt}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <span className="block text-xs font-bold text-slate-700 mb-1.5">
                    Xử lý
                  </span>
                  <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-xl">
                    {(
                      [
                        { id: 'hybrid-digital', label: 'Tối ưu Digital' },
                        { id: 'full-vision', label: 'Vision toàn trang' },
                      ] as const
                    ).map((opt) => {
                      const active = pdfProcessingMode === opt.id;
                      const locked = isTranslating || completedChunksCount > 0;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={locked}
                          onClick={() => handlePdfProcessingModeChange(opt.id)}
                          className={`min-h-[40px] px-2 rounded-lg text-xs font-bold transition truncate ${
                            active
                              ? 'bg-white text-[#0284C7] shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          } disabled:opacity-60`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 pt-2 border-t border-slate-100">
              <div>
                <label
                  htmlFor="epub-genre-select"
                  className="block text-xs font-bold text-slate-700 mb-1.5"
                >
                  Thể loại
                </label>
                <select
                  id="epub-genre-select"
                  value={genre}
                  disabled={isTranslating}
                  onChange={(e) => handleGenreChange(e.target.value as EpubGenreId)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#0284C7] disabled:bg-slate-50 disabled:text-slate-500"
                >
                  {EPUB_GENRES.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="epub-custom-notes"
                  className="block text-xs font-bold text-slate-700 mb-1.5"
                >
                  Ghi chú dịch
                </label>
                <textarea
                  id="epub-custom-notes"
                  rows={1}
                  disabled={isTranslating}
                  value={customNotes}
                  onChange={(e) => handleNotesChange(e.target.value)}
                  placeholder="Xưng hô, tên riêng, thuật ngữ..."
                  className="w-full min-h-[44px] px-3 py-2.5 rounded-xl border border-slate-300 bg-white text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0284C7] disabled:bg-slate-50 disabled:text-slate-500 resize-none"
                />
              </div>
            </div>
          </div>

          {/* Tiến trình & Điều khiển */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm font-bold text-slate-800 truncate">
                  {progress?.statusMessage ||
                    (isCompleted
                      ? `Hoàn tất ${totalChunks}/${totalChunks}`
                      : completedChunksCount > 0
                      ? `Đã lưu ${completedChunksCount}/${totalChunks} phần`
                      : 'Sẵn sàng dịch')}
                </p>
                <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                  {completedChunksCount}/{totalChunks} phần · {completedSegmentsCount}/{totalSegments}{' '}
                  {isPdfJob ? 'trang' : 'đoạn'}
                  {isTranslating && progress ? ` · ${progress.activeWorkers} luồng` : ''}
                  {failedChunksCount > 0 && !isTranslating
                    ? ` · ${failedChunksCount} lỗi`
                    : ''}
                </p>
              </div>
              <span className="text-lg sm:text-xl font-black text-[#0284C7] tabular-nums shrink-0">
                {progressPercent}%
              </span>
            </div>

            <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden border border-slate-200/60">
              <div
                className={`h-full transition-all duration-300 rounded-full ${
                  isCompleted
                    ? 'bg-[#10B981]'
                    : failedChunksCount > 0 && !isTranslating
                    ? 'bg-amber-500'
                    : 'bg-[#0284C7]'
                }`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            {job.lastError && !isTranslating && !isCompleted && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 font-medium">
                {job.lastError}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              {!isCompleted && !isTranslating && (
                <button
                  type="button"
                  onClick={handleStartOrResume}
                  className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#10B981] hover:bg-emerald-600 text-white text-sm font-bold inline-flex items-center gap-2 shadow-xs transition active:scale-95"
                >
                  {completedChunksCount > 0 ? (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      <span>{failedChunksCount > 0 ? 'Thử lại & Tiếp tục' : 'Tiếp tục dịch'}</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>Bắt đầu dịch</span>
                    </>
                  )}
                </button>
              )}

              {isTranslating && (
                <button
                  type="button"
                  onClick={handlePauseTranslation}
                  className="min-h-[44px] px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 text-sm font-bold inline-flex items-center gap-2 shadow-xs transition active:scale-95"
                >
                  <Pause className="w-4 h-4 fill-current" />
                  <span>Tạm dừng</span>
                </button>
              )}

              {completedChunksCount > 0 && !isTranslating && (
                <button
                  type="button"
                  onClick={handleResetProgress}
                  className="min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 transition active:scale-95"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>Dịch lại</span>
                </button>
              )}
            </div>
          </div>

          {/* Kết quả xuất file */}
          {isCompleted && (
            <div className="bg-emerald-50/70 rounded-2xl border border-emerald-200 p-4 sm:p-5 space-y-3.5">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-[#10B981] shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <h4 className="text-sm font-extrabold text-emerald-950">
                    Hoàn tất bản dịch ({isPdfJob ? pdfOutputFormat.toUpperCase() : 'EPUB'})
                  </h4>
                  {savedResult && (
                    <p className="text-xs text-emerald-800 mt-1 flex items-center gap-1.5 break-all">
                      <FolderCheck className="w-3.5 h-3.5 shrink-0" />
                      <span>{savedResult.locationLabel}</span>
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={isPackaging}
                  onClick={handleExportBook}
                  className="min-h-[44px] px-4 py-2.5 rounded-xl bg-[#0284C7] hover:bg-sky-700 disabled:opacity-60 text-white text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 shadow-xs transition active:scale-95"
                >
                  <Download className="w-4 h-4" />
                  <span>
                    {isPackaging
                      ? 'Đang xuất...'
                      : savedResult
                      ? 'Xuất lại'
                      : 'Lưu vào Download'}
                  </span>
                </button>

                {savedResult?.fileUri && (
                  <>
                    <button
                      type="button"
                      onClick={() => openSavedEpubFile(savedResult.fileUri, savedResult.fileName)}
                      className="min-h-[44px] px-4 py-2.5 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-800 text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 transition active:scale-95"
                    >
                      <ExternalLink className="w-4 h-4 text-[#0284C7]" />
                      <span>Mở sách</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        shareSavedEpubFile(
                          savedResult.fileUri,
                          translatedTitle || displayBookTitle || savedResult.fileName
                        )
                      }
                      className="min-h-[44px] px-4 py-2.5 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-800 text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 transition active:scale-95"
                    >
                      <Share2 className="w-4 h-4 text-[#0284C7]" />
                      <span>Chia sẻ</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
