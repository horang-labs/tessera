'use client';

import { useCallback, useSyncExternalStore } from 'react';

// One MediaQueryList per query, shared by every caller, like use-is-dark's observer.
const queries = new Map<string, MediaQueryList>();

function getQuery(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  let list = queries.get(query);
  if (!list) {
    list = window.matchMedia(query);
    queries.set(query, list);
  }
  return list;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Whether a media query matches, re-rendering when it stops or starts.
 *
 * Desktop non-regression is the point of the `false` fallbacks: without a
 * window, without `matchMedia`, and on the server, nothing matches, so a
 * desktop tree is what renders.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((callback: () => void) => {
    const list = getQuery(query);
    if (!list) return () => {};
    list.addEventListener('change', callback);
    return () => list.removeEventListener('change', callback);
  }, [query]);

  const getSnapshot = useCallback(() => getQuery(query)?.matches ?? false, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
