import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const LOG_STORAGE_KEY = 'app_debug_logs';
const LOG_DATE_KEY = 'app_debug_log_date';
const MAX_LOG_CHARS = 160_000;
const FLUSH_DEBOUNCE_MS = 1_200;

let logBuffer = '';
let bufferInitialized = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getTodayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ensureBufferLoaded() {
  if (bufferInitialized) return;
  bufferInitialized = true;
  try {
    const today = getTodayString();
    const storedDate = localStorage.getItem(LOG_DATE_KEY);
    if (storedDate !== today) {
      logBuffer = '';
      localStorage.setItem(LOG_DATE_KEY, today);
      localStorage.removeItem(LOG_STORAGE_KEY);
    } else {
      logBuffer = (localStorage.getItem(LOG_STORAGE_KEY) || '').slice(-MAX_LOG_CHARS);
    }
  } catch {
    logBuffer = '';
  }
}

export function flushLogsToStorage(): void {
  ensureBufferLoaded();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    localStorage.setItem(LOG_STORAGE_KEY, logBuffer.slice(-MAX_LOG_CHARS));
  } catch {
    // ignore storage quota errors
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushLogsToStorage();
  }, FLUSH_DEBOUNCE_MS);
}

function formatArg(arg: any): string {
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function appendLog(level: string, message: string, ...args: any[]) {
  try {
    ensureBufferLoaded();
    const today = getTodayString();
    const storedDate = localStorage.getItem(LOG_DATE_KEY);
    if (storedDate !== today) {
      logBuffer = '';
      localStorage.setItem(LOG_DATE_KEY, today);
    }
    const formattedArgs = args.length > 0 ? ' ' + args.map(formatArg).join(' ') : '';
    const entry = `[${level}] ${new Date().toISOString()}: ${message}${formattedArgs}\n`;
    logBuffer = (logBuffer + entry).slice(-MAX_LOG_CHARS);
    if (level === 'ERROR') {
      flushLogsToStorage();
    } else {
      scheduleFlush();
    }
  } catch {
    // ignore
  }
}

// Hook original console methods
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export const log = {
  info: (message: string, ...args: any[]) => {
    appendLog('INFO', message, ...args);
    originalConsole.info(message, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    appendLog('WARN', message, ...args);
    originalConsole.warn(message, ...args);
  },
  error: (message: string, ...args: any[]) => {
    appendLog('ERROR', message, ...args);
    originalConsole.error(message, ...args);
  },
};

// Intercept global console so any background service logs are stored
console.log = (message?: any, ...optionalParams: any[]) => {
  appendLog('LOG', String(message ?? ''), ...optionalParams);
  originalConsole.log(message, ...optionalParams);
};
console.info = (message?: any, ...optionalParams: any[]) => {
  appendLog('INFO', String(message ?? ''), ...optionalParams);
  originalConsole.info(message, ...optionalParams);
};
console.warn = (message?: any, ...optionalParams: any[]) => {
  appendLog('WARN', String(message ?? ''), ...optionalParams);
  originalConsole.warn(message, ...optionalParams);
};
console.error = (message?: any, ...optionalParams: any[]) => {
  appendLog('ERROR', String(message ?? ''), ...optionalParams);
  originalConsole.error(message, ...optionalParams);
};

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushLogsToStorage);
  window.addEventListener('beforeunload', flushLogsToStorage);
}

export function getStoredLogsText(appVersion?: string): string {
  flushLogsToStorage();
  let platform = 'web';
  try {
    platform = Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web';
  } catch {}
  let storedKeyCount = 0;
  try {
    const rawKeys = localStorage.getItem('gemini_api_keys_v1');
    const parsed = rawKeys ? JSON.parse(rawKeys) : [];
    storedKeyCount = Array.isArray(parsed) ? parsed.length : 0;
  } catch {}

  const header = [
    '=== KHO SÁCH CÁ NHÂN - DIAGNOSTIC LOG ===',
    `ExportedAt: ${new Date().toISOString()}`,
    `AppVersion: ${appVersion || 'unknown'}`,
    `Platform: ${platform}`,
    `ConfiguredKeys: ${storedKeyCount}`,
    `ActiveModel: gemini-3.5-flash-lite`,
    '=========================================',
    '',
  ].join('\n');

  const body = logBuffer.trim() ? logBuffer : '(Chưa có log nào được ghi nhận.)\n';
  return `${header}${body}`;
}

export function clearStoredLogs(): void {
  logBuffer = '';
  bufferInitialized = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    localStorage.removeItem(LOG_STORAGE_KEY);
  } catch {}
}

export interface ExportLogsResult {
  success: boolean;
  message: string;
  fileName?: string;
}

export const downloadLogs = async (appVersion?: string): Promise<ExportLogsResult> => {
  const logsText = getStoredLogsText(appVersion);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `khosach_logs_${stamp}.txt`;

  let isNative = false;
  try {
    isNative = Capacitor.isNativePlatform();
  } catch {
    isNative = false;
  }

  if (!isNative) {
    try {
      const blob = new Blob([logsText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 2500);
      return {
        success: true,
        fileName,
        message: `Đã tải xuống ${fileName}`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Không thể tải log: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    try {
      const permStatus = await Filesystem.checkPermissions();
      if (permStatus.publicStorage !== 'granted') {
        await Filesystem.requestPermissions().catch(() => {});
      }
    } catch {}

    let savedUri = '';
    let locationLabel = '';

    try {
      const extRes = await Filesystem.writeFile({
        path: `Download/${fileName}`,
        data: logsText,
        directory: Directory.ExternalStorage,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      savedUri = extRes.uri;
      locationLabel = `Download/${fileName}`;
    } catch {
      try {
        const docRes = await Filesystem.writeFile({
          path: fileName,
          data: logsText,
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        savedUri = docRes.uri;
        locationLabel = `Documents/${fileName}`;
      } catch {
        const cacheRes = await Filesystem.writeFile({
          path: fileName,
          data: logsText,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        savedUri = cacheRes.uri;
        locationLabel = `Cache/${fileName}`;
      }
    }

    if (savedUri) {
      try {
        await Share.share({
          title: fileName,
          text: `Nhật ký ứng dụng Kho Sách (${fileName})`,
          url: savedUri,
          dialogTitle: 'Lưu hoặc chia sẻ file log',
        });
      } catch {
        // Người dùng hủy hộp thoại chia sẻ vẫn giữ file đã ghi
      }
    }

    return {
      success: true,
      fileName,
      message: `Đã xuất log: ${locationLabel}`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Lỗi xuất log trên thiết bị: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
