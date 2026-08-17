export const MIN_WORKSPACE_IMAGE_ZOOM = 0.25;
export const MAX_WORKSPACE_IMAGE_ZOOM = 8;
export const WORKSPACE_IMAGE_ZOOM_STEP = 1.25;
export const WORKSPACE_IMAGE_SURFACE_PADDING = 16;

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const PIXELS_PER_LINE = 16;
const PIXELS_PER_PAGE = 800;
const MAX_NORMALIZED_WHEEL_DELTA = 200;
const WHEEL_ZOOM_SENSITIVITY = 300;

export interface WorkspaceImageSize {
  width: number;
  height: number;
}

export function clampWorkspaceImageZoom(zoom: number): number {
  return Math.min(MAX_WORKSPACE_IMAGE_ZOOM, Math.max(MIN_WORKSPACE_IMAGE_ZOOM, zoom));
}

export function getWorkspaceImageWheelZoomFactor(deltaY: number, deltaMode: number): number {
  if (deltaY === 0) return 1;

  const normalizedDeltaY = deltaMode === DOM_DELTA_LINE
    ? deltaY * PIXELS_PER_LINE
    : deltaMode === DOM_DELTA_PAGE ? deltaY * PIXELS_PER_PAGE : deltaY;
  const boundedDeltaY = Math.max(
    -MAX_NORMALIZED_WHEEL_DELTA,
    Math.min(MAX_NORMALIZED_WHEEL_DELTA, normalizedDeltaY),
  );
  return Math.exp(-boundedDeltaY / WHEEL_ZOOM_SENSITIVITY);
}

export function getNextWorkspaceImageWheelZoom(
  currentZoom: number,
  deltaY: number,
  deltaMode: number,
): number {
  return clampWorkspaceImageZoom(
    currentZoom * getWorkspaceImageWheelZoomFactor(deltaY, deltaMode),
  );
}

export function getAnchoredWorkspaceImageScrollOffset({
  scrollOffset,
  anchorOffset,
  currentZoom,
  nextZoom,
  contentOrigin = 0,
  nextContentOrigin = 0,
}: {
  scrollOffset: number;
  anchorOffset: number;
  currentZoom: number;
  nextZoom: number;
  contentOrigin?: number;
  nextContentOrigin?: number;
}): number {
  if (currentZoom <= 0) return scrollOffset;
  const contentOffset = scrollOffset + anchorOffset - contentOrigin;
  return nextContentOrigin + contentOffset * (nextZoom / currentZoom) - anchorOffset;
}

export function getWorkspaceImagePanScrollOffset({
  startScrollOffset,
  startPointerOffset,
  currentPointerOffset,
}: {
  startScrollOffset: number;
  startPointerOffset: number;
  currentPointerOffset: number;
}): number {
  return startScrollOffset - (currentPointerOffset - startPointerOffset);
}

export function getWorkspaceImageLayoutSize({
  imageSize,
  surfaceSize,
  zoom,
  padding = WORKSPACE_IMAGE_SURFACE_PADDING,
}: {
  imageSize: WorkspaceImageSize | null;
  surfaceSize: WorkspaceImageSize | null;
  zoom: number;
  padding?: number;
}): WorkspaceImageSize | null {
  if (
    !imageSize
    || !surfaceSize
    || imageSize.width <= 0
    || imageSize.height <= 0
    || surfaceSize.width <= 0
    || surfaceSize.height <= 0
  ) return null;

  const availableWidth = Math.max(0, surfaceSize.width - padding * 2);
  const availableHeight = Math.max(0, surfaceSize.height - padding * 2);
  if (availableWidth <= 0 || availableHeight <= 0) return null;

  const fitScale = Math.min(
    1,
    availableWidth / imageSize.width,
    availableHeight / imageSize.height,
  );
  const boundedZoom = clampWorkspaceImageZoom(zoom);
  return {
    width: imageSize.width * fitScale * boundedZoom,
    height: imageSize.height * fitScale * boundedZoom,
  };
}
