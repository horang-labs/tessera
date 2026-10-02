'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getSessionInputOwnership, subscribeSessionInputOwnership } from '@/lib/automation/client-state';
import { useAuthStore } from '@/stores/auth-store';
import { getAutomationStore, subscribeAutomationScope, type AutomationScope } from '@/stores/automation-store';

export function useAutomationStore(scope: AutomationScope) {
  const sessionId = 'sessionId' in scope ? scope.sessionId : null;
  const worktreeId = 'worktreeId' in scope ? scope.worktreeId : null;
  const ownerId = useAuthStore(state => state.user?.id ?? 'signed-out');
  const scoped = sessionId ? { sessionId } : { worktreeId: worktreeId! };
  const store = getAutomationStore(ownerId, scoped).store;
  useEffect(() => subscribeAutomationScope(ownerId, sessionId ? { sessionId } : { worktreeId: worktreeId! }), [ownerId, sessionId, worktreeId]);
  return store;
}

/** Read the frozen projection. HTTP pause success is deliberately not an ownership update. */
export function useAutomationOwnership(sessionId: string) {
  const subscribe = useCallback((listener: () => void) => subscribeSessionInputOwnership(sessionId, listener), [sessionId]);
  const snapshot = useCallback(() => getSessionInputOwnership(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
