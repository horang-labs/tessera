// Port of orca's pane-terminal-foreground-render-settle: repaint the viewport
// as part of each foreground write, and once more after the scroll settles.
// Chromium can paint a freshly scrolled row one frame later than xterm
// finishes parsing, and the WebGL renderer's model diff can skip rows that
// changed while a frame was dropped — both leave stale or missing rows until
// something forces a repaint (classically a manual resize).

import { runGuardedWriteCompletionStep } from './terminal-write-guard';

export interface ForegroundTerminalOutputTarget {
  buffer?: {
    active?: {
      cursorY?: number;
      baseY?: number;
      viewportY?: number;
    };
  };
  rows?: number;
  _core?: {
    refresh?(start: number, end: number, sync?: boolean): void;
  };
  refresh?(start: number, end: number): void;
  write(data: string, callback?: () => void): void;
}

interface ForegroundTerminalWriteOptions {
  forceViewportRefresh?: boolean;
  followupViewportRefresh?: boolean;
  shouldRefreshViewportSynchronously?: () => boolean;
  onParsed?: () => void;
  onWriteFailure?: () => void;
}

const pendingViewportSettleRefreshByTerminal = new WeakMap<
  ForegroundTerminalOutputTarget,
  { kind: 'raf'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }
>();

interface ViewportSnapshot {
  baseY: number | null;
  viewportY: number | null;
}

function refreshVisibleRows(
  terminal: ForegroundTerminalOutputTarget,
  synchronously: boolean,
): void {
  if (typeof terminal.rows !== 'number' || terminal.rows < 1) return;

  const start = 0;
  const end = Math.max(0, terminal.rows - 1);
  try {
    // DOM-rendered rewrites need an immediate repair, while WebGL can merge
    // this full-grid request into xterm's already-queued frame.
    if (synchronously && typeof terminal._core?.refresh === 'function') {
      terminal._core.refresh(start, end, true);
      return;
    }
    if (typeof terminal.refresh === 'function') {
      terminal.refresh(start, end);
      return;
    }
    terminal._core?.refresh?.(start, end, false);
  } catch {
    // Ignore disposed terminals; PTY output can race surface teardown.
  }
}

function captureViewportSnapshot(terminal: ForegroundTerminalOutputTarget): ViewportSnapshot {
  return {
    baseY: typeof terminal.buffer?.active?.baseY === 'number' ? terminal.buffer.active.baseY : null,
    viewportY:
      typeof terminal.buffer?.active?.viewportY === 'number'
        ? terminal.buffer.active.viewportY
        : null,
  };
}

function viewportChangedDuringWrite(
  terminal: ForegroundTerminalOutputTarget,
  beforeWrite: ViewportSnapshot,
): boolean {
  const afterWrite = captureViewportSnapshot(terminal);
  return (
    afterWrite.baseY !== null
    && afterWrite.viewportY !== null
    && (afterWrite.baseY !== beforeWrite.baseY || afterWrite.viewportY !== beforeWrite.viewportY)
  );
}

function cancelScheduledViewportSettleRefresh(terminal: ForegroundTerminalOutputTarget): void {
  const pending = pendingViewportSettleRefreshByTerminal.get(terminal);
  if (!pending) return;
  pendingViewportSettleRefreshByTerminal.delete(terminal);
  if (pending.kind === 'raf') {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pending.id);
    return;
  }
  clearTimeout(pending.id);
}

function scheduleViewportSettleRefresh(
  terminal: ForegroundTerminalOutputTarget,
  shouldRefreshSynchronously?: () => boolean,
): void {
  cancelScheduledViewportSettleRefresh(terminal);
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => {
      pendingViewportSettleRefreshByTerminal.delete(terminal);
      refreshVisibleRows(terminal, shouldRefreshSynchronously?.() ?? true);
    });
    pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'raf', id });
    return;
  }

  const id = setTimeout(() => {
    pendingViewportSettleRefreshByTerminal.delete(terminal);
    refreshVisibleRows(terminal, shouldRefreshSynchronously?.() ?? true);
  }, 16);
  pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'timeout', id });
}

function settleForegroundRender(
  terminal: ForegroundTerminalOutputTarget,
  beforeWriteViewport: ViewportSnapshot,
  options: ForegroundTerminalWriteOptions,
): void {
  refreshVisibleRows(terminal, options.shouldRefreshViewportSynchronously?.() ?? true);
  // When output advances the viewport, Chromium can paint the freshly scrolled
  // top row one frame later than xterm finishes parsing. Repaint once more
  // after the scroll settles so the user doesn't need to jiggle the window.
  if (
    options.followupViewportRefresh
    || viewportChangedDuringWrite(terminal, beforeWriteViewport)
  ) {
    scheduleViewportSettleRefresh(terminal, options.shouldRefreshViewportSynchronously);
  }
}

export function writeForegroundTerminalChunk(
  terminal: ForegroundTerminalOutputTarget,
  data: string,
  options: ForegroundTerminalWriteOptions = {},
): boolean {
  const beforeWriteViewport = options.forceViewportRefresh
    ? captureViewportSnapshot(terminal)
    : null;
  // Guarded steps: this callback runs inside xterm's WriteBuffer loop, where an
  // escaping throw permanently wedges the terminal. Guard settle and onParsed
  // separately so a renderer failure during settle can't starve the rest.
  const runParsedSteps = (): void => {
    if (beforeWriteViewport) {
      runGuardedWriteCompletionStep('foreground-render-settle', () =>
        settleForegroundRender(terminal, beforeWriteViewport, options));
    }
    if (options.onParsed) {
      runGuardedWriteCompletionStep('foreground-on-parsed', options.onParsed);
    }
  };
  try {
    terminal.write(data, runParsedSteps);
    return true;
  } catch {
    if (options.onWriteFailure) {
      runGuardedWriteCompletionStep('foreground-on-write-failure', options.onWriteFailure);
    }
    return false;
  }
}

export function discardForegroundRenderSettle(terminal: ForegroundTerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal);
}
