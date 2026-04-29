'use client';

import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { useI18n } from '@/lib/i18n';

export interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const { t } = useI18n();
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

  const handleImageClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

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
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors text-xl"
        aria-label={t('common.close')}
      >
        ×
      </button>
      <div
        className="relative w-[90vw] h-[90vh]"
        onClick={handleImageClick}
      >
        <Image
          src={src}
          alt={resolvedAlt}
          fill
          unoptimized
          sizes="90vw"
          className="object-contain rounded-lg shadow-2xl"
        />
      </div>
    </div>,
    document.body,
  );
}
