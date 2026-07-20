export interface TerminalScrollMetrics {
  baseY: number;
  viewportY: number;
  rows: number;
}

export interface TerminalScrollbarGeometry {
  height: number;
  top: number;
}

const DEFAULT_MIN_THUMB_HEIGHT = 28;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Convert xterm's row-based scroll state into a stable overlay thumb.
 *
 * The native Chromium scrollbar is intentionally not used here: on macOS it
 * remains an auto-hiding overlay even when CSS requests a persistent gutter.
 */
export function getTerminalScrollbarGeometry(
  metrics: TerminalScrollMetrics,
  trackHeight: number,
  minThumbHeight = DEFAULT_MIN_THUMB_HEIGHT,
): TerminalScrollbarGeometry {
  const safeTrackHeight = Math.max(0, trackHeight);
  if (safeTrackHeight === 0) return { height: 0, top: 0 };

  const rows = Math.max(1, metrics.rows);
  const baseY = Math.max(0, metrics.baseY);
  const totalRows = rows + baseY;
  const naturalHeight = safeTrackHeight * (rows / totalRows);
  const height = Math.min(
    safeTrackHeight,
    Math.max(Math.min(minThumbHeight, safeTrackHeight), naturalHeight),
  );
  const availableTravel = safeTrackHeight - height;
  const progress = baseY === 0
    ? 0
    : clamp(metrics.viewportY / baseY, 0, 1);

  return {
    height,
    top: availableTravel * progress,
  };
}
