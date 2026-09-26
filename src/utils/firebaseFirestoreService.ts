import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
  deleteDoc,
  writeBatch,
  onSnapshot,
  getDocFromServer,
  Unsubscribe,
} from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { BookRecord, LibrarySettings } from '../types';
import { USER_MASTER_BOOKS } from '../data/sampleBooks';

// Initialize Firebase app & Firestore
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
  };
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test initial connection
export async function testFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'settings', 'config'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firestore đang hoạt động ở chế độ Offline-first.');
    }
    return false;
  }
}

/**
 * 1. LẤY TOÀN BỘ SÁCH TRONG KHO (Hỗ trợ Offline-first)
 */
export async function fetchAllBooksFromFirestore(): Promise<BookRecord[]> {
  const path = 'books';
  try {
    const colRef = collection(db, path);
    const snap = await getDocs(colRef);
    const books: BookRecord[] = [];
    snap.forEach((d) => {
      const data = d.data();
      books.push({
        id: d.id,
        title: data.title || '',
        author: data.author || '',
        category: data.category || 'Chung',
        publisher: data.publisher || '',
        created_at: data.created_at || Date.now(),
        updated_at: data.updated_at || Date.now(),
      });
    });
    return books;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return [];
  }
}

/**
 * 2. LẮNG NGHE THAY ĐỔI REAL-TIME DANH MỤC SÁCH
 */
export function subscribeToBooksRealtime(
  callback: (books: BookRecord[]) => void,
  onError?: (err: any) => void
): Unsubscribe {
  const path = 'books';
  const colRef = collection(db, path);
  return onSnapshot(
    colRef,
    (snap) => {
      const books: BookRecord[] = [];
      snap.forEach((d) => {
        const data = d.data();
        books.push({
          id: d.id,
          title: data.title || '',
          author: data.author || '',
          category: data.category || 'Chung',
          publisher: data.publisher || '',
          created_at: data.created_at || Date.now(),
          updated_at: data.updated_at || Date.now(),
        });
      });
      callback(books);
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
      if (onError) onError(error);
    }
  );
}

/**
 * 3. LƯU / CẬP NHẬT 1 BẢN GHI SÁCH (Chỉ gồm Tên sách, Tác giả, Thể loại, NXB)
 */
export async function saveBookToFirestore(book: BookRecord): Promise<void> {
  const path = `books/${book.id}`;
  try {
    const docRef = doc(db, 'books', book.id);
    const cleanPayload: BookRecord = {
      id: book.id,
      title: String(book.title || '').trim(),
      author: String(book.author || 'Khuyết danh').trim(),
      category: String(book.category || 'Chung').trim(),
      publisher: String(book.publisher || '').trim(),
      created_at: book.created_at || Date.now(),
      updated_at: Date.now(),
    };
    await setDoc(docRef, cleanPayload, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * 4. LƯU HÀNG LOẠT SÁCH (BATCH WRITE - CHUNK 400)
 */
export async function batchSaveBooksToFirestore(books: BookRecord[]): Promise<void> {
  const path = 'books';
  try {
    const CHUNK_SIZE = 400;
    for (let i = 0; i < books.length; i += CHUNK_SIZE) {
      const chunk = books.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);
      for (const book of chunk) {
        const docRef = doc(db, 'books', book.id);
        const cleanPayload: BookRecord = {
          id: book.id,
          title: String(book.title || '').trim(),
          author: String(book.author || 'Khuyết danh').trim(),
          category: String(book.category || 'Chung').trim(),
          publisher: String(book.publisher || '').trim(),
          created_at: book.created_at || Date.now(),
          updated_at: Date.now(),
        };
        batch.set(docRef, cleanPayload, { merge: true });
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * 5. XÓA 1 SÁCH KHỎI KHO
 */
export async function deleteBookFromFirestore(bookId: string): Promise<void> {
  const path = `books/${bookId}`;
  try {
    const docRef = doc(db, 'books', bookId);
    await deleteDoc(docRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

/**
 * 6. XÓA TOÀN BỘ KHO SÁCH (Dọn sạch hoàn toàn)
 */
export async function clearAllBooksInFirestore(): Promise<void> {
  const path = 'books';
  try {
    const colRef = collection(db, path);
    const snap = await getDocs(colRef);
    if (snap.empty) return;
    
    const docs = snap.docs;
    const CHUNK_SIZE = 400;
    for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
      const chunk = docs.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);
      chunk.forEach((d) => {
        batch.delete(d.ref);
      });
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

/**
 * 7. SEED TOÀN BỘ DỮ LIỆU GỐC CỦA NGƯỜI DÙNG VÀO FIRESTORE (591 CUỐN SÁCH)
 */
export async function seedMasterBooksToFirestore(force = false): Promise<{ count: number; seeded: boolean }> {
  try {
    const current = await fetchAllBooksFromFirestore();
    if (!force && current.length > 0) {
      return { count: current.length, seeded: false };
    }
    
    // Dọn sạch trước khi đưa vào nếu force
    if (force && current.length > 0) {
      await clearAllBooksInFirestore();
    }
    
    await batchSaveBooksToFirestore(USER_MASTER_BOOKS);
    return { count: USER_MASTER_BOOKS.length, seeded: true };
  } catch (err) {
    console.error('Error seeding master books:', err);
    throw err;
  }
}

/**
 * 8. CẤU HÌNH KHO SÁCH (Settings)
 */
export async function getLibrarySettingsFromFirestore(): Promise<LibrarySettings | null> {
  const path = 'settings/config';
  try {
    const docRef = doc(db, 'settings', 'config');
    const snap = await getDoc(docRef);
    if (!snap.exists()) return null;
    return snap.data() as LibrarySettings;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return null;
  }
}

export async function saveLibrarySettingsToFirestore(settings: LibrarySettings): Promise<void> {
  const path = 'settings/config';
  try {
    const docRef = doc(db, 'settings', 'config');
    await setDoc(docRef, settings, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}
