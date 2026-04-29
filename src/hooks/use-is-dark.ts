'use client';

import { useState, useEffect, useSyncExternalStore } from 'react';

// Shared subscription for dark mode detection via MutationObserver
// Avoids creating one observer per component instance
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function getIsDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  if (!observer && typeof document !== 'undefined') {
    observer = new MutationObserver(() => {
      listeners.forEach((cb) => cb());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

function getSnapshot() {
  return getIsDark();
}

function getServerSnapshot() {
  return false;
}

/**
 * Reactively tracks whether the app is in dark mode.
 * Uses a shared MutationObserver on <html> class changes.
 */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
