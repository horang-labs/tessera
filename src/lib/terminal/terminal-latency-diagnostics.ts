// Explicit diagnostic builds only, independent of NODE_ENV/debug log level.
// Next replaces this expression at build time. Never retain terminal text.
export const PTY_LATENCY_ENABLED = process.env.NEXT_PUBLIC_TESSERA_PTY_LATENCY === '1';
type Entry = { at: number; stage: string; id: string; length: number; ms: number };
const entries: Entry[] = [];
const pending: Entry[] = [];
let started = false;
let activeUntil = 0;
let uploading = false;

async function upload(): Promise<void> {
  if (uploading || !pending.length) return;
  uploading = true;
  const batch = pending.splice(0, 500);
  try {
    const response = await fetch('/api/diagnostics/pty-latency', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!response.ok) pending.unshift(...batch);
  } catch { pending.unshift(...batch); }
  finally {
    if (pending.length > 3000) pending.splice(0, pending.length - 3000);
    uploading = false;
  }
}

export function traceTerminalLatency(stage: string, id: string, length = 0, ms = 0): void {
  if (!PTY_LATENCY_ENABLED || typeof window === 'undefined') return;
  activeUntil = performance.now() + 5000;
  entries.push({ at: Date.now(), stage, id, length, ms: Math.round(ms * 100) / 100 });
  pending.push(entries[entries.length - 1]);
  if (pending.length > 3000) pending.splice(0, pending.length - 3000);
  if (entries.length > 3000) entries.splice(0, entries.length - 3000);
  if (ms > 100) console.warn('[PTY-LATENCY]', entries[entries.length - 1]);
  if (started) return;
  started = true;
  Object.assign(window, { tesseraPtyLatency: { export: () => JSON.stringify(entries), clear: () => { entries.length = 0; } } });
  document.addEventListener('keydown', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.xterm')) return;
    traceTerminalLatency('keydown-dispatch', '', 0, Math.max(0, performance.now() - event.timeStamp));
  }, true);
  let previous = performance.now();
  const frame = (now: number) => {
    if (now < activeUntil && document.visibilityState === 'visible' && now - previous > 100) {
      traceTerminalLatency('animation-frame-gap', '', 0, now - previous);
    }
    previous = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Fast Refresh can recover the previous module's ring without a page reload.
if (PTY_LATENCY_ENABLED && typeof window !== 'undefined') {
  const host = window as unknown as { tesseraPtyLatency?: { export: () => string }; ptyUploadTimer?: number };
  if (host.ptyUploadTimer) window.clearInterval(host.ptyUploadTimer);
  try {
    const previous: Entry[] = JSON.parse(host.tesseraPtyLatency?.export() ?? '[]');
    entries.push(...previous.slice(-3000));
    pending.push(...previous.slice(-3000));
  } catch { /* No previous diagnostic buffer. */ }
  host.ptyUploadTimer = window.setInterval(() => { void upload(); }, 2000);
  void upload();
}
