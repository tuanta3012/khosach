import { BookRecord, LibrarySettings } from '../types';
import { USER_MASTER_BOOKS } from '../data/sampleBooks';

const BOOKS_STORAGE_KEY = 'local_books_cache_v2';
const SETTINGS_STORAGE_KEY = 'library_settings_v2';
const LAST_SYNC_KEY = 'local_drive_last_sync_timestamp';

// Danh mục mặc định từ 591 cuốn sách gốc
export const DEFAULT_CATEGORIES = Array.from(
  new Set(USER_MASTER_BOOKS.map((b) => b.category || 'Chung').filter(Boolean))
);

export const DEFAULT_SETTINGS: LibrarySettings = {
  autoEnrichEnabled: true,
  categoriesList: DEFAULT_CATEGORIES,
  autoNormalizeEnabled: false,
};

/**
 * 1. NẠP TOÀN BỘ SÁCH TỪ BỘ NHỚ MÁY (LOCAL STORAGE)
 * Nếu chưa từng lưu gì, khởi tạo mặc định 591 cuốn sách gốc
 */
export function loadLocalBooks(): BookRecord[] {
  try {
    const raw = localStorage.getItem(BOOKS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[LocalStorage] Lỗi đọc bộ nhớ máy, khởi tạo sách gốc:', err);
  }
  // Mặc định nạp 591 cuốn sách gốc
  saveAllLocalBooks(USER_MASTER_BOOKS);
  return USER_MASTER_BOOKS;
}

/**
 * 2. LƯU TOÀN BỘ SÁCH VÀO BỘ NHỚ MÁY
 */
export function saveAllLocalBooks(books: BookRecord[]): void {
  try {
    localStorage.setItem(BOOKS_STORAGE_KEY, JSON.stringify(books));
    // Phát sự kiện để đồng bộ giữa các components nếu cần
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('local-books-changed', { detail: { count: books.length } }));
    }
  } catch (err) {
    console.error('[LocalStorage] Lỗi ghi sách vào bộ nhớ máy:', err);
  }
}

/**
 * 3. THÊM HOẶC CẬP NHẬT 1 CUỐN SÁCH
 */
export function upsertLocalBook(book: BookRecord): BookRecord[] {
  const current = loadLocalBooks();
  const index = current.findIndex((b) => b.id === book.id);
  let updated: BookRecord[];
  
  const cleanBook: BookRecord = {
    ...book,
    title: String(book.title || '').trim(),
    author: String(book.author || 'Chưa rõ').trim(),
    category: String(book.category || 'Chung').trim(),
    publisher: String(book.publisher || '').trim(),
    updated_at: Date.now(),
    created_at: book.created_at || Date.now(),
  };

  if (index !== -1) {
    updated = [...current];
    updated[index] = cleanBook;
  } else {
    updated = [cleanBook, ...current];
  }

  saveAllLocalBooks(updated);
  return updated;
}

/**
 * 4. XÓA 1 CUỐN SÁCH THEO ID
 */
export function deleteLocalBook(id: string): BookRecord[] {
  const current = loadLocalBooks();
  const updated = current.filter((b) => b.id !== id);
  saveAllLocalBooks(updated);
  return updated;
}

/**
 * 4b. XÓA HÀNG LOẠT CUỐN SÁCH THEO DANH SÁCH ID (Dùng khi lọc trùng hoặc dọn dẹp)
 */
export function batchDeleteLocalBooks(idsToDelete: string[]): BookRecord[] {
  const current = loadLocalBooks();
  const deleteSet = new Set(idsToDelete);
  const updated = current.filter((b) => !deleteSet.has(b.id));
  saveAllLocalBooks(updated);
  return updated;
}

/**
 * 5. LƯU HÀNG LOẠT SÁCH (BATCH UPSERT)
 */
export function batchUpsertLocalBooks(newOrUpdatedBooks: BookRecord[]): BookRecord[] {
  const current = loadLocalBooks();
  const map = new Map<string, BookRecord>();
  
  current.forEach((b) => map.set(b.id, b));
  newOrUpdatedBooks.forEach((b) => {
    map.set(b.id, {
      ...b,
      title: String(b.title || '').trim(),
      author: String(b.author || 'Chưa rõ').trim(),
      category: String(b.category || 'Chung').trim(),
      publisher: String(b.publisher || '').trim(),
      updated_at: b.updated_at || Date.now(),
      created_at: b.created_at || Date.now(),
    });
  });

  const updated = Array.from(map.values());
  saveAllLocalBooks(updated);
  return updated;
}

/**
 * 6. XÓA TOÀN BỘ SÁCH
 */
export function clearAllLocalBooks(): void {
  try {
    localStorage.removeItem(BOOKS_STORAGE_KEY);
  } catch {}
}

/**
 * 7. KHÔI PHỤC LẠI 591 CUỐN SÁCH GỐC
 */
export function resetLocalToMasterBooks(): BookRecord[] {
  saveAllLocalBooks(USER_MASTER_BOOKS);
  return USER_MASTER_BOOKS;
}

/**
 * 8. NẠP CẤU HÌNH KHO SÁCH TỪ BỘ NHỚ MÁY
 */
export function loadLocalSettings(): LibrarySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        autoNormalizeEnabled: parsed.autoNormalizeEnabled ?? false,
        categoriesList: parsed.categoriesList || DEFAULT_CATEGORIES,
      };
    }
  } catch (err) {
    console.warn('[LocalStorage] Lỗi đọc cài đặt:', err);
  }
  return DEFAULT_SETTINGS;
}

/**
 * 9. LƯU CẤU HÌNH KHO SÁCH VÀO BỘ NHỚ MÁY
 */
export function saveLocalSettings(settings: LibrarySettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    if (settings.driveSyncUrl) {
      localStorage.setItem('drive_sync_url_v1', settings.driveSyncUrl);
    }
    if (settings.driveTargetFileUrl) {
      localStorage.setItem('drive_target_file_url_v1', settings.driveTargetFileUrl);
    }
  } catch (err) {
    console.error('[LocalStorage] Lỗi ghi cài đặt:', err);
  }
}

/**
 * 10. QUẢN LÝ THỜI GIAN ĐỒNG BỘ GOOGLE DRIVE GẦN NHẤT
 */
export function setLastDriveSyncTimestamp(ts: number = Date.now()): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(ts));
  } catch {}
}

export function getLastDriveSyncTimestamp(): number | null {
  try {
    const raw = localStorage.getItem(LAST_SYNC_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}
