import { BookRecord, DEFAULT_NORMALIZE_FIELDS, LibrarySettings, NormalizeFieldKey } from '../types';
import { getStoredGeminiApiKeys, saveStoredGeminiApiKeys } from '../services/geminiService';
import {
  clearLibraryDataInIdb,
  markLibraryMigratedInIdb,
  readLibrarySnapshotFromIdb,
  resetLibraryDbConnection,
  writeAllBooksToIdb,
  writeAllMutationsToIdb,
  writeInitialMigrationToIdb,
} from './booksIndexedDb';

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

// Danh mục mặc định mở rộng chi tiết (tối đa 20 thể loại gồm 'Chung')
export const DEFAULT_CATEGORIES = [
  'Văn học Việt Nam',
  'Văn học kinh điển',
  'Văn học hiện đại',
  'Văn học thiếu nhi',
  'Tiểu thuyết lãng mạn',
  'Trinh thám',
  'Giả tưởng',
  'Tản văn',
  'Hồi ký',
  'Lịch sử',
  'Triết học',
  'Tâm lý',
  'Kỹ năng sống',
  'Kinh tế',
  'Quản trị - Kinh doanh',
  'Khoa học',
  'Y học - Sức khỏe',
  'Giáo dục - Gia đình',
  'Nghệ thuật - Đời sống',
  'Chung',
];

const LEGACY_DEFAULT_CATEGORIES_SET = new Set([
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
]);

function resolveExpandedCategories(stored?: unknown): string[] {
  if (!Array.isArray(stored) || stored.length === 0) {
    return DEFAULT_CATEGORIES;
  }
  const cleanStored = Array.from(new Set(stored.map((c) => String(c || '').trim()).filter(Boolean)));
  if (cleanStored.length === 0) {
    return DEFAULT_CATEGORIES;
  }
  const isLegacyOnly = cleanStored.every((c) => LEGACY_DEFAULT_CATEGORIES_SET.has(c));
  if (isLegacyOnly) {
    return DEFAULT_CATEGORIES;
  }
  if (!cleanStored.includes('Chung')) {
    cleanStored.push('Chung');
  }
  return cleanStored;
}

const VALID_NORMALIZE_FIELDS = new Set<NormalizeFieldKey>(DEFAULT_NORMALIZE_FIELDS);

export function resolveNormalizeFields(raw?: unknown): NormalizeFieldKey[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_NORMALIZE_FIELDS];
  }
  const clean = Array.from(
    new Set(
      raw.filter((item): item is NormalizeFieldKey =>
        typeof item === 'string' && VALID_NORMALIZE_FIELDS.has(item as NormalizeFieldKey)
      )
    )
  );
  return clean.length > 0 ? clean : [...DEFAULT_NORMALIZE_FIELDS];
}

export const DEFAULT_SETTINGS: LibrarySettings = {
  autoEnrichEnabled: false,
  categoriesList: DEFAULT_CATEGORIES,
  autoNormalizeEnabled: false,
  normalizeFields: [...DEFAULT_NORMALIZE_FIELDS],
};

// Bộ nhớ đệm RAM tức thì (in-memory cache) đồng bộ 2 chiều với IndexedDB (không chặn UI)
let inMemoryBooksCache: BookRecord[] | null = null;
let inMemoryMutationsCache: BookMutation[] | null = null;
let booksWriteGeneration = 0;
let mutationsWriteGeneration = 0;
let initStoragePromise: Promise<BookRecord[]> | null = null;

// Hàng đợi ghi tuần tự xuống IndexedDB: luôn ghi snapshot mới nhất để tránh xung đột thứ tự
let booksIdbFlushInFlight: Promise<void> | null = null;
let booksIdbDirty = false;
let mutationsIdbFlushInFlight: Promise<void> | null = null;
let mutationsIdbDirty = false;

