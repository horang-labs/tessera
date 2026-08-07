'use client';

import { useSyncExternalStore } from 'react';
import { PHONE_VIEWPORT_MEDIA_QUERY } from '@/lib/viewport/phone-viewport';

// One MediaQueryList shared by every caller, like use-is-dark's observer.
let query: MediaQueryList | null = null;

function getQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  query ??= window.matchMedia(PHONE_VIEWPORT_MEDIA_QUERY);
  return query;
}

function subscribe(callback: () => void) {
  const list = getQuery();
  if (!list) return () => {};
  list.addEventListener('change', callback);
  return () => list.removeEventListener('change', callback);
}

function getSnapshot(): boolean {
  return getQuery()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Whether the viewport is a Phone viewport (<640px).
 *
 * Desktop non-regression is the point of the `false` fallbacks: without a
 * window, without `matchMedia`, and on the server, this is not a phone, so a
 * desktop tree is what renders.
 */
export function usePhoneViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
