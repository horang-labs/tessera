import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getTesseraDataPath } from '../tessera-data-dir';

export const SERVER_PTY_LATENCY_ENABLED = process.env.TESSERA_PTY_LATENCY === '1';

type Sample = { at: number; stage: string; id: string; length: number; ms: number };
type State = {
  ring: Sample[]; timer?: NodeJS.Timeout; capture?: NodeJS.Timeout;
  reports: number; previous: number; writing: boolean;
};
const key = Symbol.for('tessera.pty.server.latency');
const host = globalThis as unknown as Record<symbol, State>;
const state = host[key] ??= { ring: [], reports: 0, previous: 0, writing: false };

// Opt-in timing only. The ring is bounded; no terminal contents or commands.
export function traceServerLatency(stage: string, id = '', length = 0, ms = 0): void {
  if (!SERVER_PTY_LATENCY_ENABLED) return;
  state.ring.push({ at: Date.now(), stage, id, length, ms });
  if (state.ring.length > 6000) state.ring.splice(0, state.ring.length - 6000);
  if ((stage === 'ws-input-received' || stage === 'event-loop-lag') && !state.capture && !state.writing) {
    state.capture = setTimeout(() => {
      state.capture = undefined;
      void saveCapture();
    }, 1000);
    state.capture.unref();
  }
  if (!state.timer) {
    state.previous = performance.now();
    state.timer = setInterval(() => {
      const now = performance.now();
      const lag = now - state.previous - 100;
      state.previous = now;
      if (lag >= 100) {
        traceServerLatency('event-loop-lag', '', 0, lag);
      }
    }, 100);
    state.timer.unref();
  }
}

async function saveCapture(): Promise<void> {
  state.writing = true;
  const samples = state.ring.filter(sample => sample.at >= Date.now() - 15000);
  const report = ++state.reports;
  try {
    const directory = getTesseraDataPath('logs', 'pty-latency');
    await mkdir(directory, { recursive: true });
    // Rotate 50 bounded snapshots so extended testing does not stop recording.
    await writeFile(path.join(directory, `server-${process.pid}-${report % 50}.json`), JSON.stringify(samples));
  } catch {
    // Diagnostics must not interrupt the PTY or create a logging feedback loop.
  } finally { state.writing = false; }
}

export function startLatencySpan(stage: string, id = ''): () => void {
  if (!SERVER_PTY_LATENCY_ENABLED) return () => {};
  const start = performance.now();
  traceServerLatency(`${stage}:start`, id);
  return () => traceServerLatency(`${stage}:end`, id, 0, performance.now() - start);
}
