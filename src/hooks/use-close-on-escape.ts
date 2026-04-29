'use client';

import { useEffect } from 'react';

export interface UseCloseOnEscapeOptions {
  enabled?: boolean;
  capture?: boolean;
}

export function useCloseOnEscape(
  onClose: () => void,
  { enabled = true, capture = false }: UseCloseOnEscapeOptions = {},
): void {
  useEffect(() => {
    if (!enabled) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      if (capture) {
        event.preventDefault();
        event.stopPropagation();
      }

      onClose();
    };

    document.addEventListener('keydown', handleEscape, capture);
    return () => document.removeEventListener('keydown', handleEscape, capture);
  }, [capture, enabled, onClose]);
}
