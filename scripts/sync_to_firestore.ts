import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, writeBatch, deleteDoc } from 'firebase/firestore';
import * as fs from 'fs';
import * as path from 'path';
import { USER_MASTER_BOOKS } from '../src/data/sampleBooks';

async function main() {
  console.log('Loading Firebase config...');
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const app = initializeApp({
    apiKey: firebaseConfig.apiKey,
    authDomain: firebaseConfig.authDomain,
    projectId: firebaseConfig.projectId,
    storageBucket: firebaseConfig.storageBucket,
    messagingSenderId: firebaseConfig.messagingSenderId,
    appId: firebaseConfig.appId,
  });

  const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

  console.log(`Target Firestore database: ${firebaseConfig.firestoreDatabaseId}`);
  console.log('Reading current documents in collection "books"...');

  const booksCol = collection(db, 'books');
  const snap = await getDocs(booksCol);
  console.log(`Found ${snap.docs.length} existing documents in Firestore.`);

  // Delete all existing documents (including sample_01..sample_10)
  if (snap.docs.length > 0) {
    console.log('Clearing all existing sample/old docs...');
    const CHUNK_SIZE = 400;
    for (let i = 0; i < snap.docs.length; i += CHUNK_SIZE) {
      const chunk = snap.docs.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);
      chunk.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    console.log('Cleared existing documents.');
  }

  // Insert all 591 books
  console.log(`Inserting ${USER_MASTER_BOOKS.length} master books into Firestore...`);
  const CHUNK_SIZE = 400;
  for (let i = 0; i < USER_MASTER_BOOKS.length; i += CHUNK_SIZE) {
    const chunk = USER_MASTER_BOOKS.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const book of chunk) {
      const docRef = doc(db, 'books', book.id);
      batch.set(docRef, {
        id: book.id,
        title: book.title,
        author: book.author,
        category: book.category || 'Chung',
        publisher: book.publisher || '',
        created_at: book.created_at || Date.now(),
        updated_at: Date.now(),
      });
    }
    await batch.commit();
    console.log(`Committed chunk ${i + 1} -> ${Math.min(i + CHUNK_SIZE, USER_MASTER_BOOKS.length)} books`);
  }

  console.log('Done! All 591 books are now live in Firestore.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
