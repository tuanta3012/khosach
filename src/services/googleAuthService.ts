import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithCredential,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { AuthUser } from '../types';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

// Khởi tạo Firebase App an toàn
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
// Cấp quyền Google Drive & Google Sheets
provider.addScope('https://www.googleapis.com/auth/drive.file');
provider.addScope('https://www.googleapis.com/auth/spreadsheets');
// Loại bỏ prompt: 'select_account' để trình duyệt tự động đăng nhập ngầm không làm phiền người dùng nếu đã cấp quyền rồi

// Khóa lưu trữ trong hệ thống
const TOKEN_KEY = 'google_drive_access_token';
const TOKEN_EXPIRES_AT_KEY = 'google_drive_token_expires_at';
const REFRESH_TOKEN_KEY = 'google_drive_refresh_token';
const ID_TOKEN_KEY = 'google_drive_id_token';
const USER_PROFILE_KEY = 'google_drive_user_profile';

function persistNativePreference(key: string, value: string): void {
  void Preferences.set({ key, value }).catch((err: unknown) => {
    console.warn('[GoogleAuth] Lỗi lưu native preference:', err);
  });
}

// Khởi tạo Google Auth cho Native nếu đang chạy trên ứng dụng di động Android/iOS
const GOOGLE_CLIENT_ID = '742077941372-fk4ef96nfj54dqjov8vhpgum2tsq9dep.apps.googleusercontent.com';

if (Capacitor.isNativePlatform()) {
  GoogleAuth.initialize({
    clientId: GOOGLE_CLIENT_ID,
    scopes: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
    grantOfflineAccess: true,
  });
}

// Cache access token trong memory
let cachedAccessToken: string | null = null;
let isSigningIn = false;

/**
 * Kiểm tra xem Token còn hợp lệ và chưa hết hạn hay không
 */
export function isGoogleTokenValid(): boolean {
  const token = cachedAccessToken || localStorage.getItem(TOKEN_KEY);
  if (!token) return false;

  const expiresAtStr = localStorage.getItem(TOKEN_EXPIRES_AT_KEY);
  if (expiresAtStr) {
    const expiresAt = Number(expiresAtStr);
    // Nếu token đã hết hạn hoặc sắp hết hạn trong vòng 60 giây
    if (!isNaN(expiresAt) && Date.now() >= expiresAt - 60000) {
      return false;
    }
  }
  return true;
}

/**
 * Xóa sạch token đã hết hạn khỏi bộ nhớ
 */
export function clearExpiredGoogleSession() {
  cachedAccessToken = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRES_AT_KEY);
  Preferences.remove({ key: TOKEN_KEY }).catch(() => {});
  Preferences.remove({ key: TOKEN_EXPIRES_AT_KEY }).catch(() => {});
}

/**
 * Lưu phiên làm việc an toàn vào cả LocalStorage và Native Preferences
 */
export function saveGoogleAuthSession(session: {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  userProfile?: any;
}) {
  try {
    cachedAccessToken = session.accessToken;
    const expiresAt = session.expiresAt || (Date.now() + 3500 * 1000);
    
    localStorage.setItem(TOKEN_KEY, session.accessToken);
    localStorage.setItem(TOKEN_EXPIRES_AT_KEY, expiresAt.toString());
    persistNativePreference(TOKEN_KEY, session.accessToken);
    persistNativePreference(TOKEN_EXPIRES_AT_KEY, expiresAt.toString());

    if (session.refreshToken) {
      localStorage.setItem(REFRESH_TOKEN_KEY, session.refreshToken);
      persistNativePreference(REFRESH_TOKEN_KEY, session.refreshToken);
    }
    if (session.idToken) {
      localStorage.setItem(ID_TOKEN_KEY, session.idToken);
      persistNativePreference(ID_TOKEN_KEY, session.idToken);
    }
    if (session.userProfile) {
      const profileJson = JSON.stringify(session.userProfile);
      localStorage.setItem(USER_PROFILE_KEY, profileJson);
      persistNativePreference(USER_PROFILE_KEY, profileJson);
    }
  } catch (err) {
    console.warn('[GoogleAuth] Lỗi lưu phiên đăng nhập:', err);
  }
}

