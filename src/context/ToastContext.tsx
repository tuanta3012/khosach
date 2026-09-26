import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

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
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((message: string, type: ToastType = 'success', duration = 3000) => {
    const id = Math.random().toString(36).substring(2, 9);
    const newToast: ToastMessage = { id, message, type };

    setToasts([newToast]);

    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id === id ? false : true));
      }, duration);
    }
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts([]);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}

      {/* Floating Toast Container */}
      <div className="fixed top-3.5 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center pointer-events-none w-[92%] max-w-md sm:w-auto">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-center justify-between gap-2.5 px-3.5 py-2 rounded-xl shadow-xl border text-[11px] sm:text-xs font-semibold backdrop-blur-md transition-all animate-in fade-in slide-in-from-top-10 duration-500 ease-out ${
              toast.type === 'success'
                ? 'bg-gradient-to-r from-emerald-950/95 via-slate-900/95 to-teal-950/95 text-white border-emerald-400/50 shadow-emerald-950/40'
                : toast.type === 'error'
                ? 'bg-rose-950/95 text-rose-100 border-rose-500/50 shadow-rose-950/30'
                : toast.type === 'warning'
                ? 'bg-amber-950/95 text-amber-100 border-amber-400/50 shadow-amber-950/30'
                : 'bg-slate-900/95 text-slate-100 border-teal-500/30 shadow-slate-950/30'
            }`}
          >
            <div className="flex items-center space-x-2">
              {toast.type === 'success' && (
                <div className="w-5 h-5 rounded-md bg-gradient-to-tr from-emerald-500 to-teal-400 text-slate-950 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
                  <CheckCircle2 className="w-3.5 h-3.5 font-bold" />
                </div>
              )}
              {toast.type === 'error' && (
                <div className="w-5 h-5 rounded-md bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center justify-center shrink-0">
                  <AlertCircle className="w-3.5 h-3.5" />
                </div>
              )}
              {toast.type === 'warning' && (
                <div className="w-5 h-5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-3.5 h-3.5" />
                </div>
              )}
              {toast.type === 'info' && (
                <div className="w-5 h-5 rounded-md bg-teal-500/20 text-teal-300 border border-teal-500/30 flex items-center justify-center shrink-0">
                  <Info className="w-3.5 h-3.5" />
                </div>
              )}
              <span className="leading-snug">{toast.message}</span>
            </div>

            <button
              onClick={() => removeToast(toast.id)}
              className="text-slate-400 hover:text-white p-0.5 rounded-md hover:bg-slate-800 transition-colors cursor-pointer shrink-0 ml-1.5"
              title="Đóng"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
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
