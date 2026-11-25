import React, { createContext, useContext, useCallback, ReactNode } from 'react';

export type ToastType = 'success' | 'info' | 'error' | 'warning';

export interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Đã ẩn hoàn toàn toàn bộ thông báo floating trên màn hình theo yêu cầu người dùng
  const showToast = useCallback((message: string, type: ToastType = 'success', _duration = 3000) => {
    console.log(`[Toast ${type}]:`, message);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const context = useContext(ToastContext);
  if (!context) {
    return {
      showToast: (msg: string) => console.log('Toast:', msg),
    };
  }
  return context;
};
