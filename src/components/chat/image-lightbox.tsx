'use client';

import { telemetryClickAttributes, telemetryIgnoreAttributes } from '@/lib/telemetry/ui-click';

import { useEffect, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const electronPlatform = useElectronPlatform();
  // On Windows the window controls are a native titleBarOverlay the page can
  // never paint above, so a close button in the top-right corner sits *under*
  // them. Drop it below the titlebar strip the app header already reserves.
  // Linux draws its controls in the DOM (this portal covers them) and macOS
  // puts them on the left, so neither needs the offset.
  const avoidsWindowControls = electronPlatform === 'win32';
  const resolvedAlt = alt || t('chat.imageOriginalView');

  // The PTY chat view handles Escape during React's capture phase. Claim it at
  // document capture first so closing the lightbox cannot also interrupt the PTY.
  useCloseOnEscape(onClose, { capture: true });

  // Scroll lock
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const handleOverlayClick = useCallback(() => {
    onClose();
  }, [onClose]);

  const zoomBy = useCallback((amount: number) => {
    setZoom((current) => Math.min(4, Math.max(0.5, current + amount)));
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 0.25 : -0.25);
  }, [zoomBy]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      {...telemetryClickAttributes('message.image.close', 'message')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={handleOverlayClick}
      onWheel={handleWheel}
      role="dialog"
      aria-modal="true"
      aria-label={resolvedAlt}
    >
      <button
        {...telemetryClickAttributes('message.image.close', 'message')}
        type="button"
        onClick={onClose}
        className={cn(
          'absolute right-4 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors text-xl',
          avoidsWindowControls ? 'top-12' : 'top-4',
        )}
        aria-label={t('common.close')}
      >
        ×
      </button>
      {/*
        Nothing swallows the click: clicking anywhere — the backdrop or the
        picture itself — dismisses. The old wrapper was sized to the viewport
        and stopped propagation, so the click that opened the image could not
        close it again anywhere the user would naturally aim.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element -- dynamic local image, dimensions unknown */}
      <img
        src={src}
        alt=""
        className="max-h-[82vh] max-w-[90vw] rounded-lg object-contain shadow-2xl transition-transform duration-150"
        style={{ transform: `scale(${zoom})` }}
      />
      <div
        {...telemetryIgnoreAttributes('event_boundary')}
        className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-black/70 p-1 text-white shadow-xl backdrop-blur"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          {...telemetryClickAttributes('message.image.zoom_out', 'message')}
          type="button"
          onClick={() => zoomBy(-0.25)}
          disabled={zoom <= 0.5}
          className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/15 disabled:opacity-35"
          aria-label={t('chat.imageZoomOut')}
          title={t('chat.imageZoomOut')}
        >
          <Minus className="h-4 w-4" />
        </button>
        <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
        <button
          {...telemetryClickAttributes('message.image.zoom_in', 'message')}
          type="button"
          onClick={() => zoomBy(0.25)}
          disabled={zoom >= 4}
          className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/15 disabled:opacity-35"
          aria-label={t('chat.imageZoomIn')}
          title={t('chat.imageZoomIn')}
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          {...telemetryClickAttributes('message.image.zoom_reset', 'message')}
          type="button"
          onClick={() => setZoom(1)}
          className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/15"
          aria-label={t('chat.imageZoomReset')}
          title={t('chat.imageZoomReset')}
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
