import {
  LayoutSettleRunner,
  type LayoutSettleScheduler,
} from './layout-settle-runner';

export type TerminalScrollIntent = 'follow-output' | 'pinned-viewport';

export interface TerminalScrollMarker {
  readonly isDisposed: boolean;
  readonly line: number;
  dispose(): void;
}

export interface TerminalScrollTarget {
  buffer: {
    active: {
      readonly type: 'normal' | 'alternate';
      readonly baseY: number;
      readonly viewportY: number;
      readonly cursorY: number;
    };
  };
  registerMarker(offset?: number): TerminalScrollMarker | undefined;
  scrollToBottom(): void;
  scrollToLine(line: number): void;
}

export interface TerminalScrollSnapshot {
  intent: TerminalScrollIntent;
  isAtBottom: boolean;
}

export interface TerminalScrollRestorePoint {
  readonly bufferType: 'normal' | 'alternate';
  readonly intent: TerminalScrollIntent;
  readonly marker?: TerminalScrollMarker;
  readonly revision: number;
  readonly viewportY: number;
}

export type TerminalScrollScheduler = LayoutSettleScheduler;

const BOTTOM_TOLERANCE_ROWS = 1;

function isAtBottom(target: TerminalScrollTarget): boolean {
  const { baseY, viewportY } = target.buffer.active;
  return viewportY >= baseY - BOTTOM_TOLERANCE_ROWS;
}

function safelyScroll(operation: () => void): boolean {
  try {
    operation();
    return true;
  } catch (error) {
    if (error instanceof TypeError && /dimensions/.test(error.message)) return false;
    throw error;
  }
}

export class TerminalScrollController {
  private readonly listeners = new Set<() => void>();
  private readonly layoutSettler: LayoutSettleRunner;
  private revision = 0;
  private snapshot: TerminalScrollSnapshot;

  constructor(
    private readonly target: TerminalScrollTarget,
    scheduler?: TerminalScrollScheduler,
  ) {
    this.layoutSettler = new LayoutSettleRunner(scheduler);
    const atBottom = isAtBottom(target);
    this.snapshot = {
      intent: atBottom ? 'follow-output' : 'pinned-viewport',
      isAtBottom: atBottom,
    };
  }

  getSnapshot = (): TerminalScrollSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  captureRestorePoint(): TerminalScrollRestorePoint {
    const buffer = this.target.buffer.active;
    const intent = this.snapshot.intent;
    return {
      bufferType: buffer.type,
      intent,
      marker: intent === 'pinned-viewport' && buffer.type === 'normal'
        ? this.target.registerMarker(buffer.viewportY - (buffer.baseY + buffer.cursorY))
        : undefined,
      revision: this.revision,
      viewportY: buffer.viewportY,
    };
  }

  scrollToBottom(): void {
    this.cancelPendingRestore();
    this.revision += 1;
    safelyScroll(() => this.target.scrollToBottom());
    this.updateSnapshot('follow-output');
  }

  scrollToTop(): void {
    this.cancelPendingRestore();
    this.revision += 1;
    safelyScroll(() => this.target.scrollToLine(0));
    this.updateSnapshot('pinned-viewport');
  }

  pinViewport(): void {
    this.cancelPendingRestore();
    this.revision += 1;
    this.updateSnapshot('pinned-viewport');
  }

  notifyViewportChanged(): void {
    this.updateSnapshot(this.snapshot.intent);
  }

  syncFromViewport(options: { preservePinnedAtBottom?: boolean } = {}): void {
    this.cancelPendingRestore();
    this.revision += 1;
    const atBottom = isAtBottom(this.target);
    const intent = options.preservePinnedAtBottom
      && this.snapshot.intent === 'pinned-viewport'
      && atBottom
      ? 'pinned-viewport'
      : atBottom ? 'follow-output' : 'pinned-viewport';
    this.updateSnapshot(intent);
  }

  restore(point: TerminalScrollRestorePoint): void {
    try {
      this.restoreNow(point);
    } finally {
      point.marker?.dispose();
    }
  }

  restoreAfterLayout(point: TerminalScrollRestorePoint): void {
    this.cancelPendingRestore();
    if (!this.restoreNow(point)) {
      point.marker?.dispose();
      return;
    }
    this.layoutSettler.run(
      () => {
        this.restoreNow(point);
      },
      {
        initial: 'none',
        onFinish: () => point.marker?.dispose(),
      },
    );
  }

  dispose(): void {
    this.cancelPendingRestore();
    this.listeners.clear();
  }

  private restoreNow(point: TerminalScrollRestorePoint): boolean {
    if (point.revision !== this.revision) return false;
    const buffer = this.target.buffer.active;
    if (point.bufferType === 'alternate' || buffer.type !== point.bufferType) return false;

    if (point.intent === 'follow-output') {
      if (!safelyScroll(() => this.target.scrollToBottom())) return false;
    } else {
      const markerLine = point.marker && !point.marker.isDisposed ? point.marker.line : -1;
      if (!safelyScroll(() => this.target.scrollToLine(Math.min(
        markerLine >= 0 ? markerLine : point.viewportY,
        buffer.baseY,
      )))) return false;
    }
    this.updateSnapshot(point.intent);
    return true;
  }

  cancelPendingRestore(): void {
    this.layoutSettler.cancel();
  }

  private updateSnapshot(intent: TerminalScrollIntent): void {
    const next = { intent, isAtBottom: isAtBottom(this.target) };
    if (
      this.snapshot.intent === next.intent
      && this.snapshot.isAtBottom === next.isAtBottom
    ) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
