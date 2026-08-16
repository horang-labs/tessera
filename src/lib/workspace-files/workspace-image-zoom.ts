export const MIN_WORKSPACE_IMAGE_ZOOM = 0.25;
export const MAX_WORKSPACE_IMAGE_ZOOM = 8;
export const WORKSPACE_IMAGE_ZOOM_STEP = 1.25;
export const WORKSPACE_IMAGE_SURFACE_PADDING = 16;

export interface WorkspaceImageSize {
  width: number;
  height: number;
}

export function clampWorkspaceImageZoom(zoom: number): number {
  return Math.min(MAX_WORKSPACE_IMAGE_ZOOM, Math.max(MIN_WORKSPACE_IMAGE_ZOOM, zoom));
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
