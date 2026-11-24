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

/**
 * Lưu file .epub đã dịch vào thư mục Download trên máy Android (Capacitor)
 * hoặc tải xuống trực tiếp trên trình duyệt Web.
 */
export async function saveTranslatedEpubToDevice(
  blob: Blob,
  fileName: string
): Promise<SavedEpubResult> {
  const safeName = fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');

  if (!Capacitor.isNativePlatform()) {
    triggerWebBlobDownload(blob, safeName);
    return {
      fileName: safeName,
      locationLabel: `Thư mục Tải xuống (Downloads)/${safeName}`,
      isNative: false,
    };
  }

  const base64Data = await blobToBase64(blob);

  try {
    const permStatus = await Filesystem.checkPermissions();
    if (permStatus.publicStorage !== 'granted') {
      await Filesystem.requestPermissions().catch(() => {});
    }
  } catch {}

  // Ưu tiên 1: Ghi trực tiếp vào thư mục Download công khai của máy Android
  try {
    const writeRes = await Filesystem.writeFile({
      path: `Download/${safeName}`,
      data: base64Data,
      directory: Directory.ExternalStorage,
      recursive: true,
    });
    return {
      fileName: safeName,
      locationLabel: `Download/${safeName}`,
      fileUri: writeRes.uri,
      isNative: true,
    };
  } catch (extErr) {
    console.warn('[EpubSaver] Không ghi trực tiếp được vào ExternalStorage/Download, thử Documents:', extErr);
  }

  // Ưu tiên 2: Thư mục Documents (trên Android 11+ scoped storage)
  try {
    const docRes = await Filesystem.writeFile({
      path: safeName,
      data: base64Data,
      directory: Directory.Documents,
      recursive: true,
    });
    return {
      fileName: safeName,
      locationLabel: `Documents/${safeName}`,
      fileUri: docRes.uri,
      isNative: true,
    };
  } catch (docErr) {
    console.warn('[EpubSaver] Fallback sang Cache để chia sẻ:', docErr);
  }

  // Ưu tiên 3: Cache + Share / Open
  const cacheRes = await Filesystem.writeFile({
    path: safeName,
    data: base64Data,
    directory: Directory.Cache,
    recursive: true,
  });

  return {
    fileName: safeName,
    locationLabel: `Bộ nhớ đệm ứng dụng (${safeName})`,
    fileUri: cacheRes.uri,
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
