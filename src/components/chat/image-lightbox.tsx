'use client';

import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
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
  const electronPlatform = useElectronPlatform();
  // On Windows the window controls are a native titleBarOverlay the page can
  // never paint above, so a close button in the top-right corner sits *under*
  // them. Drop it below the titlebar strip the app header already reserves.
  // Linux draws its controls in the DOM (this portal covers them) and macOS
  // puts them on the left, so neither needs the offset.
  const avoidsWindowControls = electronPlatform === 'win32';
  const resolvedAlt = alt || t('chat.imageOriginalView');

  // ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

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

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label={resolvedAlt}
    >
      <button
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
        alt={resolvedAlt}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
      />
    </div>,
    document.body,
  );
}
