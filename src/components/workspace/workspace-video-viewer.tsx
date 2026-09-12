"use client";

import { AlertCircle, RefreshCw, Scan, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

const MIN_VIDEO_ZOOM = 0.5;
const MAX_VIDEO_ZOOM = 4;
const VIDEO_ZOOM_STEP = 0.5;

interface VideoSize {
  width: number;
  height: number;
}

function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function withRetryVersion(rawUrl: string, retryAttempt: number): string {
  return retryAttempt === 0 ? rawUrl : `${rawUrl}&retry=${retryAttempt}`;
}

export function WorkspaceVideoViewer({
  active,
  path,
  rawUrl,
}: {
  active: boolean;
  path: string;
  rawUrl: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [surfaceElement, setSurfaceElement] = useState<HTMLDivElement | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [surfaceSize, setSurfaceSize] = useState<VideoSize | null>(null);
  const [videoSize, setVideoSize] = useState<VideoSize | null>(null);
  const previewSrc = withRetryVersion(rawUrl, retryAttempt);
  const filename = basename(path);
  const hasError = failedSrc === previewSrc;

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  useEffect(() => () => {
    videoRef.current?.pause();
  }, []);

  useEffect(() => {
    if (!surfaceElement) return;
    const updateSize = () => setSurfaceSize({
      width: surfaceElement.clientWidth,
      height: surfaceElement.clientHeight,
    });
    updateSize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(surfaceElement);
    return () => observer.disconnect();
  }, [surfaceElement]);

  const keepVideoInteractionLocal = useCallback((event: KeyboardEvent<HTMLVideoElement>) => {
    event.stopPropagation();
  }, []);

  const fittedSize = videoSize && surfaceSize && surfaceSize.width > 0 && surfaceSize.height > 0
    ? (() => {
      const scale = Math.min(surfaceSize.width / videoSize.width, surfaceSize.height / videoSize.height);
      return { width: videoSize.width * scale * zoom, height: videoSize.height * scale * zoom };
    })()
    : null;

  if (hasError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-black p-8 text-center" data-testid="workspace-video-error">
        <AlertCircle className="h-10 w-10 text-(--text-muted)" />
        <div>
          <p className="text-sm font-medium text-(--text-primary)">Unable to play video preview</p>
          <p className="mt-1 max-w-md text-xs leading-5 text-(--text-muted)">
            This video could not be loaded. Its codec may be unsupported, or the file may be unreadable or damaged. Try opening it with another app.
          </p>
        </div>
        <Button
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
    <div className="flex h-full min-h-0 flex-col bg-black" data-testid="workspace-video-viewer">
      <div
        ref={setSurfaceElement}
        className="min-h-0 flex-1 overflow-auto p-4"
        data-testid="workspace-video-surface"
      >
        <div className="flex min-h-full min-w-full items-center justify-center">
          <video
            ref={videoRef}
            key={previewSrc}
            controls
            playsInline
            preload="metadata"
            src={previewSrc}
            className={fittedSize ? 'block shrink-0' : 'max-h-full max-w-full object-contain'}
            style={fittedSize ? { width: fittedSize.width, height: fittedSize.height } : undefined}
            aria-label={`Video preview: ${filename}`}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              setVideoSize({ width: video.videoWidth, height: video.videoHeight });
              setFailedSrc(null);
            }}
            onError={() => setFailedSrc(previewSrc)}
            onKeyDown={keepVideoInteractionLocal}
          />
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center justify-center gap-1 border-t border-(--divider) px-3 text-xs text-(--text-muted)">
        <Tooltip content="Zoom out (relative to fit)">
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom((current) => Math.max(MIN_VIDEO_ZOOM, current - VIDEO_ZOOM_STEP))} disabled={zoom <= MIN_VIDEO_ZOOM} aria-label="Zoom out video">
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <span className="min-w-10 text-center tabular-nums" aria-label={`Video zoom ${Math.round(zoom * 100)} percent`}>{Math.round(zoom * 100)}%</span>
        <Tooltip content="Zoom in (relative to fit)">
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom((current) => Math.min(MAX_VIDEO_ZOOM, current + VIDEO_ZOOM_STEP))} disabled={zoom >= MAX_VIDEO_ZOOM} aria-label="Zoom in video">
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="Fit video to available area (100%)">
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(1)} disabled={zoom === 1} aria-label="Fit video to available area">
            <Scan className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
