import {
  BookExportProgress,
  ParsedPdfData,
  PdfExportRenderMode,
  PdfExtractedAsset,
  PdfTranslatedBlock,
} from '../types';
import {
  exportTranslatedDigitalPdfCore,
  exportTranslatedPdfCore,
  PdfExportCanvasLike,
  PdfExportDrawable,
  PdfExportRuntimeAdapter,
} from '../services/pdfExportCore';

export type PdfExportWorkerRequest =
  | {
      type: 'export';
      id: number;
      parsedPdf: ParsedPdfData;
      translatedPages: Record<number, PdfTranslatedBlock[]>;
      translatedTitle: string;
      renderMode?: PdfExportRenderMode;
      fontRegularBytes?: Uint8Array;
      fontBoldBytes?: Uint8Array;
    }
  | {
      type: 'cancel';
      id: number;
    };

export type PdfExportWorkerResponse =
  | {
      type: 'progress';
      id: number;
      progress: BookExportProgress;
    }
  | {
      type: 'heartbeat';
      id: number;
      timestamp: number;
    }
  | {
      type: 'done';
      id: number;
      blob: Blob;
      translatedTitle: string;
    }
  | {
      type: 'error';
      id: number;
      message: string;
      canFallbackToMainThread?: boolean;
    };

function normalizeDim(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 1;
  return Math.min(4096, Math.max(1, Math.round(val)));
}

async function yieldInWorker(pageNumber: number): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (pageNumber % 8 !== 0 && typeof sched?.yield === 'function') {
    try {
      await sched.yield();
      return;
    } catch {}
  }
  await new Promise<void>((resolve) => setTimeout(resolve, pageNumber % 8 === 0 ? 4 : 0));
}

const workerExportAdapter: PdfExportRuntimeAdapter = {
  createCanvas: (width: number, height: number): PdfExportCanvasLike => {
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas không khả dụng trong Worker.');
    }
    return new OffscreenCanvas(
      normalizeDim(width),
      normalizeDim(height)
    ) as unknown as PdfExportCanvasLike;
  },
  canvasToJpegBlob: async (canvas: PdfExportCanvasLike, quality: number): Promise<Blob> => {
    const offscreen = canvas as unknown as OffscreenCanvas;
    return offscreen.convertToBlob({ type: 'image/jpeg', quality });
  },
  decodeAssetToDrawable: async (asset: PdfExtractedAsset): Promise<PdfExportDrawable | null> => {
    try {
      if (typeof createImageBitmap !== 'function') return null;
      const safeBytes = new Uint8Array(asset.data);
      const blob = new Blob([safeBytes], { type: asset.mimeType || 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width || asset.width,
        height: bitmap.height || asset.height,
        dispose: () => {
          try {
            bitmap.close();
          } catch {}
        },
      };
    } catch {
      return null;
    }
  },
  yieldPage: yieldInWorker,
  isWorker: true,
};

const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<PdfExportWorkerRequest>) => void) | null;
  postMessage: (message: PdfExportWorkerResponse) => void;
};

const activeStopSignals = new Map<number, { current: boolean }>();

workerScope.onmessage = async (event: MessageEvent<PdfExportWorkerRequest>) => {
  const payload = event.data;
  if (!payload) return;

  if (payload.type === 'cancel') {
    const signal = activeStopSignals.get(payload.id);
    if (signal) signal.current = true;
    return;
  }

  if (payload.type === 'export') {
    const stopSignal = { current: false };
    activeStopSignals.set(payload.id, stopSignal);

    const heartbeatTimer = setInterval(() => {
      if (!stopSignal.current) {
        workerScope.postMessage({
          type: 'heartbeat',
          id: payload.id,
          timestamp: Date.now(),
        });
      }
    }, 1500);

    try {
      const reportProgress = (progress: BookExportProgress) => {
        workerScope.postMessage({
          type: 'progress',
          id: payload.id,
          progress,
        });
      };

      const useDigital =
        payload.renderMode !== 'image' &&
        Boolean(payload.fontRegularBytes?.byteLength) &&
        Boolean(payload.fontBoldBytes?.byteLength);

      const result = useDigital
        ? await exportTranslatedDigitalPdfCore({
            parsedPdf: payload.parsedPdf,
            translatedPages: payload.translatedPages,
            translatedTitle: payload.translatedTitle,
            fontRegularBytes: payload.fontRegularBytes!,
            fontBoldBytes: payload.fontBoldBytes!,
            adapter: workerExportAdapter,
            stopSignal,
            onProgress: reportProgress,
          })
        : await exportTranslatedPdfCore({
            parsedPdf: payload.parsedPdf,
            translatedPages: payload.translatedPages,
            translatedTitle: payload.translatedTitle,
            adapter: workerExportAdapter,
            stopSignal,
            onProgress: reportProgress,
          });

      workerScope.postMessage({
        type: 'done',
        id: payload.id,
        blob: result.blob,
        translatedTitle: result.translatedTitle,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Lỗi kết xuất PDF trong Worker.';
      const isCancelled = stopSignal.current || message.includes('Đã hủy');
      workerScope.postMessage({
        type: 'error',
        id: payload.id,
        message,
        canFallbackToMainThread: !isCancelled,
      });
    } finally {
      clearInterval(heartbeatTimer);
      activeStopSignals.delete(payload.id);
    }
  }
};
