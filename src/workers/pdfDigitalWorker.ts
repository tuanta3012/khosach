import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ParsedPdfData, PdfExtractedAsset, PdfFigureBox } from '../types';
import {
  cropFiguresFromPage,
  parseDigitalPdfCore,
  PdfCanvasLike,
  PdfParserRuntimeAdapter,
  yieldToEventLoopFast,
} from '../services/pdfDigitalParserCore';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  pdfWorkerUrl,
  self.location.href
).toString();

export type PdfWorkerRequest =
  | {
      type: 'parse';
      id: number;
      buffer: ArrayBuffer;
      fileName: string;
    }
  | {
      type: 'extract-assets';
      id: number;
      buffer: ArrayBuffer;
      pages: Array<{ pageNumber: number; figureBoxes: PdfFigureBox[] }>;
    }
  | {
      type: 'cancel';
      id: number;
    };

export type PdfWorkerResponse =
  | {
      type: 'progress';
      id: number;
      currentPage: number;
      totalPages: number;
    }
  | {
      type: 'done';
      id: number;
      result: ParsedPdfData;
    }
  | {
      type: 'assets-done';
      id: number;
      assets: Record<string, PdfExtractedAsset>;
    }
  | {
      type: 'error';
      id: number;
      message: string;
      canFallbackToMainThread?: boolean;
    };

function normalizeCanvasDimension(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 1;
  return Math.min(4096, Math.max(1, Math.ceil(val)));
}

class WorkerCanvasFactory {
  create(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('Invalid canvas size');
    }
    const w = normalizeCanvasDimension(width);
    const h = normalizeCanvasDimension(height);
    const canvas = new OffscreenCanvas(w, h);
    return {
      canvas,
      context: canvas.getContext('2d', { willReadFrequently: true }),
    };
  }

  reset({ canvas }: { canvas: OffscreenCanvas }, width: number, height: number) {
    if (!canvas) {
      throw new Error('Canvas is not specified');
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('Invalid canvas size');
    }
    canvas.width = normalizeCanvasDimension(width);
    canvas.height = normalizeCanvasDimension(height);
  }

  destroy(canvasAndContext: {
    canvas: OffscreenCanvas | null;
    context: OffscreenCanvasRenderingContext2D | null;
  }) {
    if (canvasAndContext.canvas) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
    }
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

class WorkerFilterFactory {
  addFilter() {
    return 'none';
  }
  addHCMFilter() {
    return 'none';
  }
  addAlphaFilter() {
    return 'none';
  }
  addLuminosityFilter() {
    return 'none';
  }
  addKnockoutFilter() {
    return 'none';
  }
  addHighlightHCMFilter() {
    return 'none';
  }
  addSelectionHCMFilter() {
    return 'none';
  }
  addSelectionFilter() {
    return 'none';
  }
  createSelectionStyle() {
    return null;
  }
  destroy() {}
}

const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<PdfWorkerRequest>) => void) | null;
  postMessage: (message: PdfWorkerResponse, transfer?: Transferable[]) => void;
};

const activeStopSignals = new Map<number, { current: boolean }>();

const workerAdapter: PdfParserRuntimeAdapter = {
  createCanvas: (width: number, height: number): PdfCanvasLike =>
    new OffscreenCanvas(
      normalizeCanvasDimension(width),
      normalizeCanvasDimension(height)
    ) as unknown as PdfCanvasLike,
  canvasToJpegBytes: async (canvas: PdfCanvasLike, quality = 0.86): Promise<Uint8Array> => {
    const offscreen = canvas as unknown as OffscreenCanvas;
    const blob = await offscreen.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
  },
  documentOptions: {
    CanvasFactory: WorkerCanvasFactory,
    FilterFactory: WorkerFilterFactory,
    disableFontFace: true,
    useWorkerFetch: false,
  },
  pageYieldMs: 0,
  isWorker: true,
};

