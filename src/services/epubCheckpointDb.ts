import {
  EpubGenreId,
  EpubTranslationJob,
  PdfOutputFormat,
  PdfProcessingMode,
  PdfTranslatedBlock,
  PdfTranslationUnit,
} from '../types';

const DB_NAME = 'kho_sach_epub_translator_v1';
const DB_VERSION = 1;
const STORE_NAME = 'jobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB không khả dụng trên trình duyệt này.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'jobId' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Không mở được IndexedDB.'));
  });
}

export function buildEpubJobId(fileName: string, fileSize: number, lastModified: number): string {
  return `epub_${fileName.trim()}_${fileSize}_${lastModified}`;
}

export function buildPdfJobId(fileName: string, fileSize: number, lastModified: number): string {
  return `pdf_${fileName.trim()}_${fileSize}_${lastModified}`;
}

export async function saveEpubJob(job: EpubTranslationJob): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(job);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[EpubCheckpointDB] Lỗi lưu job:', err);
  }
}

export async function getEpubJobById(jobId: string): Promise<EpubTranslationJob | null> {
  try {
    const db = await openDb();
    const res = await new Promise<EpubTranslationJob | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(jobId);
      req.onsuccess = () => resolve((req.result as EpubTranslationJob) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return res;
  } catch (err) {
    console.warn('[EpubCheckpointDB] Lỗi đọc job:', err);
    return null;
  }
}

export async function loadLatestEpubJob(): Promise<EpubTranslationJob | null> {
  try {
    const db = await openDb();
    const res = await new Promise<EpubTranslationJob | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = (req.result as EpubTranslationJob[]) || [];
        if (list.length === 0) {
          resolve(null);
          return;
        }
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(list[0]);
      };
      req.onerror = () => reject(req.error);
    });
    db.close();
    return res;
  } catch (err) {
    console.warn('[EpubCheckpointDB] Lỗi nạp job gần nhất:', err);
    return null;
  }
}

/**
 * Ghi nhận an toàn kết quả của 1 chunk vào IndexedDB trong 1 transaction readwrite duy nhất
 * để tránh xung đột khi nhiều API Key Worker hoàn thành song song cùng lúc.
 */
export async function recordChunkCheckpoint(
  jobId: string,
  chunkIndex: number,
  translatedMapUpdates: Record<number, string>
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(jobId);
      getReq.onsuccess = () => {
        const existing = getReq.result as EpubTranslationJob | undefined;
        if (!existing) {
          resolve();
          return;
        }
        const completedSet = new Set(existing.completedChunkIds || []);
        completedSet.add(chunkIndex);

        const failedSet = new Set(existing.failedChunkIds || []);
        failedSet.delete(chunkIndex);

        const nextJob: EpubTranslationJob = {
          ...existing,
          translatedSegments: {
            ...(existing.translatedSegments || {}),
            ...translatedMapUpdates,
          },
          completedChunkIds: Array.from(completedSet),
          failedChunkIds: Array.from(failedSet),
          updatedAt: Date.now(),
        };
        store.put(nextJob);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[EpubCheckpointDB] Lỗi ghi checkpoint chunk:', err);
  }
}

export async function recordPdfUnitCheckpoint(
  jobId: string,
  unitIndex: number,
  pageUpdates: Record<number, PdfTranslatedBlock[]>
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(jobId);
      getReq.onsuccess = () => {
        const existing = getReq.result as EpubTranslationJob | undefined;
        if (!existing) {
          resolve();
          return;
        }
        const completedSet = new Set(existing.completedChunkIds || []);
        completedSet.add(unitIndex);

        const failedSet = new Set(existing.failedChunkIds || []);
        failedSet.delete(unitIndex);

        const nextJob: EpubTranslationJob = {
          ...existing,
          translatedPdfPages: {
            ...(existing.translatedPdfPages || {}),
            ...pageUpdates,
          },
          completedChunkIds: Array.from(completedSet),
          failedChunkIds: Array.from(failedSet),
          updatedAt: Date.now(),
        };
        store.put(nextJob);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[EpubCheckpointDB] Lỗi ghi checkpoint PDF unit:', err);
  }
}

export async function updateEpubJobMetadata(
  jobId: string,
  updates: Partial<{
    genre: EpubGenreId;
    customNotes: string;
    status: EpubTranslationJob['status'];
    failedChunkIds: number[];
    completedChunkIds: number[];
    translatedSegments: Record<number, string>;
    pdfOutputFormat: PdfOutputFormat;
    pdfProcessingMode: PdfProcessingMode;
    pdfUnits: PdfTranslationUnit[];
    translatedPdfPages: Record<number, PdfTranslatedBlock[]>;
    lastError?: string;
  }>
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(jobId);
      getReq.onsuccess = () => {
        const existing = getReq.result as EpubTranslationJob | undefined;
        if (!existing) {
          resolve();
          return;
        }
        store.put({
          ...existing,
          ...updates,
          updatedAt: Date.now(),
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[EpubCheckpointDB] Lỗi cập nhật metadata job:', err);
  }
}

export async function deleteEpubJob(jobId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(jobId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[EpubCheckpointDB] Lỗi xóa job:', err);
  }
}
