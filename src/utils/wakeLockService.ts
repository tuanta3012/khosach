import { Capacitor } from '@capacitor/core';

let wakeLockSentinel: WakeLockSentinel | null = null;
let keepAliveAudioCtx: AudioContext | null = null;
let keepAliveOscillator: OscillatorNode | null = null;

export async function acquireBackgroundKeepAlive(): Promise<void> {
  // 1. Screen WakeLock (trình duyệt & Android WebView)
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> } }) : null;
    if (nav?.wakeLock && !wakeLockSentinel) {
      wakeLockSentinel = await nav.wakeLock.request('screen');
      wakeLockSentinel.addEventListener?.('release', () => {
        wakeLockSentinel = null;
      });
    }
  } catch {}

  // 2. Audio im lặng giữ WebView không bị hệ điều hành bóp CPU timer khi chạy ngầm hoặc không có touch event
  try {
    if (typeof window !== 'undefined' && !keepAliveAudioCtx) {
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
    }
  } catch {}
}

export async function releaseBackgroundKeepAlive(): Promise<void> {
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
