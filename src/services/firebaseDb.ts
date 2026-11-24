import { getApps, getApp, initializeApp } from 'firebase/app';
import {
  Firestore,
  getFirestore,
  initializeFirestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

export const FIRESTORE_DATABASE_ID = 'ai-studio-khosach-0ef0f956-9e92-4b96-aab6-0adefe2a1acc';

let cachedDb: Firestore | null = null;

export function getFirebaseAppInstance() {
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

/**
 * Khởi tạo lười (lazy) và dùng chung 1 Firestore instance duy nhất với
 * experimentalAutoDetectLongPolling để hoạt động ổn định trong iframe preview và Android WebView.
 */
export function getSharedFirestore(): Firestore {
  if (cachedDb) return cachedDb;
  const app = getFirebaseAppInstance();
  try {
    cachedDb = initializeFirestore(
      app,
      {
        experimentalAutoDetectLongPolling: true,
        ignoreUndefinedProperties: true,
      },
      FIRESTORE_DATABASE_ID
    );
  } catch {
    cachedDb = getFirestore(app, FIRESTORE_DATABASE_ID);
  }
  return cachedDb;
}

export function isDeviceOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
