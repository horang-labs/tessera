'use client';

import { useSyncExternalStore } from 'react';
import { useAuthStore } from '@/stores/auth-store';

import type { ArchiveRetentionProgress } from '@/lib/archive/retention-progress';

export function isArchiveRetentionActive(progress: ArchiveRetentionProgress | null): boolean {
  return progress !== null && ['scanning', 'running', 'waiting'].includes(progress.phase);
}

let snapshot: ArchiveRetentionProgress | null = null;
const listeners = new Set<() => void>();
let stopPolling: (() => void) | null = null;
let unsubscribeAuth: (() => void) | null = null;

function publish(progress: ArchiveRetentionProgress | null) {
  if (JSON.stringify(snapshot) === JSON.stringify(progress)) return;
  snapshot = progress;
  listeners.forEach((listener) => listener());
}

function startPolling(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;
  async function poll() {
    request = new AbortController();
    try {
      const response = await fetch('/api/archive/retention', {
        cache: 'no-store',
        signal: request.signal,
      });
      if (!response.ok) throw new Error('Retention progress unavailable');
      const data = await response.json() as { progress: ArchiveRetentionProgress };
      if (!stopped) publish(data.progress ?? null);
    } catch {
      // Do not leave an old "running" indicator spinning after losing contact.
      if (!stopped) publish(null);
    } finally {
      if (!stopped) {
        timer = setTimeout(poll, isArchiveRetentionActive(snapshot) ? 2_000 : 15_000);
      }
    }
  }
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    request?.abort();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const restart = () => {
      stopPolling?.();
      stopPolling = null;
      publish(null);
      if (useAuthStore.getState().user) stopPolling = startPolling();
    };
    unsubscribeAuth = useAuthStore.subscribe((state, previous) => {
      if (state.user?.id !== previous.user?.id) restart();
    });
    restart();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPolling?.();
      stopPolling = null;
      unsubscribeAuth?.();
      unsubscribeAuth = null;
      snapshot = null;
    }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => null;

/** One polling loop per browser window, shared by the navigation and dashboard. */
export function useArchiveRetentionProgress() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
