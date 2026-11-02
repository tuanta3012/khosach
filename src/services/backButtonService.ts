import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export type BackButtonHandler = () => boolean;

const handlersStack: BackButtonHandler[] = [];
let isListenerAttached = false;

/**
 * Đăng ký handler xử lý phím Back theo cơ chế ngăn xếp (LIFO).
 * Handler nào đăng ký sau cùng (ví dụ modal mở sau cùng) sẽ được gọi trước.
 * Trả về hàm hủy đăng ký (cleanup) khi unmount.
 */
export function registerBackButtonHandler(handler: BackButtonHandler): () => void {
  handlersStack.push(handler);
  return () => {
    const idx = handlersStack.lastIndexOf(handler);
    if (idx !== -1) {
      handlersStack.splice(idx, 1);
    }
  };
}

/**
 * Lắng nghe sự kiện phím cứng Back trên điện thoại Android (và cử chỉ vuốt Back) qua Capacitor.
 * @param onRootBack Hàm callback khi người dùng bấm Back ở màn hình chính (không còn modal hay màn hình con nào).
 */
export function setupBackButtonListener(onRootBack?: (exitApp: () => void) => void): () => void {
  if (isListenerAttached) return () => {};
  isListenerAttached = true;

  let lastBackPressTime = 0;

  const handleBackEvent = () => {
    // 1. Duyệt từ đỉnh stack trở xuống (LIFO - Last In First Out)
    for (let i = handlersStack.length - 1; i >= 0; i--) {
      const handler = handlersStack[i];
      try {
        const handled = handler();
        if (handled) {
          return;
        }
      } catch (err) {
        console.warn('[BackButton] Lỗi thực thi handler:', err);
      }
    }

    // 2. Nếu stack trống (đang ở màn hình chính thư viện)
    const now = Date.now();
    if (now - lastBackPressTime < 2000) {
      CapApp.exitApp().catch(() => {});
    } else {
      lastBackPressTime = now;
      if (onRootBack) {
        onRootBack(() => {
          CapApp.exitApp().catch(() => {});
        });
      }
    }
  };

  let removeListener: (() => void) | null = null;
  if (Capacitor.isNativePlatform() || (typeof window !== 'undefined' && 'Capacitor' in window)) {
    try {
      const promise = CapApp.addListener('backButton', () => {
        handleBackEvent();
      });
      removeListener = () => {
        promise.then((sub) => sub.remove()).catch(() => {});
      };
    } catch (err) {
      console.warn('[BackButton] Không thể gắn listener Capacitor backButton:', err);
    }
  }

  // Hỗ trợ phím Escape và popstate trên Web / Dev Preview
  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleBackEvent();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeydown);
  }

  return () => {
    isListenerAttached = false;
    if (removeListener) removeListener();
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleKeydown);
    }
  };
}