/**
 * TỰ ĐỘNG GIA HẠN PHIÊN NGẦM TRÊN NATIVE HOẶC LẤY TOKEN LƯU TRỮ
 * Không mở popup ngầm trên Web để tránh bị trình duyệt chặn (Browser Popup Blocker)
 */
export async function trySilentRefresh(): Promise<string | null> {
  // 1. Gia hạn ngầm trên thiết bị Native App (Android/iOS) dùng Capacitor Google Play Services
  if (Capacitor.isNativePlatform()) {
    try {
      console.log('[GoogleAuth] Đang tiến hành làm mới Native Token ngầm (Silent Refresh)...');
      const refreshResult = await GoogleAuth.refresh();
      if (refreshResult && refreshResult.accessToken) {
        const expiresAt = Date.now() + 3500 * 1000;
        saveGoogleAuthSession({
          accessToken: refreshResult.accessToken,
          idToken: refreshResult.idToken || undefined,
          expiresAt,
        });
        console.log('[GoogleAuth] Làm mới Native Token ngầm thành công!');
        return refreshResult.accessToken;
      }
    } catch (err) {
      console.warn('[GoogleAuth] Không thể làm mới token ngầm trên Native:', err);
    }
  }

  // 2. Trên Web: Trình duyệt luôn chặn popup ngầm (Browser Popup Blocker) nếu không có thao tác click từ người dùng.
  // Tuyệt đối không gọi GIS requestAccessToken ngầm trong background để tránh lỗi GSI_LOGGER popup blocked.
  const token = cachedAccessToken || localStorage.getItem(TOKEN_KEY);
  if (token && isGoogleTokenValid()) {
    cachedAccessToken = token;
    return token;
  }

  return null;
}

/**
 * KHÔI PHỤC PHIÊN ĐĂNG NHẬP SÂU KHI KHỞI ĐỘNG (COLD START RECOVERY)
 */
export async function restoreGoogleAuthSession(): Promise<boolean> {
  try {
    const tokenResult = await Preferences.get({ key: TOKEN_KEY });
    const expiresAtResult = await Preferences.get({ key: TOKEN_EXPIRES_AT_KEY });
    const refreshTokenResult = await Preferences.get({ key: REFRESH_TOKEN_KEY });
    const idTokenResult = await Preferences.get({ key: ID_TOKEN_KEY });
    const userProfileResult = await Preferences.get({ key: USER_PROFILE_KEY });

    const token = tokenResult.value;
    const expiresAt = expiresAtResult.value;
    const refreshToken = refreshTokenResult.value;
    const idToken = idTokenResult.value;
    const userProfile = userProfileResult.value;

    if (token) {
      cachedAccessToken = token;
      localStorage.setItem(TOKEN_KEY, token);
      if (expiresAt) localStorage.setItem(TOKEN_EXPIRES_AT_KEY, expiresAt);
      if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
      if (idToken) localStorage.setItem(ID_TOKEN_KEY, idToken);
      if (userProfile) localStorage.setItem(USER_PROFILE_KEY, userProfile);
      console.log('[GoogleAuth] Khôi phục phiên làm việc (Cold Start) thành công!');
      return true;
    }
  } catch (err) {
    console.warn('[GoogleAuth] Lỗi khôi phục phiên từ Preferences:', err);
  }
  return false;
}

/**
 * Lấy access token hiện tại (tự động khôi phục hoặc refresh nếu hết hạn)
 */
export const getAccessToken = async (forceRefresh = false): Promise<string | null> => {
  if (!forceRefresh && isGoogleTokenValid()) {
    const token = cachedAccessToken || localStorage.getItem(TOKEN_KEY);
    if (token) {
      cachedAccessToken = token;
      return token;
    }
  }

  // Thử silent refresh ngầm (đặc biệt hữu hiệu trên Android Native qua Google Play Services)
  const refreshedToken = await trySilentRefresh();
  if (refreshedToken) {
    return refreshedToken;
  }

  // Thử khôi phục từ Preferences nếu có
  await restoreGoogleAuthSession();
  if (isGoogleTokenValid()) {
    return cachedAccessToken || localStorage.getItem(TOKEN_KEY);
  }

  // Fallback an toàn: nếu token vẫn còn trong storage và chưa bị chủ động logout, giữ lại để thử gọi API
  const existingToken = cachedAccessToken || localStorage.getItem(TOKEN_KEY);
  if (existingToken && !forceRefresh) {
    return existingToken;
  }

  // Nếu trên Web và token đã hết hạn hoàn toàn: Xóa token cũ
  if (!isGoogleTokenValid()) {
    console.log('[GoogleAuth] Token đã hết hạn và không thể gia hạn ngầm.');
    clearExpiredGoogleSession();
    return null;
  }

  return null;
};

