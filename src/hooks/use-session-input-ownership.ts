'use client';
import { useCallback, useSyncExternalStore } from 'react';
import { getSessionInputOwnership, subscribeSessionInputOwnership } from '@/lib/automation/client-state';

/** Shared by normal panels and Session Peek; missing/disconnected authority remains read-only. */
export function useSessionInputOwnership(sessionId: string) {
  const subscribe = useCallback((listener: () => void) => subscribeSessionInputOwnership(sessionId, listener), [sessionId]);
  const snapshot = useCallback(() => getSessionInputOwnership(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
