import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { Share } from '@capacitor/share';

export interface SavedEpubResult {
  fileName: string;
  locationLabel: string;
  fileUri?: string;
  isNative: boolean;
}

export function buildVietnameseBookFileName(
  bookTitleWithOptionalSuffix: string,
  originalFileName: string,
  ext: 'epub' | 'pdf' = 'epub'
): string {
  const cleanOrig = (originalFileName || '')
    .replace(/\.(epub|pdf)$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cleanTitle = (bookTitleWithOptionalSuffix || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Ưu tiên giữ nguyên tên file gốc nếu có ý nghĩa (tránh tên chỉ toàn số hoặc rỗng)
  const hasMeaningfulOrigName = cleanOrig.length > 0 && /\p{L}/u.test(cleanOrig);
  const rawBase = (hasMeaningfulOrigName ? cleanOrig : cleanTitle || 'sach')
    .replace(/_vn$/i, '')
    .trim();

  const base = (rawBase || 'sach').slice(0, 180).trim();
  return `${base}_VN.${ext}`;
}

export function buildVietnameseEpubFileName(
  bookTitleWithOptionalSuffix: string,
  originalFileName: string
): string {
  return buildVietnameseBookFileName(bookTitleWithOptionalSuffix, originalFileName, 'epub');
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || '');
      const commaIdx = res.indexOf(',');
      if (commaIdx === -1) {
        reject(new Error('Không thể mã hóa dữ liệu file EPUB.'));
        return;
      }
      resolve(res.slice(commaIdx + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('Lỗi đọc dữ liệu EPUB.'));
    reader.readAsDataURL(blob);
  });
}

function triggerWebBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1500);
}

const NATIVE_WRITE_CHUNK_BYTES = 786_432; // 768 KiB (chia hết cho 3 cho base64 sạch, giảm tải bridge Android)

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function writeBlobToDirectoryChunked(
  directory: Directory,
  path: string,
  blob: Blob,
  onChunkProgress?: (writtenBytes: number, totalBytes: number) => void
): Promise<string> {
  const totalBytes = blob.size;
  if (totalBytes <= NATIVE_WRITE_CHUNK_BYTES) {
    const base64Data = await blobToBase64(blob);
    const res = await Filesystem.writeFile({
      path,
      data: base64Data,
      directory,
      recursive: true,
    });
    onChunkProgress?.(totalBytes, totalBytes);
    return res.uri;
  }

  let fileUri = '';
  let offset = 0;
  let chunkIndex = 0;

  try {
    while (offset < totalBytes) {
      const end = Math.min(totalBytes, offset + NATIVE_WRITE_CHUNK_BYTES);
      const chunkBlob = blob.slice(offset, end);
      const chunkBase64 = await blobToBase64(chunkBlob);

      if (chunkIndex === 0) {
        const res = await Filesystem.writeFile({
          path,
          data: chunkBase64,
          directory,
          recursive: true,
        });
        fileUri = res.uri;
      } else {
        await Filesystem.appendFile({
          path,
          data: chunkBase64,
          directory,
        });
      }

      offset = end;
      chunkIndex += 1;
      onChunkProgress?.(offset, totalBytes);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    return fileUri;
  } catch (err) {
    if (chunkIndex > 0) {
      await Filesystem.deleteFile({ path, directory }).catch(() => {});
    }
    throw err;
  }
}

/**
 * Lưu file .epub / .pdf đã dịch vào thư mục Download trên máy Android (Capacitor)
 * hoặc tải xuống trực tiếp trên trình duyệt Web.
 */
export async function saveTranslatedEpubToDevice(
  blob: Blob,
  fileName: string,
  onProgress?: (progress: { stage: string; current: number; total: number; percent: number }) => void
): Promise<SavedEpubResult> {
  const safeName = fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');

  if (!Capacitor.isNativePlatform()) {
    onProgress?.({
      stage: `Đang tải xuống (${formatMb(blob.size)})...`,
      current: 1,
      total: 1,
      percent: 96,
    });
    triggerWebBlobDownload(blob, safeName);
    return {
      fileName: safeName,
      locationLabel: `Thư mục Tải xuống (Downloads)/${safeName}`,
      isNative: false,
    };
  }

  try {
    const permStatus = await Filesystem.checkPermissions();
    if (permStatus.publicStorage !== 'granted') {
      await Filesystem.requestPermissions().catch(() => {});
    }
  } catch {}

  const reportWriteProgress = (written: number, total: number) => {
    const writePct = total > 0 ? Math.round((written / total) * 100) : 100;
    onProgress?.({
      stage: `Đang ghi tệp vào máy (${formatMb(written)} / ${formatMb(total)} · ${writePct}%)...`,
      current: written,
      total,
      percent: Math.min(99, 88 + Math.round((writePct / 100) * 11)),
    });
  };

  onProgress?.({
    stage: `Đang ghi tệp vào máy (${formatMb(blob.size)})...`,
    current: 0,
    total: blob.size,
    percent: 88,
  });

  // Ưu tiên 1: Ghi trực tiếp theo luồng từng mảnh vào thư mục Download công khai của máy Android
  try {
    const uri = await writeBlobToDirectoryChunked(
      Directory.ExternalStorage,
      `Download/${safeName}`,
      blob,
      reportWriteProgress
    );
    return {
      fileName: safeName,
      locationLabel: `Download/${safeName}`,
      fileUri: uri,
      isNative: true,
    };
  } catch (extErr) {
    console.warn('[EpubSaver] Không ghi trực tiếp được vào ExternalStorage/Download, thử Documents:', extErr);
  }

  // Ưu tiên 2: Thư mục Documents (trên Android 11+ scoped storage)
  try {
    const uri = await writeBlobToDirectoryChunked(
      Directory.Documents,
      safeName,
      blob,
      reportWriteProgress
    );
    return {
      fileName: safeName,
      locationLabel: `Documents/${safeName}`,
      fileUri: uri,
      isNative: true,
    };
  } catch (docErr) {
    console.warn('[EpubSaver] Fallback sang Cache để chia sẻ:', docErr);
  }

  // Ưu tiên 3: Cache + Share / Open
  const cacheUri = await writeBlobToDirectoryChunked(
    Directory.Cache,
    safeName,
    blob,
    reportWriteProgress
  );

  return {
    fileName: safeName,
    locationLabel: `Bộ nhớ đệm ứng dụng (${safeName})`,
    fileUri: cacheUri,
    isNative: true,
  };
}

export async function openSavedEpubFile(
  fileUri?: string,
  fileName?: string
): Promise<boolean> {
  if (!fileUri) return false;
  const isPdf = /\.pdf$/i.test(fileName || fileUri);
  try {
    await FileOpener.open({
      filePath: fileUri,
      contentType: isPdf ? 'application/pdf' : 'application/epub+zip',
      openWithDefault: false,
    });
    return true;
  } catch (err) {
    console.warn('[BookSaver] FileOpener lỗi, thử chuyển sang Share:', err);
    return shareSavedEpubFile(fileUri, fileName || (isPdf ? 'Sách PDF Tiếng Việt' : 'Sách EPUB Tiếng Việt'));
  }
}

export async function shareSavedEpubFile(
  fileUri?: string,
  title = 'Sách Tiếng Việt'
): Promise<boolean> {
  if (!fileUri) return false;
  try {
    await Share.share({
      title,
      text: title,
      url: fileUri,
      dialogTitle: 'Lưu hoặc mở sách',
    });
    return true;
  } catch (err) {
    console.warn('[BookSaver] Share lỗi:', err);
    return false;
  }
}
