/* eslint-disable @next/next/no-img-element -- Workspace images come from an authenticated dynamic route, not a Next.js static asset. */
"use client";

import { Image as ImageIcon, RefreshCw, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format-bytes';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import {
  MAX_WORKSPACE_IMAGE_ZOOM,
  MIN_WORKSPACE_IMAGE_ZOOM,
  WORKSPACE_IMAGE_ZOOM_STEP,
  clampWorkspaceImageZoom,
  getWorkspaceImageLayoutSize,
  type WorkspaceImageSize,
} from '@/lib/workspace-files/workspace-image-zoom';

function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function withRetryVersion(rawUrl: string, retryAttempt: number): string {
  if (retryAttempt === 0) return rawUrl;
  return `${rawUrl}&retry=${retryAttempt}`;
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
  const [zoom, setZoom] = useState(1);
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

  function changeZoom(getNextZoom: (current: number) => number): void {
    setZoom((current) => clampWorkspaceImageZoom(getNextZoom(current)));
  }

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
        ref={setSurfaceElement}
        className="min-h-0 flex-1 overflow-auto bg-(--sidebar-hover)"
      >
        <div className="flex h-max min-h-full w-max min-w-full items-center justify-center p-4">
          <div
            className="flex items-center justify-center"
            style={layoutSize ? { width: layoutSize.width, height: layoutSize.height } : undefined}
          >
            <img
              src={previewSrc}
              alt={filename}
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
              onClick={() => setZoom(1)}
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
