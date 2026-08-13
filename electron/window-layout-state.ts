export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RestorableWindowState {
  bounds: WindowBounds;
  isMaximized: boolean;
  isFullScreen: boolean;
}

export interface RestorablePopoutWindowState extends RestorableWindowState {
  route: string;
}

export interface ElectronWindowLayoutState {
  version: 1;
  main: RestorableWindowState | null;
  popouts: RestorablePopoutWindowState[];
}

const MAX_RESTORED_POPOUTS = 5;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 240;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value as Partial<WindowBounds>;
  if (![x, y, width, height].every(isFiniteNumber)) return null;
  if (width! < MIN_WINDOW_WIDTH || height! < MIN_WINDOW_HEIGHT) return null;
  return { x: x!, y: y!, width: width!, height: height! };
}

function parseWindowState(value: unknown): RestorableWindowState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RestorableWindowState>;
  const bounds = parseBounds(candidate.bounds);
  if (!bounds) return null;
  return {
    bounds,
    isMaximized: candidate.isMaximized === true,
    isFullScreen: candidate.isFullScreen === true,
  };
}

function isBoardPopoutRoute(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value, 'http://localhost');
    return url.origin === 'http://localhost' && url.pathname === '/board-popout';
  } catch {
    return false;
  }
}

export function parseElectronWindowLayoutState(raw: string | null): ElectronWindowLayoutState {
  const empty: ElectronWindowLayoutState = { version: 1, main: null, popouts: [] };
  if (!raw) return empty;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return empty;
    const candidate = parsed as {
      version?: unknown;
      main?: unknown;
      popouts?: unknown;
    };
    if (candidate.version !== 1) return empty;

    const popouts = Array.isArray(candidate.popouts)
      ? candidate.popouts.flatMap((value) => {
          const windowState = parseWindowState(value);
          const route = value && typeof value === 'object'
            ? (value as { route?: unknown }).route
            : null;
          return windowState && isBoardPopoutRoute(route)
            ? [{ ...windowState, route }]
            : [];
        }).slice(0, MAX_RESTORED_POPOUTS)
      : [];

    return {
      version: 1,
      main: parseWindowState(candidate.main),
      popouts,
    };
  } catch {
    return empty;
  }
}

function intersectionArea(left: WindowBounds, right: WindowBounds): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

/** Rejects coordinates left behind by a disconnected monitor. */
export function resolveVisibleWindowBounds(
  bounds: WindowBounds | undefined,
  workAreas: readonly WindowBounds[],
): WindowBounds | undefined {
  if (!bounds) return undefined;
  const minimumVisibleArea = Math.min(bounds.width * bounds.height, 96 * 96);
  return workAreas.some((workArea) => intersectionArea(bounds, workArea) >= minimumVisibleArea)
    ? bounds
    : undefined;
}
