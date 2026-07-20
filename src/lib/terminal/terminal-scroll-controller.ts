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
  readonly baseY: number;
  readonly bottomOffset: number;
  readonly bufferType: 'normal' | 'alternate';
  readonly intent: TerminalScrollIntent;
  readonly marker?: TerminalScrollMarker;
  readonly revision: number;
}

export type TerminalScrollScheduler = LayoutSettleScheduler;

const BOTTOM_TOLERANCE_ROWS = 1;

/**
 * Tracks a wheel/key scroll while xterm applies its viewport change.
 *
 * A fullscreen TUI can consume the input without moving xterm. Preserve the
 * provisional pin for the early frames, then classify from the real viewport
 * at settle time so a pin at the bottom cannot survive into the next resize.
 */
export function scheduleTerminalScrollIntentSync(
  controller: TerminalScrollController,
  settler: LayoutSettleRunner,
  preservePinnedAtBottom: boolean,
  canSync: () => boolean = () => true,
): void {
  const sync = () => {
    if (canSync()) controller.syncFromViewport({ preservePinnedAtBottom });
  };
  settler.run(sync, {
    initial: 'microtask',
    settledOperation: preservePinnedAtBottom
      ? () => {
          if (canSync()) controller.syncFromViewport();
        }
      : sync,
  });
}

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
  private bufferRebuildActive = false;
  private lastObservedBaseY: number;
  private readonly listeners = new Set<() => void>();
  private readonly layoutSettler: LayoutSettleRunner;
  private pinnedBottomOffset: number | null = null;
  private revision = 0;
  private snapshot: TerminalScrollSnapshot;

  constructor(
    private readonly target: TerminalScrollTarget,
    scheduler?: TerminalScrollScheduler,
  ) {
    this.layoutSettler = new LayoutSettleRunner(scheduler);
    this.lastObservedBaseY = target.buffer.active.baseY;
    const atBottom = isAtBottom(target);
    this.snapshot = {
      intent: atBottom ? 'follow-output' : 'pinned-viewport',
      isAtBottom: atBottom,
    };
    if (!atBottom) {
      this.pinnedBottomOffset = Math.max(0, target.buffer.active.baseY - target.buffer.active.viewportY);
    }
  }

  getSnapshot = (): TerminalScrollSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  captureRestorePoint(): TerminalScrollRestorePoint {
    const buffer = this.target.buffer.active;
    const intent = this.snapshot.intent;
    // A resize redraw can clear scrollback before the previous write callback
    // runs. Do not let later chunks create fresh line-0 markers during that gap.
    if (
      intent === 'pinned-viewport'
      && buffer.type === 'normal'
      && buffer.baseY === 0
      && this.lastObservedBaseY > 0
    ) {
      this.bufferRebuildActive = true;
    }
    if (!this.bufferRebuildActive) this.lastObservedBaseY = buffer.baseY;
    const point: TerminalScrollRestorePoint = {
      baseY: buffer.baseY,
      bottomOffset: intent === 'pinned-viewport'
        ? this.pinnedBottomOffset ?? Math.max(0, buffer.baseY - buffer.viewportY)
        : 0,
      bufferType: buffer.type,
      intent,
      marker: intent === 'pinned-viewport'
        && buffer.type === 'normal'
        && !this.bufferRebuildActive
        ? this.target.registerMarker(buffer.viewportY - (buffer.baseY + buffer.cursorY))
        : undefined,
      revision: this.revision,
    };
    return point;
  }

  scrollToBottom(): void {
    this.cancelPendingRestore();
    this.revision += 1;
    safelyScroll(() => this.target.scrollToBottom());
    this.finishBufferRebuild();
    this.pinnedBottomOffset = null;
    this.updateSnapshot('follow-output');
  }

  scrollToTop(): void {
    this.cancelPendingRestore();
    this.revision += 1;
    safelyScroll(() => this.target.scrollToLine(0));
    this.finishBufferRebuild();
    this.pinnedBottomOffset = this.target.buffer.active.baseY;
    this.updateSnapshot('pinned-viewport');
  }

  pinViewport(): void {
    this.cancelPendingRestore();
    this.revision += 1;
    const buffer = this.target.buffer.active;
    this.finishBufferRebuild();
    this.pinnedBottomOffset = Math.max(0, buffer.baseY - buffer.viewportY);
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
    if (intent === 'follow-output') {
      this.finishBufferRebuild();
      this.pinnedBottomOffset = null;
    } else if (!atBottom) {
      this.finishBufferRebuild();
      this.pinnedBottomOffset = Math.max(
        0,
        this.target.buffer.active.baseY - this.target.buffer.active.viewportY,
      );
    }
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

  finishBufferRebuild(): void {
    this.bufferRebuildActive = false;
    this.lastObservedBaseY = this.target.buffer.active.baseY;
  }

  private restoreNow(point: TerminalScrollRestorePoint): boolean {
    if (point.revision !== this.revision) return false;
    const buffer = this.target.buffer.active;
    if (point.bufferType === 'alternate' || buffer.type !== point.bufferType) return false;

    if (point.intent === 'follow-output') {
      if (!safelyScroll(() => this.target.scrollToBottom())) return false;
      this.pinnedBottomOffset = null;
    } else {
      if (buffer.baseY < point.baseY) this.bufferRebuildActive = true;
      const markerLine = !this.bufferRebuildActive
        && point.marker
        && !point.marker.isDisposed
        ? point.marker.line
        : -1;
      const targetLine = Math.min(
        markerLine >= 0
          ? markerLine
          // Once a TUI clears and rebuilds the buffer, absolute rows and old
          // markers are invalid. Preserve the reader's distance from bottom.
          : Math.max(0, buffer.baseY - point.bottomOffset),
        buffer.baseY,
      );
      if (!safelyScroll(() => this.target.scrollToLine(targetLine))) return false;
      this.pinnedBottomOffset = markerLine >= 0
        ? Math.max(0, buffer.baseY - buffer.viewportY)
        : point.bottomOffset;
    }
    if (!this.bufferRebuildActive) this.lastObservedBaseY = buffer.baseY;
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