function scheduleBooksIdbFlush(): void {
  if (typeof indexedDB === 'undefined') return;
  booksIdbDirty = true;
  if (booksIdbFlushInFlight) return;

  booksIdbFlushInFlight = (async () => {
    while (booksIdbDirty) {
      booksIdbDirty = false;
      const snapshot = inMemoryBooksCache ? [...inMemoryBooksCache] : [];
      try {
        await writeAllBooksToIdb(snapshot);
      } catch (err) {
        console.warn('[IndexedDB] Lỗi lưu danh sách sách xuống IndexedDB:', err);
      }
    }
  })().finally(() => {
    booksIdbFlushInFlight = null;
    if (booksIdbDirty) {
      scheduleBooksIdbFlush();
    }
  });
}

function scheduleMutationsIdbFlush(): void {
  if (typeof indexedDB === 'undefined') return;
  mutationsIdbDirty = true;
  if (mutationsIdbFlushInFlight) return;

  mutationsIdbFlushInFlight = (async () => {
    while (mutationsIdbDirty) {
      mutationsIdbDirty = false;
      const snapshot = inMemoryMutationsCache ? [...inMemoryMutationsCache] : [];
      try {
        await writeAllMutationsToIdb(snapshot);
      } catch (err) {
        console.warn('[IndexedDB] Lỗi lưu hàng đợi mutation xuống IndexedDB:', err);
      }
    }
  })().finally(() => {
    mutationsIdbFlushInFlight = null;
    if (mutationsIdbDirty) {
      scheduleMutationsIdbFlush();
    }
  });
}

function readLegacyLocalBooks(): BookRecord[] {
  try {
    const raw = localStorage.getItem(BOOKS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('[LocalStorage] Lỗi đọc cache sách cũ:', err);
  }
  return [];
}

function readLegacyLocalMutations(): BookMutation[] {
  try {
    const raw = localStorage.getItem(BOOK_MUTATION_QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('[LocalStorage] Lỗi đọc mutation queue cũ:', err);
  }
  return [];
}

function removeLegacyStorageKeys(): void {
  try {
    localStorage.removeItem(BOOKS_STORAGE_KEY);
    localStorage.removeItem(BOOK_MUTATION_QUEUE_KEY);
  } catch {}
}

/**
 * Đặt lại bộ nhớ đệm RAM (dùng khi dọn sạch dữ liệu / Reset app)
 */
export function resetLocalBooksMemoryCache(): void {
  booksWriteGeneration += 1;
  mutationsWriteGeneration += 1;
  inMemoryBooksCache = [];
  inMemoryMutationsCache = [];
  booksIdbDirty = false;
  mutationsIdbDirty = false;
  initStoragePromise = null;
  resetLibraryDbConnection();
}

/**
 * Khởi tạo IndexedDB cho kho sách & tự động di chuyển dữ liệu cũ từ localStorage (1 lần duy nhất)
 */
export function initLocalBooksStorage(): Promise<BookRecord[]> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(loadLocalBooks());
  }
  if (initStoragePromise) {
    return initStoragePromise;
  }

  initStoragePromise = (async () => {
    const startBooksGen = booksWriteGeneration;
    const startMutGen = mutationsWriteGeneration;

    try {
      const snapshot = await readLibrarySnapshotFromIdb();
      const legacyBooks = readLegacyLocalBooks();
      const legacyMutations = readLegacyLocalMutations();

      if (!snapshot.hasMigrated) {
        if (legacyBooks.length > 0 || legacyMutations.length > 0) {
          const sanitizedLegacyBooks = legacyBooks.map(sanitizeBookRecord);
          await writeInitialMigrationToIdb(sanitizedLegacyBooks, legacyMutations);
          removeLegacyStorageKeys();

          if (booksWriteGeneration === startBooksGen) {
            inMemoryBooksCache = sanitizedLegacyBooks;
          } else {
            scheduleBooksIdbFlush();
          }

          if (mutationsWriteGeneration === startMutGen) {
            inMemoryMutationsCache = legacyMutations;
          } else {
            scheduleMutationsIdbFlush();
          }

          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('local-books-changed', {
                detail: { count: (inMemoryBooksCache || sanitizedLegacyBooks).length },
              })
            );
          }

          return inMemoryBooksCache || sanitizedLegacyBooks;
        }

        await markLibraryMigratedInIdb();
        removeLegacyStorageKeys();
      } else if (legacyBooks.length > 0 || legacyMutations.length > 0) {
        // Nếu còn sót key cũ từ phiên bản trước thì dọn sạch để tránh chiếm dung lượng localStorage
        removeLegacyStorageKeys();
      }

      if (booksWriteGeneration === startBooksGen) {
        inMemoryBooksCache = snapshot.books;
      } else {
        scheduleBooksIdbFlush();
      }

      if (mutationsWriteGeneration === startMutGen) {
        inMemoryMutationsCache = snapshot.mutations;
      } else {
        scheduleMutationsIdbFlush();
      }

      if (typeof window !== 'undefined' && snapshot.books.length > 0) {
        window.dispatchEvent(
          new CustomEvent('local-books-changed', {
            detail: { count: (inMemoryBooksCache || snapshot.books).length },
          })
        );
      }

      return inMemoryBooksCache || snapshot.books;
    } catch (err) {
      console.warn('[IndexedDB] Lỗi khởi tạo kho sách IndexedDB, dùng fallback bộ nhớ tạm:', err);
      return loadLocalBooks();
    }
  })();

  return initStoragePromise;
}

