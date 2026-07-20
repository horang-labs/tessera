export interface LayoutSettleScheduler {
  cancelAnimationFrame(id: number): void;
  clearTimeout(id: number): void;
  queueMicrotask(callback: () => void): void;
  requestAnimationFrame(callback: () => void): number;
  setTimeout(callback: () => void, delayMs: number): number;
}

export type LayoutSettleInitialRun = 'microtask' | 'none';

const browserScheduler: LayoutSettleScheduler = {
  cancelAnimationFrame: (id) => cancelAnimationFrame(id),
  clearTimeout: (id) => window.clearTimeout(id),
  queueMicrotask: (callback) => queueMicrotask(callback),
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
};

interface PendingLayoutSettleRun {
  cancelled: boolean;
  frameIds: number[];
  onFinish?: () => void;
  timerId: number;
}

/**
 * Repeats an operation while browser layout and xterm rendering settle.
 *
 * ResizeObserver, xterm reflow, and WebGL painting do not finish in the same
 * frame. Keeping this schedule in one place prevents input tracking and marker
 * restoration from drifting onto subtly different timing policies.
 */
export class LayoutSettleRunner {
  private pending: PendingLayoutSettleRun | null = null;

  constructor(private readonly scheduler: LayoutSettleScheduler = browserScheduler) {}

  run(
    operation: () => void,
    options: {
      initial: LayoutSettleInitialRun;
      onFinish?: () => void;
    },
  ): void {
    this.cancel();
    const pending: PendingLayoutSettleRun = {
      cancelled: false,
      frameIds: [],
      onFinish: options.onFinish,
      timerId: 0,
    };
    this.pending = pending;

    const invoke = () => {
      if (!pending.cancelled) operation();
    };
    if (options.initial === 'microtask') this.scheduler.queueMicrotask(invoke);

    const firstFrameId = this.scheduler.requestAnimationFrame(() => {
      invoke();
      if (pending.cancelled) return;
      pending.frameIds.push(this.scheduler.requestAnimationFrame(invoke));
    });
    pending.frameIds.push(firstFrameId);
    pending.timerId = this.scheduler.setTimeout(() => {
      invoke();
      this.finish(pending);
    }, 80);
  }

  cancel(): void {
    if (this.pending) this.finish(this.pending);
  }

  private finish(pending: PendingLayoutSettleRun): void {
    if (pending.cancelled) return;
    pending.cancelled = true;
    for (const frameId of pending.frameIds) this.scheduler.cancelAnimationFrame(frameId);
    this.scheduler.clearTimeout(pending.timerId);
    pending.onFinish?.();
    if (this.pending === pending) this.pending = null;
  }
}
