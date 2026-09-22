import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { ReplayedInvocation } from './replay-repair';
import type { ReplayDiagnostic } from './replay-diagnostics';

// Metadata-only replay passed the bounded RSS and recorded-image regressions.
export const IMAGE_REFERENCE_REPLAY_ENABLED = true;
// Bump when replay semantics change so unchanged recordings are re-evaluated.
export const IMAGE_REFERENCE_REPLAY_VERSION = 5;

interface ReplayResult {
  invocations: ReplayedInvocation[];
  diagnostics: ReplayDiagnostic[];
  cells: number;
}
interface ReplayRequest { sessionId: string; path: string; offset: number; reset?: boolean }

/** One lazy worker per backend, with serialized requests and no renderer execution. */
class ReplayWorker {
  private worker?: Worker;
  private tail: Promise<unknown> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  private sequence = 0;

  run(request: ReplayRequest, signal?: AbortSignal): Promise<ReplayResult> {
    const task = this.tail.catch(() => {}).then(() => this.execute(request, signal));
    this.tail = task.catch(() => {});
    return task;
  }

  private execute(request: ReplayRequest, signal?: AbortSignal): Promise<ReplayResult> {
    // Only the metadata sidecar is accepted from the image index; image payloads stay on disk.
    if (!IMAGE_REFERENCE_REPLAY_ENABLED) return Promise.reject(new Error('Image reference replay is disabled'));
    if (signal?.aborted) return Promise.reject(new Error('Image replay aborted'));
    clearTimeout(this.idle);
    const worker = this.worker ??= new Worker(path.join(process.env.TESSERA_APP_ROOT || process.cwd(),
      'runtime', 'image-reference-replay-worker.cjs'), { resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 } });
    worker.ref();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: ReplayResult, terminate = false) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        worker.off('message', message); worker.off('error', failure); worker.off('exit', exited);
        if (terminate) { this.worker = undefined; void worker.terminate(); }
        else {
          worker.unref();
          this.idle = setTimeout(() => { if (this.worker === worker) this.worker = undefined; void worker.terminate(); }, 60_000);
          this.idle.unref();
        }
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(new Error('Image replay aborted'), undefined, true);
      const failure = (error: Error) => finish(error, undefined, true);
      const exited = (code: number) => finish(new Error(`Image replay worker exited (${code})`), undefined, true);
      const message = (reply: { id: number; result?: ReplayResult; error?: string }) => {
        if (reply.id === id) finish(reply.error ? new Error(reply.error) : undefined, reply.result);
      };
      const timeout = setTimeout(() => finish(new Error('Image replay time limit exceeded'), undefined, true), 30_000);
      worker.on('message', message); worker.once('error', failure); worker.once('exit', exited);
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage({ id, ...request });
    });
  }
}
const key = Symbol.for('tessera.imageReplayWorker');
const state = globalThis as unknown as Record<symbol, ReplayWorker>;
export const replayImageReferences = (request: ReplayRequest, signal?: AbortSignal): Promise<ReplayResult> =>
  (state[key] ??= new ReplayWorker()).run(request, signal);