function collectAssetTransferables(result: ParsedPdfData): Transferable[] {
  const seen = new Set<ArrayBuffer>();
  const transferList: Transferable[] = [];
  for (const asset of Object.values(result.assets || {})) {
    const buf = asset?.data?.buffer;
    if (buf instanceof ArrayBuffer && !seen.has(buf)) {
      seen.add(buf);
      transferList.push(buf);
    }
  }
  return transferList;
}

workerScope.onmessage = async (event: MessageEvent<PdfWorkerRequest>) => {
  const payload = event.data;
  if (!payload) return;

  if (payload.type === 'cancel') {
    const signal = activeStopSignals.get(payload.id);
    if (signal) signal.current = true;
    return;
  }

  if (payload.type === 'parse') {
    const stopSignal = { current: false };
    activeStopSignals.set(payload.id, stopSignal);

    try {
      const result = await parseDigitalPdfCore(
        payload.buffer,
        payload.fileName,
        workerAdapter,
        (currentPage, totalPages) => {
          workerScope.postMessage({
            type: 'progress',
            id: payload.id,
            currentPage,
            totalPages,
          });
        },
        stopSignal
      );

      const transferables = collectAssetTransferables(result);
      workerScope.postMessage(
        {
          type: 'done',
          id: payload.id,
          result,
        },
        transferables
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Lỗi tách trang PDF trong Worker.';
      const isExpectedContentOrCancelError =
        stopSignal.current ||
        message.includes('bản scan ảnh') ||
        message.includes('không có trang nào') ||
        message.includes('mật khẩu') ||
        message.includes('Đã hủy');

      workerScope.postMessage({
        type: 'error',
        id: payload.id,
        message,
        canFallbackToMainThread: !isExpectedContentOrCancelError,
      });
    } finally {
      activeStopSignals.delete(payload.id);
    }
    return;
  }

  if (payload.type === 'extract-assets') {
    const stopSignal = { current: false };
    activeStopSignals.set(payload.id, stopSignal);
    const bytesCopy = new Uint8Array(payload.buffer);
    const loadingTask = pdfjsLib.getDocument({
      data: bytesCopy,
      ...(workerAdapter.documentOptions || {}),
    } as any);

    try {
      const pdfDoc = await loadingTask.promise;
      const assets: Record<string, PdfExtractedAsset> = {};
      const total = payload.pages.length;

      for (let i = 0; i < total; i++) {
        if (stopSignal.current) {
          throw new Error('Đã hủy trích xuất ảnh.');
        }
        const p = payload.pages[i];
        try {
          const pageProxy = await pdfDoc.getPage(p.pageNumber);
          const baseVp = pageProxy.getViewport({ scale: 1 });
          const cropped = await cropFiguresFromPage(
            pageProxy,
            p.pageNumber,
            baseVp,
            p.figureBoxes || [],
            workerAdapter
          );
          for (const c of cropped) {
            assets[c.asset.assetId] = c.asset;
          }
        } catch (err) {
          console.warn(`[PdfWorker] Bỏ qua trích xuất ảnh trang ${p.pageNumber}:`, err);
        }

        workerScope.postMessage({
          type: 'progress',
          id: payload.id,
          currentPage: i + 1,
          totalPages: total,
        });
        await yieldToEventLoopFast(false);
      }

      const seen = new Set<ArrayBuffer>();
      const transferables: Transferable[] = [];
      for (const asset of Object.values(assets)) {
        const buf = asset?.data?.buffer;
        if (buf instanceof ArrayBuffer && !seen.has(buf)) {
          seen.add(buf);
          transferables.push(buf);
        }
      }

      workerScope.postMessage(
        {
          type: 'assets-done',
          id: payload.id,
          assets,
        },
        transferables
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Lỗi trích xuất ảnh PDF trong Worker.';
      workerScope.postMessage({
        type: 'error',
        id: payload.id,
        message,
        canFallbackToMainThread: !stopSignal.current,
      });
    } finally {
      await loadingTask.destroy().catch(() => {});
      activeStopSignals.delete(payload.id);
    }
  }
};