export const initAuth = (
  onAuthSuccess?: (user: User, token: string | null) => void,
  onAuthFailure?: () => void
) => {
  // 1. Khôi phục phiên lưu trữ ngầm
  restoreGoogleAuthSession().catch(() => {});

  // 2. Kiểm tra kết quả từ đăng nhập Redirect (chuyển hướng) nếu có
  getRedirectResult(auth)
    .then((result) => {
      if (result) {
        const credential = GoogleAuthProvider.credentialFromResult(result);
        const accessToken = credential?.accessToken || '';
        const firebaseUser = result.user;

        const expiresAt = Date.now() + 3500 * 1000;
        saveGoogleAuthSession({
          accessToken,
          idToken: credential?.idToken || undefined,
          expiresAt,
          userProfile: result.user,
        });

        const authUser: AuthUser = {
          email: firebaseUser.email || '',
          name: firebaseUser.displayName || 'Người dùng Google',
          photoURL: firebaseUser.photoURL || undefined,
          userRole: 'ADMIN',
        };
        localStorage.setItem('library_user_v2', JSON.stringify(authUser));
        console.log('[GoogleAuth] Đăng nhập Redirect thành công:', authUser);

        // Kích hoạt ngay sự kiện đăng nhập thành công cho giao diện React cập nhật tức thì
        if (onAuthSuccess) {
          onAuthSuccess(firebaseUser, accessToken);
        }
      }
    })
    .catch((err) => {
      console.warn('[GoogleAuth] Lỗi xử lý kết quả redirect:', err);
    });

  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      const token = await getAccessToken();
      if (onAuthSuccess) onAuthSuccess(user, token);
    } else {
      // Trong môi trường Web preview hoặc GIS, user trong Firebase Auth có thể là null
      // nhưng phiên Google vẫn hợp lệ trong localStorage hoặc Preferences.
      const storedUserStr = localStorage.getItem('library_user_v2');
      const token = await getAccessToken();
      if (token && storedUserStr) {
        try {
          const parsed = JSON.parse(storedUserStr);
          if (parsed?.email) {
            console.log('[GoogleAuth] Duy trì phiên Google hợp lệ từ cache (Web/Native):', parsed.email);
            if (onAuthSuccess) {
              onAuthSuccess(
                {
                  email: parsed.email,
                  displayName: parsed.name,
                  photoURL: parsed.photoURL,
                } as any,
                token
              );
            }
            return;
          }
        } catch {}
      }

      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

/**
 * Trình duyệt web hiện đại luôn chặn popup ngầm (prompt: 'none') khi không có thao tác click từ người dùng.
 * Hàm này trả về null an toàn để tránh kích hoạt lỗi popup blocked trên trình duyệt.
 */
export async function silentSignInGoogleGIS(_userEmail?: string): Promise<string | null> {
  return null;
}

/**
 * Tải động Google Identity Services SDK nếu chưa có
 */
export function loadGsiScript(): Promise<void> {
  return new Promise((resolve) => {
    if ((window as any).google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      setTimeout(resolve, 1500);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
}

/**
 * Đăng nhập trực tiếp qua Google Identity Services (GIS) - Không bị chặn bởi Firebase Authorized Domains
 */
export async function signInWithGoogleGIS(): Promise<{
  user: User;
  accessToken: string;
  authUser: AuthUser;
} | null> {
  await loadGsiScript();
  const google = (window as any).google;
  if (!google?.accounts?.oauth2) {
    throw new Error('Không thể tải thư viện Google Identity Services.');
  }

  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets',
      callback: async (tokenResponse: any) => {
        if (tokenResponse.error) {
          if (tokenResponse.error === 'popup_closed_by_user') {
            console.log('[GoogleGIS] Người dùng đóng popup.');
            resolve(null);
            return;
          }
          reject(new Error(tokenResponse.error_description || tokenResponse.error));
          return;
        }

        const accessToken = tokenResponse.access_token;
        if (!accessToken) {
          reject(new Error('Không nhận được access_token từ Google.'));
          return;
        }

        try {
          const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

          const expiresAt = Date.now() + (Number(tokenResponse.expires_in) || 3500) * 1000;
          saveGoogleAuthSession({
            accessToken,
            expiresAt,
            userProfile: userInfo,
          });

          const authUser: AuthUser = {
            email: userInfo.email || '',
            name: userInfo.name || 'Người dùng Google',
            photoURL: userInfo.picture,
            userRole: 'ADMIN',
          };

          try {
            localStorage.setItem('library_user_v2', JSON.stringify(authUser));
            localStorage.setItem('app_mode_v2', 'online');
          } catch {}

          resolve({
            user: {
              email: authUser.email,
              displayName: authUser.name,
              photoURL: authUser.photoURL,
            } as any,
            accessToken,
            authUser,
          });
        } catch (fetchErr) {
          reject(fetchErr);
        }
      },
    });

    client.requestAccessToken();
  });
}

