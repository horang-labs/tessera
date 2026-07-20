export interface TerminalPtyResizeRequest {
  cols: number;
  rows: number;
  claim: boolean;
}

export interface TerminalPtyResizeHold {
  flush(): void;
  cancel(): void;
}

interface PendingTerminalPtyResize {
  request: TerminalPtyResizeRequest;
  send: (request: TerminalPtyResizeRequest) => void;
}

export type TerminalPtyResizeFlushScheduler = (flush: () => void) => () => void;

export const TERMINAL_RESIZE_SETTLE_DELAY_MS = 150;
const TERMINAL_RESIZE_SETTLE_FRAMES = 9;

const scheduleFlushAfterLayoutSettles: TerminalPtyResizeFlushScheduler = (flush) => {
  let frameId: number | null = null;
  let remainingFrames = TERMINAL_RESIZE_SETTLE_FRAMES;
  const timerId = window.setTimeout(() => {
    const waitForFrame = () => {
      frameId = window.requestAnimationFrame(() => {
        remainingFrames -= 1;
        if (remainingFrames > 0) waitForFrame();
        else flush();
      });
    };
    waitForFrame();
  }, TERMINAL_RESIZE_SETTLE_DELAY_MS);

  return () => {
    window.clearTimeout(timerId);
    if (frameId !== null) window.cancelAnimationFrame(frameId);
  };
};

/**
 * Keeps divider-drag reflow local to xterm and emits only the final grid size to
 * each PTY. Repeated SIGWINCH delivery while a fullscreen TUI is repainting can
 * otherwise reset the application's own viewport.
 */
export class TerminalPtyResizeHoldCoordinator {
  private holdDepth = 0;
  private readonly pendingBySurface = new Map<string, PendingTerminalPtyResize>();
  private flushRequested = false;
  private cancelScheduledFlush: (() => void) | null = null;

  constructor(
    private readonly scheduleFlush: TerminalPtyResizeFlushScheduler = scheduleFlushAfterLayoutSettles,
  ) {}

  begin(): TerminalPtyResizeHold {
    this.cancelScheduledFlush?.();
    this.cancelScheduledFlush = null;
    this.flushRequested = false;
    this.holdDepth += 1;
    let released = false;

    const release = (flush: boolean) => {
      if (released) return;
      released = true;
      this.holdDepth = Math.max(0, this.holdDepth - 1);

      if (!flush) {
        this.pendingBySurface.clear();
        this.flushRequested = false;
        this.cancelScheduledFlush?.();
        this.cancelScheduledFlush = null;
      }
      if (this.holdDepth > 0) return;
      if (flush) {
        this.flushRequested = true;
        this.schedulePendingFlush();
      }
    };

    return {
      flush: () => release(true),
      cancel: () => release(false),
    };
  }

  queueIfHeld(
    surfaceId: string,
    request: TerminalPtyResizeRequest,
    send: (request: TerminalPtyResizeRequest) => void,
  ): boolean {
    if (this.holdDepth === 0 && !this.flushRequested) return false;

    const previous = this.pendingBySurface.get(surfaceId);
    this.pendingBySurface.set(surfaceId, {
      request: {
        ...request,
        claim: request.claim || previous?.request.claim === true,
      },
      send,
    });
    return true;
  }

  deferFlushIfHeld(): void {
    if (!this.flushRequested) return;
    this.schedulePendingFlush();
  }

  private schedulePendingFlush(): void {
    this.cancelScheduledFlush?.();
    this.cancelScheduledFlush = this.scheduleFlush(() => {
      this.cancelScheduledFlush = null;
      this.flushRequested = false;
      this.flushPending();
    });
  }

  private flushPending(): void {
    const pending = [...this.pendingBySurface.values()];
    this.pendingBySurface.clear();
    for (const { request, send } of pending) send(request);
  }
}

const terminalPtyResizeHoldCoordinator = new TerminalPtyResizeHoldCoordinator();

export function holdTerminalPtyResizes(): TerminalPtyResizeHold {
  return terminalPtyResizeHoldCoordinator.begin();
}

export function queueTerminalPtyResizeIfHeld(
  surfaceId: string,
  request: TerminalPtyResizeRequest,
  send: (request: TerminalPtyResizeRequest) => void,
): boolean {
  return terminalPtyResizeHoldCoordinator.queueIfHeld(surfaceId, request, send);
}

export function deferTerminalPtyResizeFlushIfHeld(): void {
  terminalPtyResizeHoldCoordinator.deferFlushIfHeld();
}
