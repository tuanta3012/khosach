let wakeLockSentinel: WakeLockSentinel | null = null;
let keepAliveAudioCtx: AudioContext | null = null;
let keepAliveOscillator: OscillatorNode | null = null;
let keepAliveRefCount = 0;
let visibilityListenerBound = false;

async function ensureWakeLockAndAudioActive(): Promise<void> {
  // 1. Screen/CPU WakeLock (trình duyệt & Android WebView)
  try {
    const nav =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & {
            wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
          })
        : null;
    if (nav?.wakeLock && !wakeLockSentinel) {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        wakeLockSentinel = await nav.wakeLock.request('screen');
        wakeLockSentinel.addEventListener?.('release', () => {
          wakeLockSentinel = null;
        });
      }
    }
  } catch {}

  // 2. Audio im lặng giữ WebView không bị hệ điều hành bóp CPU timer khi không có thao tác chạm
  try {
    if (typeof window !== 'undefined') {
      if (!keepAliveAudioCtx) {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0.00001; // Gần như im lặng hoàn toàn
          osc.frequency.value = 30;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          if (ctx.state === 'suspended') {
            await ctx.resume().catch(() => {});
          }
          keepAliveAudioCtx = ctx;
          keepAliveOscillator = osc;
        }
      } else if (keepAliveAudioCtx.state === 'suspended') {
        await keepAliveAudioCtx.resume().catch(() => {});
      }
    }
  } catch {}
}

function bindVisibilityRefreshListener(): void {
  if (visibilityListenerBound || typeof document === 'undefined') return;
  visibilityListenerBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && keepAliveRefCount > 0) {
      void ensureWakeLockAndAudioActive();
    }
  });
}

export async function acquireBackgroundKeepAlive(): Promise<void> {
  bindVisibilityRefreshListener();
  keepAliveRefCount += 1;
  await ensureWakeLockAndAudioActive();
}

export async function refreshBackgroundKeepAlive(): Promise<void> {
  if (keepAliveRefCount <= 0) return;
  await ensureWakeLockAndAudioActive();
}

export async function releaseBackgroundKeepAlive(): Promise<void> {
  keepAliveRefCount = Math.max(0, keepAliveRefCount - 1);
  if (keepAliveRefCount > 0) {
    return;
  }

  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch {}
    wakeLockSentinel = null;
  }
  if (keepAliveOscillator) {
    try {
      keepAliveOscillator.stop();
      keepAliveOscillator.disconnect();
    } catch {}
    keepAliveOscillator = null;
  }
  if (keepAliveAudioCtx) {
    try {
      await keepAliveAudioCtx.close();
    } catch {}
    keepAliveAudioCtx = null;
  }
}

export function getActiveKeepAliveCount(): number {
  return keepAliveRefCount;
}
