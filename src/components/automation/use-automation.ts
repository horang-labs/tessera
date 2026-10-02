'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { getSessionInputOwnership, subscribeSessionInputOwnership } from '@/lib/automation/client-state';
import { createAutomationStore, type AutomationScope } from '@/stores/automation-store';

export function useAutomationStore(scope: AutomationScope) {
  const sessionId = 'sessionId' in scope ? scope.sessionId : null;
  const worktreeId = 'worktreeId' in scope ? scope.worktreeId : null;
  const store = useMemo(() => createAutomationStore(sessionId ? { sessionId } : { worktreeId: worktreeId! }), [sessionId, worktreeId]);
  useEffect(() => {
    void store.getState().refresh();
    const timer = setInterval(() => void store.getState().refresh(), 5000);
    const onFocus = () => void store.getState().refresh();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [store]);
  return store;
}

/** Read the frozen projection. HTTP pause success is deliberately not an ownership update. */
export function useAutomationOwnership(sessionId: string) {
  const subscribe = useCallback((listener: () => void) => subscribeSessionInputOwnership(sessionId, listener), [sessionId]);
  const snapshot = useCallback(() => getSessionInputOwnership(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
