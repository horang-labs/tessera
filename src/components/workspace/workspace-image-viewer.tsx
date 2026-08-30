/* eslint-disable @next/next/no-img-element -- Workspace images come from an authenticated dynamic route, not a Next.js static asset. */
"use client";

import { Image as ImageIcon, RefreshCw, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { flushSync } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format-bytes';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import {
  MAX_WORKSPACE_IMAGE_ZOOM,
  MIN_WORKSPACE_IMAGE_ZOOM,
  WORKSPACE_IMAGE_ZOOM_STEP,
  clampWorkspaceImageZoom,
  getAnchoredWorkspaceImageScrollOffset,
  getWorkspaceImageLayoutSize,
  getNextWorkspaceImageWheelZoom,
  getWorkspaceImagePanScrollOffset,
  type WorkspaceImageSize,
} from '@/lib/workspace-files/workspace-image-zoom';

function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function withRetryVersion(rawUrl: string, retryAttempt: number): string {
  if (retryAttempt === 0) return rawUrl;
  return `${rawUrl}&retry=${retryAttempt}`;
}

interface ImagePanState {
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
}

export function WorkspaceImageViewer({
  path,
  rawUrl,
  size,
}: {
  path: string;
  rawUrl: string;
  size: number;
}) {
  const [surfaceElement, setSurfaceElement] = useState<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const imageLayoutRef = useRef<HTMLDivElement | null>(null);
  const panStateRef = useRef<ImagePanState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [surfaceSize, setSurfaceSize] = useState<WorkspaceImageSize | null>(null);
  const [imageSize, setImageSize] = useState<WorkspaceImageSize | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const previewSrc = withRetryVersion(rawUrl, retryAttempt);
  const imageError = failedSrc === previewSrc;
  const filename = basename(path);
  const layoutSize = useMemo(
    () => getWorkspaceImageLayoutSize({ imageSize, surfaceSize, zoom }),
    [imageSize, surfaceSize, zoom],
  );

  useEffect(function observeImageSurfaceSize() {
    const surface = surfaceElement;
    if (!surface) return;

    const updateSize = () => {
      setSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight });
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(updateSize);
    observer.observe(surface);
    return function stopObservingImageSurfaceSize() {
      observer.disconnect();
    };
  }, [surfaceElement]);

  const setSurfaceRef = useCallback((element: HTMLDivElement | null) => {
    surfaceRef.current = element;
    setSurfaceElement(element);
  }, []);

  const changeZoom = useCallback(
    (getNextZoom: (current: number) => number, anchor?: { x: number; y: number } | null): void => {
      const surface = surfaceRef.current;
      const resolvedAnchor = surface
        ? (anchor ?? { x: surface.clientWidth / 2, y: surface.clientHeight / 2 })
        : null;
      const scrollLeft = surface?.scrollLeft ?? 0;
      const scrollTop = surface?.scrollTop ?? 0;
      const surfaceRect = surface?.getBoundingClientRect();
      const imageRect = imageLayoutRef.current?.getBoundingClientRect();
      const contentOrigin = surfaceRect && imageRect
        ? imageRect.left - surfaceRect.left + scrollLeft
        : 0;
      const contentOriginTop = surfaceRect && imageRect
        ? imageRect.top - surfaceRect.top + scrollTop
        : 0;
      let currentZoom = 1;
      let nextZoom = 1;

      flushSync(() => {
        setZoom((current) => {
          currentZoom = current;
          nextZoom = clampWorkspaceImageZoom(getNextZoom(current));
          return nextZoom;
        });
      });

      if (!surface || !resolvedAnchor || currentZoom === nextZoom) return;
      const nextSurfaceRect = surface.getBoundingClientRect();
      const nextImageRect = imageLayoutRef.current?.getBoundingClientRect();
      const nextContentOrigin = nextSurfaceRect && nextImageRect
        ? nextImageRect.left - nextSurfaceRect.left + surface.scrollLeft
        : 0;
      const nextContentOriginTop = nextSurfaceRect && nextImageRect
        ? nextImageRect.top - nextSurfaceRect.top + surface.scrollTop
        : 0;
      surface.scrollLeft = getAnchoredWorkspaceImageScrollOffset({
        scrollOffset: scrollLeft,
        anchorOffset: resolvedAnchor.x,
        currentZoom,
        nextZoom,
        contentOrigin,
        nextContentOrigin,
      });
      surface.scrollTop = getAnchoredWorkspaceImageScrollOffset({
        scrollOffset: scrollTop,
        anchorOffset: resolvedAnchor.y,
        currentZoom,
        nextZoom,
        contentOrigin: contentOriginTop,
        nextContentOrigin: nextContentOriginTop,
      });
    },
    [],
  );

  const handleImageSurfaceWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const surface = surfaceRef.current;
    const rect = surface?.getBoundingClientRect();
    changeZoom(
      (current) => getNextWorkspaceImageWheelZoom(current, event.deltaY, event.deltaMode),
      rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null,
    );
  }, [changeZoom]);

  useEffect(function registerImageSurfaceWheel() {
    const surface = surfaceElement;
    if (!surface) return;
    surface.addEventListener('wheel', handleImageSurfaceWheel, { passive: false });
    return function unregisterImageSurfaceWheel() {
      surface.removeEventListener('wheel', handleImageSurfaceWheel);
    };
  }, [handleImageSurfaceWheel, surfaceElement]);

  const handlePanStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const surface = event.currentTarget;
    if (surface.scrollWidth <= surface.clientWidth && surface.scrollHeight <= surface.clientHeight) return;
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    panStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: surface.scrollLeft,
      startScrollTop: surface.scrollTop,
    };
    setIsPanning(true);
  }, []);

  const handlePanMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panStateRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    const surface = event.currentTarget;
    surface.scrollLeft = getWorkspaceImagePanScrollOffset({
      startScrollOffset: pan.startScrollLeft,
      startPointerOffset: pan.startX,
      currentPointerOffset: event.clientX,
    });
    surface.scrollTop = getWorkspaceImagePanScrollOffset({
      startScrollOffset: pan.startScrollTop,
      startPointerOffset: pan.startY,
      currentPointerOffset: event.clientY,
    });
  }, []);

  const handlePanEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panStateRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panStateRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (imageError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-(--sidebar-hover) p-8 text-center">
        <ImageIcon className="h-10 w-10 text-(--text-muted)" />
        <div>
          <p className="text-sm font-medium text-(--text-primary)">Failed to load image preview</p>
          <p className="mt-1 max-w-md break-all text-xs text-(--text-muted)">{filename}</p>
        </div>
        <Button
          {...telemetryClickAttributes('workspace_editor.image_retry', 'workspace_editor')}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setFailedSrc(null);
            setRetryAttempt((current) => current + 1);
          }}
          aria-label={`Retry loading ${filename}`}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Retry</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-image-viewer">
      <div
        ref={setSurfaceRef}
        data-testid="workspace-image-surface"
        className={`min-h-0 flex-1 select-none overflow-auto bg-(--sidebar-hover) ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
        onPointerDown={handlePanStart}
        onPointerMove={handlePanMove}
        onPointerUp={handlePanEnd}
        onPointerCancel={handlePanEnd}
        onLostPointerCapture={handlePanEnd}
      >
        <div className="flex h-max min-h-full w-max min-w-full items-center justify-center p-4">
          <div
            ref={imageLayoutRef}
            className="flex items-center justify-center"
            style={layoutSize ? { width: layoutSize.width, height: layoutSize.height } : undefined}
          >
            <img
              src={previewSrc}
              alt={filename}
              draggable={false}
              className={layoutSize ? 'block h-full w-full object-contain' : 'block max-h-full max-w-full object-contain'}
              onLoad={(event) => {
                const image = event.currentTarget;
                setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
                setFailedSrc(null);
              }}
              onError={() => setFailedSrc(previewSrc)}
            />
          </div>
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-4 border-t border-(--divider) px-4 text-xs text-(--text-muted)">
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content="Zoom out">
            <Button
              {...telemetryClickAttributes('workspace_editor.image_zoom_out', 'workspace_editor')}
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => changeZoom((current) => current / WORKSPACE_IMAGE_ZOOM_STEP)}
              disabled={zoom <= MIN_WORKSPACE_IMAGE_ZOOM}
              aria-label="Zoom out image"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content="Reset zoom">
            <Button
              {...telemetryClickAttributes('workspace_editor.image_zoom_reset', 'workspace_editor')}
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => changeZoom(() => 1)}
              disabled={zoom === 1}
              aria-label="Reset image zoom"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content="Zoom in">
            <Button
              {...telemetryClickAttributes('workspace_editor.image_zoom_in', 'workspace_editor')}
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => changeZoom((current) => current * WORKSPACE_IMAGE_ZOOM_STEP)}
              disabled={zoom >= MAX_WORKSPACE_IMAGE_ZOOM}
              aria-label="Zoom in image"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <span className="ml-1 min-w-9 tabular-nums">{Math.round(zoom * 100)}%</span>
        </div>
        <span className="min-w-0 truncate" title={filename}>{filename}</span>
        {imageSize ? <span className="shrink-0">{imageSize.width} × {imageSize.height}</span> : null}
        <span className="shrink-0">{formatBytes(size)}</span>
      </div>
    </div>
  );
}