/**
 * ĐĂNG NHẬP GOOGLE HOÀN CHỈNH (Hỗ trợ Iframe, Popups, Redirects)
 */
export const googleSignIn = async (): Promise<{
  user: User;
  accessToken: string;
  authUser: AuthUser;
  isIframeRedirect?: boolean;
} | null> => {
  try {
    isSigningIn = true;
    let firebaseUser: User;
    let accessToken = '';

    // 1. Dành cho điện thoại di động Native App
    if (Capacitor.isNativePlatform()) {
      console.log('[GoogleAuth] Thực hiện đăng nhập Native Google Sign-In...');
      const nativeResult = await GoogleAuth.signIn();
      const idToken = nativeResult.authentication?.idToken || (nativeResult as any).idToken;
      accessToken = nativeResult.authentication?.accessToken || (nativeResult as any).accessToken || idToken;
      const refreshToken = nativeResult.authentication?.refreshToken || (nativeResult as any).refreshToken;

      const expiresAt = Date.now() + 3500 * 1000;
      saveGoogleAuthSession({
        accessToken,
        idToken,
        refreshToken,
        expiresAt,
        userProfile: nativeResult,
      });

      const credential = GoogleAuthProvider.credential(idToken, accessToken !== idToken ? accessToken : null);
      const authResult = await signInWithCredential(auth, credential);
      firebaseUser = authResult.user;

      const authUser: AuthUser = {
        email: firebaseUser.email || '',
        name: firebaseUser.displayName || 'Người dùng Google',
        photoURL: firebaseUser.photoURL || undefined,
        userRole: 'ADMIN',
      };

      try {
        localStorage.setItem('library_user_v2', JSON.stringify(authUser));
        localStorage.setItem('app_mode_v2', 'online');
      } catch {}

      return {
        user: firebaseUser,
        accessToken,
        authUser,
      };
    } else {
      // 2. Dành cho môi trường Web / Trình duyệt thông thường (Chrome, Safari, Firefox, Android Web)
      console.log('[GoogleAuth] Đang thực hiện đăng nhập qua Google Identity Services (GIS)...');
      try {
        const gisResult = await signInWithGoogleGIS();
        return gisResult;
      } catch (gisErr: any) {
        console.warn('[GoogleAuth] GIS error, falling back to Firebase Popup:', gisErr);
        try {
          const result = await signInWithPopup(auth, provider);
          const credential = GoogleAuthProvider.credentialFromResult(result);
          accessToken = credential?.accessToken || '';
          firebaseUser = result.user;

          const expiresAt = Date.now() + 3500 * 1000;
          saveGoogleAuthSession({
            accessToken,
            idToken: credential?.idToken || undefined,
            expiresAt,
            userProfile: result.user,
          });

          const authUser: AuthUser = {
            email: firebaseUser.email || '',
            name: firebaseUser.displayName || 'Người dùng Google',
            photoURL: firebaseUser.photoURL || undefined,
            userRole: 'ADMIN',
          };

          try {
            localStorage.setItem('library_user_v2', JSON.stringify(authUser));
            localStorage.setItem('app_mode_v2', 'online');
          } catch {}

          return {
            user: firebaseUser,
            accessToken,
            authUser,
          };
        } catch (popupErr: any) {
          if (popupErr?.code === 'auth/popup-closed-by-user') {
            console.log('[GoogleAuth] Người dùng đã đóng popup.');
            return null;
          }
          throw popupErr;
        }
      }
    }
  } catch (error: any) {
    if (error?.code === 'auth/popup-closed-by-user' || error?.message === 'popup_closed_by_user') {
      console.log('[GoogleAuth] Người dùng đóng popup.');
      return null;
    }
    console.error('[GoogleAuth] Lỗi đăng nhập:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

/**
 * ĐĂNG XUẤT SẠCH TOÀN BỘ PHIÊN HOÀN TOÀN TRÁNH RÒ RỈ QUYỀN
 */
export const googleLogout = async (): Promise<void> => {
  try {
    await signOut(auth);
    if (Capacitor.isNativePlatform()) {
      await GoogleAuth.signOut().catch((err) => {
        console.warn('[GoogleAuth] Lỗi GoogleAuth.signOut native:', err);
      });
    }
  } catch (err) {
    console.warn('[GoogleAuth] Lỗi signOut:', err);
  } finally {
    cachedAccessToken = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_EXPIRES_AT_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      localStorage.removeItem(ID_TOKEN_KEY);
      localStorage.removeItem(USER_PROFILE_KEY);
      localStorage.removeItem('library_user_v2');
      localStorage.setItem('app_mode_v2', 'offline');
    } catch {}
    
    // Xóa Preferences Native
    Preferences.clear().catch(() => {});
  }
};

/**
 * Kiểm tra xem người dùng hiện tại có token hợp lệ hay không
 */
export const isAuthenticated = (): boolean => {
  return !!auth.currentUser && isGoogleTokenValid();
};

// Single-flight promise để gom các request xác thực lại đồng thời (tránh race condition / duplicate popups)
let ongoingReauthPromise: Promise<string | null> | null = null;

/**
 * Xử lý khi API trả về mã lỗi Token (401 Unauthorized, Token Expired, v.v.):
 * - Gom các request đồng thời vào cùng 1 Promise (Single-flight)
 * - Trên Native: Thử tự động ngầm gia hạn token qua Google Play Services.
 * - Trên Web: Tuyệt đối không tự động mở popup ngầm trong background (sẽ bị trình duyệt chặn).
 *   Xóa phiên hết hạn an toàn và thông báo để người dùng chủ động bấm Đăng nhập lại.
 */
export async function handleTokenErrorAndReauthorize(): Promise<string | null> {
  if (ongoingReauthPromise) {
    console.log('[GoogleAuth] Đang có tiến trình làm mới token chạy ngầm, tái sử dụng kết quả chung...');
    return ongoingReauthPromise;
  }

  ongoingReauthPromise = (async () => {
    try {
      console.log('[GoogleAuth] Bắt được mã lỗi xác thực token. Tiến hành kiểm tra token...');
      // 1. Trên Native Android: Silent refresh qua Google Play Services không cần popup
      if (Capacitor.isNativePlatform()) {
        const silentToken = await trySilentRefresh();
        if (silentToken) {
          console.log('[GoogleAuth] Tự động ngầm Native thành công!');
          return silentToken;
        }
      }

      // 2. Trên Web: Không tự động mở popup ngầm trong background vì trình duyệt sẽ chặn (Popup Blocker).
      console.log('[GoogleAuth] Phiên token đã hết hạn trên Web. Dọn dẹp phiên để người dùng chủ động đăng nhập lại.');
      clearExpiredGoogleSession();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('google-token-expired'));
      }
      return null;
    } finally {
      ongoingReauthPromise = null;
    }
  })();

  return ongoingReauthPromise;
}


