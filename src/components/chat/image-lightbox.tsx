'use client';

import { telemetryClickAttributes, telemetryIgnoreAttributes } from '@/lib/telemetry/ui-click';

import { useEffect, useCallback, useRef, useState } from 'react';
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
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panRef = useRef<{ pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const suppressClickRef = useRef(false);
  const electronPlatform = useElectronPlatform();
  // On Windows the window controls are a native titleBarOverlay the page can
  // never paint above, so a close button in the top-right corner sits *under*
  // them. Drop it below the titlebar strip the app header already reserves.
  // Linux draws its controls in the DOM (this portal covers them) and macOS
  // puts them on the left, so neither needs the offset.
  const avoidsWindowControls = electronPlatform === 'win32';
  const resolvedAlt = alt || t('chat.imageOriginalView');

  // Clear any focus left behind the portal when dismissing the image. The click
  // boundary below must also prevent the message list from focusing it again.
  const closeLightbox = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    onClose();
  }, [onClose]);

  // The PTY chat view handles Escape during React's capture phase. Claim it at
  // document capture first so closing the lightbox cannot also interrupt the PTY.
  useCloseOnEscape(closeLightbox, { capture: true });

  // Scroll lock
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const handleOverlayClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // Portals still bubble through the React tree. The message list treats an
    // image/backdrop click as a blank-area click and focuses the composer after
    // closeLightbox has blurred it, reopening the mobile keyboard.
    event.stopPropagation();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    closeLightbox();
  }, [closeLightbox]);

  const zoomBy = useCallback((amount: number) => {
    setZoom((current) => Math.min(4, Math.max(0.5, current + amount)));
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 0.25 : -0.25);
  }, [zoomBy]);

  const handlePanStart = (event: React.PointerEvent<HTMLImageElement>) => {
    suppressClickRef.current = false;
    if (event.button !== 0 || panRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      offsetX: offset.x, offsetY: offset.y,
    };
    setIsPanning(true);
  };

  const handlePanMove = (event: React.PointerEvent<HTMLImageElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!suppressClickRef.current && Math.hypot(dx, dy) < 4) return;
    suppressClickRef.current = true;
    setOffset({ x: pan.offsetX + dx, y: pan.offsetY + dy });
  };

  const handlePanEnd = (event: React.PointerEvent<HTMLImageElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      {...telemetryClickAttributes('message.image.close', 'message')}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/80"
      onClick={handleOverlayClick}
      onPointerDownCapture={() => {
        if (!panRef.current) suppressClickRef.current = false;
      }}
      style={{ touchAction: 'none' }}
      onWheel={handleWheel}
      role="dialog"
      aria-modal="true"
      aria-label={resolvedAlt}
    >
      <button
        {...telemetryClickAttributes('message.image.close', 'message')}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          closeLightbox();
        }}
        className={cn(
          'absolute z-10 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors text-xl',
          avoidsWindowControls ? 'top-12' : 'top-4',
        )}
        aria-label={t('common.close')}
      >
        ×
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element -- dynamic local image, dimensions unknown */}
      <img
        src={src}
        alt=""
        draggable={false}
        onPointerDown={handlePanStart}
        onPointerMove={handlePanMove}
        onPointerUp={handlePanEnd}
        onPointerCancel={handlePanEnd}
        onLostPointerCapture={handlePanEnd}
        className={cn('max-h-[82vh] max-w-[90vw] select-none rounded-lg object-contain shadow-2xl', isPanning ? 'cursor-grabbing' : 'cursor-grab')}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
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
          onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}
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
