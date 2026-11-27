import { BookRecord } from '../types';

export interface StoredBookMutation {
  id: string;
  type: 'CREATE' | 'UPDATE' | 'DELETE';
  bookId: string;
  book?: BookRecord;
  timestamp: number;
}

interface IndexedBookEntry {
  id: string;
  _order: number;
  data: BookRecord;
}

const DB_NAME = 'kho_sach_library_v1';
const DB_VERSION = 1;
const STORE_BOOKS = 'books';
const STORE_MUTATIONS = 'mutations';
const STORE_META = 'meta';
const META_MIGRATED_KEY = 'migrated_from_localstorage_v1';

let dbPromise: Promise<IDBDatabase> | null = null;

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openLibraryDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error('IndexedDB không khả dụng trên môi trường này.'));
  }
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        const bookStore = db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
        bookStore.createIndex('_order', '_order', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_MUTATIONS)) {
        const mutStore = db.createObjectStore(STORE_MUTATIONS, { keyPath: 'id' });
        mutStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {}
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('Không thể mở IndexedDB kho sách.'));
    };
  });

  return dbPromise;
}

export function resetLibraryDbConnection(): void {
  if (dbPromise) {
    dbPromise
      .then((db) => {
        try {
          db.close();
        } catch {}
      })
      .catch(() => {});
    dbPromise = null;
  }
}

export async function readLibrarySnapshotFromIdb(): Promise<{
  books: BookRecord[];
  mutations: StoredBookMutation[];
  hasMigrated: boolean;
}> {
  const db = await openLibraryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_BOOKS, STORE_MUTATIONS, STORE_META], 'readonly');
    const booksReq = tx.objectStore(STORE_BOOKS).getAll();
    const mutationsReq = tx.objectStore(STORE_MUTATIONS).getAll();
    const metaReq = tx.objectStore(STORE_META).get(META_MIGRATED_KEY);

    tx.oncomplete = () => {
      const rawEntries = (booksReq.result as IndexedBookEntry[]) || [];
      rawEntries.sort((a, b) => (a._order ?? 0) - (b._order ?? 0));
      const books = rawEntries.map((entry) => entry.data).filter(Boolean);

      const mutations = ((mutationsReq.result as StoredBookMutation[]) || []).sort(
        (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
      );
      const hasMigrated = Boolean((metaReq.result as { value?: unknown } | undefined)?.value);

      resolve({ books, mutations, hasMigrated });
    };

    tx.onerror = () => {
      reject(tx.error || new Error('Lỗi đọc dữ liệu từ IndexedDB.'));
    };
  });
}

export async function writeAllBooksToIdb(books: BookRecord[]): Promise<void> {
  const db = await openLibraryDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    const store = tx.objectStore(STORE_BOOKS);
    store.clear();
    for (let i = 0; i < books.length; i++) {
      const book = books[i];
      store.put({
        id: book.id,
        _order: i,
        data: book,
      } satisfies IndexedBookEntry);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Lỗi ghi danh sách sách vào IndexedDB.'));
  });
}

export async function writeAllMutationsToIdb(mutations: StoredBookMutation[]): Promise<void> {
  const db = await openLibraryDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_MUTATIONS, 'readwrite');
    const store = tx.objectStore(STORE_MUTATIONS);
    store.clear();
    for (let i = 0; i < mutations.length; i++) {
      store.put(mutations[i]);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Lỗi ghi mutation queue vào IndexedDB.'));
  });
}

export async function writeInitialMigrationToIdb(
  books: BookRecord[],
  mutations: StoredBookMutation[]
): Promise<void> {
  const db = await openLibraryDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_BOOKS, STORE_MUTATIONS, STORE_META], 'readwrite');
    const bookStore = tx.objectStore(STORE_BOOKS);
    const mutStore = tx.objectStore(STORE_MUTATIONS);
    const metaStore = tx.objectStore(STORE_META);

    bookStore.clear();
    for (let i = 0; i < books.length; i++) {
      const book = books[i];
      bookStore.put({
        id: book.id,
        _order: i,
        data: book,
      } satisfies IndexedBookEntry);
    }

    mutStore.clear();
    for (let i = 0; i < mutations.length; i++) {
      mutStore.put(mutations[i]);
    }

    metaStore.put({ key: META_MIGRATED_KEY, value: true, migratedAt: Date.now() });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Lỗi di chuyển dữ liệu sang IndexedDB.'));
  });
}

export async function markLibraryMigratedInIdb(): Promise<void> {
  const db = await openLibraryDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({
      key: META_MIGRATED_KEY,
      value: true,
      migratedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Lỗi đánh dấu trạng thái IndexedDB.'));
  });
}

export async function clearLibraryDataInIdb(): Promise<void> {
  const db = await openLibraryDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_BOOKS, STORE_MUTATIONS], 'readwrite');
    tx.objectStore(STORE_BOOKS).clear();
    tx.objectStore(STORE_MUTATIONS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Lỗi xóa dữ liệu IndexedDB.'));
  });
}
