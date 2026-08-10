'use client';

import { useCallback, useEffect, useRef } from 'react';

const PHONE_OVERLAY_STACK_KEY = '__tesseraPhoneOverlayStack';

function readPhoneOverlayStack(state: unknown): string[] {
  if (typeof state !== 'object' || state === null) return [];
  const stack = (state as Record<string, unknown>)[PHONE_OVERLAY_STACK_KEY];
  return Array.isArray(stack) && stack.every((entry) => typeof entry === 'string')
    ? stack
    : [];
}

/** Gives a phone overlay one Android/browser-Back entry without changing the URL. */
export function usePhoneOverlayNavigation({
  enabled,
  open,
  onBack,
}: {
  enabled: boolean;
  open: boolean;
  onBack: () => void;
}): (afterClose?: () => void) => void {
  const entryIdRef = useRef<string | null>(null);
  const onBackRef = useRef(onBack);
  const afterCloseRef = useRef<(() => void) | null>(null);

  useEffect(function syncPhoneOverlayBackHandler() {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(function registerPhoneOverlayHistoryEntry() {
    if (!enabled || !open || typeof window === 'undefined') return;

    const entryId = `phone-overlay-${crypto.randomUUID()}`;
    entryIdRef.current = entryId;
    const stack = readPhoneOverlayStack(window.history.state);
    window.history.pushState({
      ...(window.history.state ?? {}),
      [PHONE_OVERLAY_STACK_KEY]: [...stack, entryId],
    }, '');

    function handlePopState(event: PopStateEvent) {
      if (readPhoneOverlayStack(event.state).includes(entryId)) return;
      if (entryIdRef.current !== entryId) return;

      entryIdRef.current = null;
      const afterClose = afterCloseRef.current;
      afterCloseRef.current = null;
      onBackRef.current();
      afterClose?.();
    }

    window.addEventListener('popstate', handlePopState);
    return function unregisterPhoneOverlayHistoryEntry() {
      window.removeEventListener('popstate', handlePopState);
      if (entryIdRef.current !== entryId) return;

      entryIdRef.current = null;
      const currentStack = readPhoneOverlayStack(window.history.state);
      if (currentStack.includes(entryId)) {
        window.history.replaceState({
          ...(window.history.state ?? {}),
          [PHONE_OVERLAY_STACK_KEY]: currentStack.filter((item) => item !== entryId),
        }, '');
      }
    };
  }, [enabled, open]);

  return useCallback(function dismissPhoneOverlay(afterClose?: () => void) {
    const entryId = entryIdRef.current;
    const stack = typeof window === 'undefined'
      ? []
      : readPhoneOverlayStack(window.history.state);
    if (entryId && stack.at(-1) === entryId) {
      afterCloseRef.current = afterClose ?? null;
      window.history.back();
      return;
    }

    entryIdRef.current = null;
    onBackRef.current();
    afterClose?.();
  }, []);
}
