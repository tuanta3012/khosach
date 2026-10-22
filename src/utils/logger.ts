const LOG_STORAGE_KEY = 'app_debug_logs';

function formatArg(arg: any): string {
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
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
    const formattedArgs = args.length > 0 ? ' ' + args.map(formatArg).join(' ') : '';
    const entry = `[${level}] ${new Date().toISOString()}: ${message}${formattedArgs}\n`;
    const existing = localStorage.getItem(LOG_STORAGE_KEY) || '';
    // Keep last 100KB of logs
    const newLogs = (existing + entry).slice(-100000);
    localStorage.setItem(LOG_STORAGE_KEY, newLogs);
  } catch (e) {
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
  appendLog('LOG', String(message || ''), ...optionalParams);
  originalConsole.log(message, ...optionalParams);
};
console.info = (message?: any, ...optionalParams: any[]) => {
  appendLog('INFO', String(message || ''), ...optionalParams);
  originalConsole.info(message, ...optionalParams);
};
console.warn = (message?: any, ...optionalParams: any[]) => {
  appendLog('WARN', String(message || ''), ...optionalParams);
  originalConsole.warn(message, ...optionalParams);
};
console.error = (message?: any, ...optionalParams: any[]) => {
  appendLog('ERROR', String(message || ''), ...optionalParams);
  originalConsole.error(message, ...optionalParams);
};

export const downloadLogs = () => {
  const logs = localStorage.getItem(LOG_STORAGE_KEY) || 'No logs found.';
  const blob = new Blob([logs], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `app_logs_${new Date().toISOString().replace(/:/g, '-')}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
