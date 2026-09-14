"use client";

import { AlertCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';

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
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const previewSrc = withRetryVersion(rawUrl, retryAttempt);
  const filename = basename(path);
  const hasError = failedSrc === previewSrc;

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  useEffect(() => () => {
    videoRef.current?.pause();
  }, []);

  const keepVideoInteractionLocal = useCallback((event: KeyboardEvent<HTMLVideoElement>) => {
    event.stopPropagation();
  }, []);

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
    <div className="flex h-full min-h-0 items-center justify-center overflow-hidden bg-black p-4" data-testid="workspace-video-viewer">
          <video
            ref={videoRef}
            key={previewSrc}
            controls
            playsInline
            preload="metadata"
            src={previewSrc}
            className="max-h-full max-w-full object-contain"
            aria-label={`Video preview: ${filename}`}
            onLoadedMetadata={() => setFailedSrc(null)}
            onError={() => setFailedSrc(previewSrc)}
            onKeyDown={keepVideoInteractionLocal}
          />
    </div>
  );
}
