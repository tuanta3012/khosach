import { BookRecord, LibrarySettings } from '../types';
import { getStoredGeminiApiKeys, saveStoredGeminiApiKeys } from '../services/geminiService';

export const BOOKS_STORAGE_KEY = 'local_books_cache_v2';
export const SETTINGS_STORAGE_KEY = 'library_settings_v2';
export const LAST_SYNC_KEY = 'local_drive_last_sync_timestamp';
export const BOOK_MUTATION_QUEUE_KEY = 'book_mutation_queue_v1';
export const MASTER_RESTORE_REQUIRED_KEY = 'library_master_restore_required_v1';

// Kiểu biến động dữ liệu khi thao tác ngoại tuyến
export interface BookMutation {
  id: string;
  type: 'CREATE' | 'UPDATE' | 'DELETE';
  bookId: string;
  book?: BookRecord;
  timestamp: number;
}

// Danh mục mặc định
export const DEFAULT_CATEGORIES = [
  'Văn học Việt Nam',
  'Văn học kinh điển',
  'Văn học thiếu nhi',
  'Tiểu thuyết lãng mạn',
  'Trinh thám',
  'Giả tưởng',
  'Lịch sử',
  'Triết học',
  'Tâm lý',
  'Khoa học',
  'Hồi ký',
  'Tản văn',
  'Kinh tế',
  'Chung',
];

export const DEFAULT_SETTINGS: LibrarySettings = {
  autoEnrichEnabled: false,
  categoriesList: DEFAULT_CATEGORIES,
  autoNormalizeEnabled: false,
};

/**
 * HÀNG ĐỢI MUTATION NGOẠI TUYẾN (OFFLINE MUTATION QUEUE)
 */