/**
 * HÀNG ĐỢI MUTATION NGOẠI TUYẾN (OFFLINE MUTATION QUEUE)
 */
export function getPendingBookMutations(): BookMutation[] {
  if (inMemoryMutationsCache !== null) {
    return inMemoryMutationsCache;
  }
  const legacy = readLegacyLocalMutations();
  inMemoryMutationsCache = legacy;
  return legacy;
}

function persistPendingBookMutations(nextQueue: BookMutation[]): void {
  mutationsWriteGeneration += 1;
  inMemoryMutationsCache = nextQueue;
  if (typeof indexedDB !== 'undefined') {
    scheduleMutationsIdbFlush();
    try {
      localStorage.removeItem(BOOK_MUTATION_QUEUE_KEY);
    } catch {}
    return;
  }
  try {
    localStorage.setItem(BOOK_MUTATION_QUEUE_KEY, JSON.stringify(nextQueue));
  } catch (err) {
    console.warn('[MutationQueue] Lỗi ghi queue:', err);
  }
}

export function enqueueBookMutation(
  type: 'CREATE' | 'UPDATE' | 'DELETE',
  bookId: string,
  book?: BookRecord
): void {
  try {
    const current = [...getPendingBookMutations()];
    const mutationId = `mut_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Nếu là UPDATE và đã có CREATE chưa sync cho bookId này, gộp lại
    const existingIndex = current.findIndex((m) => m.bookId === bookId);
    if (existingIndex !== -1 && type === 'UPDATE') {
      const existing = current[existingIndex];
      if (existing.type === 'CREATE') {
        current[existingIndex] = {
          ...existing,
          book: book || existing.book,
          timestamp: Date.now(),
        };
        persistPendingBookMutations(current);
        return;
      }
    } else if (existingIndex !== -1 && type === 'DELETE') {
      const existing = current[existingIndex];
      // Nếu vừa mới CREATE ở local và chưa sync mà đã DELETE, chỉ cần xóa khỏi queue
      if (existing.type === 'CREATE') {
        current.splice(existingIndex, 1);
        persistPendingBookMutations(current);
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

    persistPendingBookMutations(current);
  } catch (err) {
    console.warn('[MutationQueue] Lỗi ghi queue:', err);
  }
}

export function removePendingBookMutationsByIds(ids: string[]): void {
  try {
    const current = getPendingBookMutations();
    const idSet = new Set(ids);
    const filtered = current.filter((m) => !idSet.has(m.id));
    persistPendingBookMutations(filtered);
  } catch (err) {
    console.warn('[MutationQueue] Lỗi dọn queue:', err);
  }
}

export function clearPendingBookMutations(): void {
  try {
    persistPendingBookMutations([]);
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

export function parseCreatedTimestampFromBookId(bookId?: string): number {
  if (!bookId || typeof bookId !== 'string') return 0;
  const match = bookId.match(/^(?:book|imp)_(\d{12,15})(?:_|$)/);
  if (!match) return 0;
  const num = Number(match[1]);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * Làm sạch và chuẩn hóa đối tượng sách trước khi lưu
 */
export function sanitizeBookRecord(book: BookRecord): BookRecord {
  const now = Date.now();
  const cleanCover = typeof book.cover_url === 'string' ? book.cover_url.trim() : '';
  const cleanSummary = typeof book.summary === 'string' ? book.summary.trim() : '';
  const idStr = String(book.id || `book_${now}_${Math.random().toString(36).substring(2, 7)}`);
  const rawCreated = Number(book.created_at);
  const rawUpdated = Number(book.updated_at);
  const resolvedCreatedAt =
    (Number.isFinite(rawCreated) && rawCreated > 0 ? rawCreated : 0) ||
    parseCreatedTimestampFromBookId(idStr) ||
    (Number.isFinite(rawUpdated) && rawUpdated > 0 ? rawUpdated : 0) ||
    now;
  const resolvedUpdatedAt =
    Number.isFinite(rawUpdated) && rawUpdated > 0 ? rawUpdated : resolvedCreatedAt;

  return {
    id: idStr,
    title: String(book.title || '').trim(),
    author: String(book.author || 'Chưa rõ').trim(),
    category: String(book.category || 'Chung').trim(),
    publisher: String(book.publisher || '').trim(),
    is_ai_normalized: !!book.is_ai_normalized,
    ...(cleanSummary ? { summary: cleanSummary } : {}),
    ...(cleanCover ? { cover_url: cleanCover } : {}),
    created_at: resolvedCreatedAt,
    updated_at: resolvedUpdatedAt,
  };
}

/**
 * 1. NẠP TOÀN BỘ SÁCH - Tối ưu 0ms với Cache RAM + IndexedDB
 */
export function loadLocalBooks(): BookRecord[] {
  if (inMemoryBooksCache !== null) {
    return inMemoryBooksCache;
  }
  const legacy = readLegacyLocalBooks();
  if (legacy.length > 0) {
    inMemoryBooksCache = legacy;
    return legacy;
  }
  inMemoryBooksCache = [];
  return [];
}

/**
 * 2. LƯU TOÀN BỘ SÁCH VÀO INDEXEDDB (không chặn UI, không giới hạn 5MB của LocalStorage)
 */
export function saveAllLocalBooks(books: BookRecord[]): void {
  const sanitized = books.map(sanitizeBookRecord);
  booksWriteGeneration += 1;
  inMemoryBooksCache = sanitized;

  if (typeof indexedDB !== 'undefined') {
    scheduleBooksIdbFlush();
    try {
      localStorage.removeItem(BOOKS_STORAGE_KEY);
    } catch {}
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('local-books-changed', { detail: { count: sanitized.length } }));
    }
    return;
  }

  try {
    const serialized = JSON.stringify(sanitized);
    localStorage.setItem(BOOKS_STORAGE_KEY, serialized);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('local-books-changed', { detail: { count: sanitized.length } }));
    }
  } catch (err: any) {
    console.error('[LocalStorage] Lỗi ghi sách vào bộ nhớ máy:', err);
  }
}

/**
 * 3. THÊM HOẶC CẬP NHẬT 1 CUỐN SÁCH
 */
export function upsertLocalBook(book: BookRecord): BookRecord[] {
  const current = loadLocalBooks();
  const index = current.findIndex((b) => b.id === book.id);
  const existing = index !== -1 ? current[index] : undefined;
  let updated: BookRecord[];

  const now = Date.now();
  const cleanCover = typeof book.cover_url === 'string' ? book.cover_url.trim() : '';
  const cleanSummary = typeof book.summary === 'string' ? book.summary.trim() : '';
  const preservedCreatedAt =
    (typeof existing?.created_at === 'number' && existing.created_at > 0 ? existing.created_at : 0) ||
    (typeof book.created_at === 'number' && book.created_at > 0 ? book.created_at : 0) ||
    parseCreatedTimestampFromBookId(book.id) ||
    now;

  const cleanBook: BookRecord = {
    ...book,
    title: String(book.title || '').trim(),
    author: String(book.author || 'Chưa rõ').trim(),
    category: String(book.category || 'Chung').trim(),
    publisher: String(book.publisher || '').trim(),
    ...(cleanSummary ? { summary: cleanSummary } : { summary: undefined }),
    ...(cleanCover ? { cover_url: cleanCover } : { cover_url: undefined }),
    updated_at: now,
    created_at: preservedCreatedAt,
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
  const now = Date.now();

  current.forEach((b) => map.set(b.id, b));
  newOrUpdatedBooks.forEach((b) => {
    const existing = map.get(b.id);
    const isNew = !existing;
    const cleanCover = typeof b.cover_url === 'string' ? b.cover_url.trim() : '';
    const cleanSummary = typeof b.summary === 'string' ? b.summary.trim() : '';
    const preservedCreatedAt =
      (typeof existing?.created_at === 'number' && existing.created_at > 0 ? existing.created_at : 0) ||
      (typeof b.created_at === 'number' && b.created_at > 0 ? b.created_at : 0) ||
      parseCreatedTimestampFromBookId(b.id) ||
      now;

    const item: BookRecord = {
      ...b,
      title: String(b.title || '').trim(),
      author: String(b.author || 'Chưa rõ').trim(),
      category: String(b.category || 'Chung').trim(),
      publisher: String(b.publisher || '').trim(),
      ...(cleanSummary ? { summary: cleanSummary } : { summary: undefined }),
      ...(cleanCover ? { cover_url: cleanCover } : { cover_url: undefined }),
      updated_at: b.updated_at || now,
      created_at: preservedCreatedAt,
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
    booksWriteGeneration += 1;
    mutationsWriteGeneration += 1;
    inMemoryBooksCache = [];
    inMemoryMutationsCache = [];
    booksIdbDirty = false;
    mutationsIdbDirty = false;
    removeLegacyStorageKeys();
    // Đánh dấu cờ cần phục hồi từ Master Sheet: chống việc xóa sạch trên máy đẩy mảng rỗng xóa sạch file chung
    setMasterRestoreRequired(true);
    if (typeof indexedDB !== 'undefined') {
      void clearLibraryDataInIdb().catch((err) => {
        console.warn('[IndexedDB] Lỗi xóa dữ liệu kho sách:', err);
      });
    }
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
        autoNormalizeEnabled: parsed.autoNormalizeEnabled === true,
        normalizeFields: resolveNormalizeFields(parsed.normalizeFields),
        categoriesList: resolveExpandedCategories(parsed.categoriesList),
      };
    } else if (storedKeys.length > 0) {
      return {
        ...DEFAULT_SETTINGS,
        autoNormalizeEnabled: false,
        normalizeFields: [...DEFAULT_NORMALIZE_FIELDS],
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

function estimateBookBytes(book: BookRecord): number {
  const charCount =
    (book.id?.length || 0) +
    (book.title?.length || 0) +
    (book.author?.length || 0) +
    (book.category?.length || 0) +
    (book.publisher?.length || 0) +
    (book.summary?.length || 0) +
    (book.cover_url?.length || 0) +
    120;
  return charCount * 2;
}

export function getLocalStorageHealth(): LocalStorageHealth {
  try {
    const books = loadLocalBooks();
    const pending = getPendingBookMutations();

    let estimatedBytes = 0;
    for (let i = 0; i < books.length; i++) {
      estimatedBytes += estimateBookBytes(books[i]);
    }
    for (let i = 0; i < pending.length; i++) {
      const m = pending[i];
      estimatedBytes += 140 + (m.book ? estimateBookBytes(m.book) : 0);
    }

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
