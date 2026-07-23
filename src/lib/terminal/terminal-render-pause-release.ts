/**
 * Forces a full synchronous repaint through xterm's RenderService even when its
 * IntersectionObserver still reports the screen element as not intersecting.
 *
 * On reveal (tab switch, parking-lot remount) the surface is DOM-visible but
 * xterm's own observer callback can lag a frame, leaving
 * `RenderService._isPaused === true`. While paused, `refreshRows` early-returns
 * and only latches `_needsFullRefresh`, so a plain `terminal.refresh()` is
 * swallowed: the cleared render model never repaints and the canvas keeps
 * compositing stale rows. We cannot wait for the observer, so we clear the
 * latch and drive one synchronous full render ourselves. The observer reasserts
 * authority on its next callback.
 *
 * Every access is behind a typeof guard, so an xterm upgrade that renames these
 * internals degrades to a no-op instead of throwing inside a render frame.
 */

interface MaybePausableRenderService {
  _isPaused?: boolean;
  _needsFullRefresh?: boolean;
  refreshRows?: (start: number, end: number, sync?: boolean) => void;
}

type PausableRenderService = MaybePausableRenderService & {
  refreshRows: (start: number, end: number, sync?: boolean) => void;
};

interface TerminalWithRenderService {
  rows?: number;
  _core?: {
    _renderService?: MaybePausableRenderService;
  };
}

function getRenderService(terminal: unknown): PausableRenderService | null {
  const service = (terminal as TerminalWithRenderService | null)?._core?._renderService;
  return service && typeof service.refreshRows === 'function'
    ? (service as PausableRenderService)
    : null;
}

/**
 * Clears xterm's pause latch and forces a synchronous full-viewport repaint
 * when the renderer is paused. Returns true when it drove the render, false
 * when the terminal was left untouched (not paused, or internals unavailable)
 * so the caller can fall back to its normal `terminal.refresh()`.
 */
export function forceRepaintThroughRenderPause(terminal: unknown): boolean {
  const service = getRenderService(terminal);
  if (!service || service._isPaused !== true) return false;

  const rows = (terminal as TerminalWithRenderService).rows;
  if (typeof rows !== 'number' || rows < 1) return false;

  // Leave the latch as if the pending full refresh had been serviced — it is
  // about to be — so the observer's next callback does not queue a redundant
  // second full repaint.
  service._isPaused = false;
  service._needsFullRefresh = false;
  try {
    service.refreshRows(0, rows - 1, true);
    return true;
  } catch {
    // The renderer can be torn down between the pause check and the render.
    return false;
  }
}