export function getPendingBookMutations(): BookMutation[] {
  try {
    const raw = localStorage.getItem(BOOK_MUTATION_QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('[MutationQueue] Lỗi đọc queue:', err);
  }
  return [];
}

export function enqueueBookMutation(
  type: 'CREATE' | 'UPDATE' | 'DELETE',
  bookId: string,
  book?: BookRecord
): void {
  try {
    const current = getPendingBookMutations();
    // Tạo id duy nhất cho mutation
    const mutationId = `mut_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    // Nếu là UPDATE và đã có CREATE hoặc UPDATE chưa sync cho bookId này, gộp lại
    const existingIndex = current.findIndex((m) => m.bookId === bookId);
    if (existingIndex !== -1 && type === 'UPDATE') {
      const existing = current[existingIndex];
      if (existing.type === 'CREATE') {
        current[existingIndex] = {
          ...existing,
          book: book || existing.book,
          timestamp: Date.now(),
        };
        localStorage.setItem(BOOK_MUTATION_QUEUE_KEY, JSON.stringify(current));
        return;
      }
    } else if (existingIndex !== -1 && type === 'DELETE') {
      const existing = current[existingIndex];
      // Nếu vừa mới CREATE ở local và chưa sync mà đã DELETE, chỉ cần xóa khỏi queue
      if (existing.type === 'CREATE') {
        current.splice(existingIndex, 1);
        localStorage.setItem(BOOK_MUTATION_QUEUE_KEY, JSON.stringify(current));
        return;
      }
    }

    current.push({
      id: mutationId,
      type,
      bookId,
      book,
      timestamp: Date.now(),
    });

    localStorage.setItem(BOOK_MUTATION_QUEUE_KEY, JSON.stringify(current));
  } catch (err) {
    console.warn('[MutationQueue] Lỗi ghi queue:', err);
  }
}

export function removePendingBookMutationsByIds(ids: string[]): void {
  try {
    const current = getPendingBookMutations();
    const idSet = new Set(ids);
    const filtered = current.filter((m) => !idSet.has(m.id));
    localStorage.setItem(BOOK_MUTATION_QUEUE_KEY, JSON.stringify(filtered));
  } catch (err) {
    console.warn('[MutationQueue] Lỗi dọn queue:', err);
  }
}

export function clearPendingBookMutations(): void {
  try {
    localStorage.removeItem(BOOK_MUTATION_QUEUE_KEY);
  } catch {}
}

/**
 * CỜ BẢO VỆ MASTER: Tránh việc xóa dữ liệu local đẩy mảng rỗng lên xóa sạch Master Sheet
 */
export function isMasterRestoreRequired(): boolean {
  try {
    return localStorage.getItem(MASTER_RESTORE_REQUIRED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setMasterRestoreRequired(required: boolean): void {
  try {
    if (required) {
      localStorage.setItem(MASTER_RESTORE_REQUIRED_KEY, 'true');
    } else {
      localStorage.removeItem(MASTER_RESTORE_REQUIRED_KEY);
    }
  } catch {}
}

// Bộ nhớ đệm RAM tức thì (in-memory cache) tránh JSON.parse lặp đi lặp lại
let inMemoryBooksCache: BookRecord[] | null = null;

/**
 * Làm sạch và chuẩn hóa đối tượng sách trước khi lưu nhằm tối ưu dung lượng LocalStorage
 */
export function sanitizeBookRecord(book: BookRecord): BookRecord {
  return {
    id: String(book.id || `book_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`),
    title: String(book.title || '').trim(),
    author: String(book.author || 'Chưa rõ').trim(),
    category: String(book.category || 'Chung').trim(),
    publisher: String(book.publisher || '').trim(),
    is_ai_normalized: !!book.is_ai_normalized,
    created_at: Number(book.created_at) || Date.now(),
    updated_at: Number(book.updated_at) || Date.now(),
  };
}

/**
 * 1. NẠP TOÀN BỘ SÁCH TỪ BỘ NHỚ MÁY (LOCAL STORAGE) - Tối ưu 0ms với Cache RAM
 */
export function loadLocalBooks(): BookRecord[] {
  if (inMemoryBooksCache !== null) {
    return inMemoryBooksCache;
  }
  try {
    const raw = localStorage.getItem(BOOKS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        inMemoryBooksCache = parsed;
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[LocalStorage] Lỗi đọc bộ nhớ máy:', err);
  }
  inMemoryBooksCache = [];
  return [];
}

/**
 * 2. LƯU TOÀN BỘ SÁCH VÀO BỘ NHỚ MÁY - Xử lý an toàn chống lỗi tràn bộ nhớ (QuotaExceeded)
 */
export function saveAllLocalBooks(books: BookRecord[]): void {
  const sanitized = books.map(sanitizeBookRecord);
  inMemoryBooksCache = sanitized;

  try {
    const serialized = JSON.stringify(sanitized);
    localStorage.setItem(BOOKS_STORAGE_KEY, serialized);
    
    // Phát sự kiện để đồng bộ giữa các components
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('local-books-changed', { detail: { count: sanitized.length } }));
    }
  } catch (err: any) {
    console.error('[LocalStorage] Lỗi ghi sách vào bộ nhớ máy:', err);
    // Nếu gặp lỗi bộ nhớ đầy (QuotaExceededError)
    if (err?.name === 'QuotaExceededError' || err?.code === 22) {
      console.warn('[LocalStorage] QuotaExceeded: Đang dọn dẹp bộ nhớ đệm phụ...');
      try {
        localStorage.removeItem('local_drive_cache_sheets_list');
        localStorage.removeItem('last_detected_dup_signatures');
        localStorage.setItem(BOOKS_STORAGE_KEY, JSON.stringify(sanitized));
      } catch (retryErr) {
        console.error('[LocalStorage] Thử lại sau dọn dẹp vẫn thất bại:', retryErr);
      }
    }
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
    enqueueBookMutation('UPDATE', cleanBook.id, cleanBook);
  } else {
    updated = [cleanBook, ...current];
    enqueueBookMutation('CREATE', cleanBook.id, cleanBook);
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
  enqueueBookMutation('DELETE', id);
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
  idsToDelete.forEach((id) => enqueueBookMutation('DELETE', id));
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
    const isNew = !map.has(b.id);
    const item: BookRecord = {
      ...b,
      title: String(b.title || '').trim(),
      author: String(b.author || 'Chưa rõ').trim(),
      category: String(b.category || 'Chung').trim(),
      publisher: String(b.publisher || '').trim(),
      updated_at: b.updated_at || Date.now(),
      created_at: b.created_at || Date.now(),
    };
    map.set(b.id, item);
    enqueueBookMutation(isNew ? 'CREATE' : 'UPDATE', item.id, item);
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
    inMemoryBooksCache = [];
    localStorage.removeItem(BOOKS_STORAGE_KEY);
    // Đánh dấu cờ cần phục hồi từ Master Sheet: chống việc xóa sạch trên máy đẩy mảng rỗng xóa sạch file chung
    setMasterRestoreRequired(true);
    clearPendingBookMutations();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('local-books-changed', { detail: { count: 0 } }));
    }
  } catch {}
}

/**
 * 8. NẠP CẤU HÌNH KHO SÁCH TỪ BỘ NHỚ MÁY
 */
export function loadLocalSettings(): LibrarySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const storedKeys = getStoredGeminiApiKeys();
    if (raw) {
      const parsed = JSON.parse(raw);
      const keys = (parsed.geminiApiKeys && parsed.geminiApiKeys.length > 0)
        ? parsed.geminiApiKeys
        : storedKeys;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        geminiApiKeys: keys,
        autoNormalizeEnabled: parsed.autoNormalizeEnabled ?? false,
        categoriesList: parsed.categoriesList || DEFAULT_CATEGORIES,
      };
    } else if (storedKeys.length > 0) {
      return {
        ...DEFAULT_SETTINGS,
        geminiApiKeys: storedKeys,
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
    if (settings.geminiApiKeys && settings.geminiApiKeys.length > 0) {
      saveStoredGeminiApiKeys(settings.geminiApiKeys);
    }
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
export function setLastDriveSyncTimestamp(ts: number = Date.now(), spreadsheetId?: string): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(ts));
    if (spreadsheetId) {
      localStorage.setItem(`sheet_synced_${spreadsheetId}`, String(ts));
      localStorage.setItem('last_synced_spreadsheet_id', spreadsheetId);
    }
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

/**
 * 11. THỐNG KÊ DUNG LƯỢNG & SỨC KHỎE BỘ NHỚ LOCALSTORAGE
 */
export interface LocalStorageHealth {
  totalBooks: number;
  estimatedBytes: number;
  formattedSize: string;
  pendingMutationCount: number;
}

export function getLocalStorageHealth(): LocalStorageHealth {
  try {
    const rawBooks = localStorage.getItem(BOOKS_STORAGE_KEY) || '[]';
    const rawQueue = localStorage.getItem(BOOK_MUTATION_QUEUE_KEY) || '[]';
    // Ước tính dung lượng UTF-16 (mỗi ký tự 2 bytes)
    const estimatedBytes = (rawBooks.length + rawQueue.length) * 2;
    const books = loadLocalBooks();
    const pending = getPendingBookMutations();

    let formattedSize = '';
    if (estimatedBytes < 1024) {
      formattedSize = `${estimatedBytes} B`;
    } else if (estimatedBytes < 1024 * 1024) {
      formattedSize = `${(estimatedBytes / 1024).toFixed(1)} KB`;
    } else {
      formattedSize = `${(estimatedBytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    return {
      totalBooks: books.length,
      estimatedBytes,
      formattedSize,
      pendingMutationCount: pending.length,
    };
  } catch {
    return {
      totalBooks: 0,
      estimatedBytes: 0,
      formattedSize: '0 KB',
      pendingMutationCount: 0,
    };
  }
}
