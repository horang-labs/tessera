/**
 * Session Navigation Hook
 *
 * React hook providing session navigation: view and switch.
 */

import { useCallback, useRef, useState } from 'react';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { toast } from '@/stores/notification-store';
import { i18n } from '@/lib/i18n';
import { restoreSessionReplay } from '@/lib/chat/restore-session-replay';
import type { UnifiedSession } from '@/types/chat';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { useTaskStore } from '@/stores/task-store';

/** Number of messages loaded per API page. Used as the bloat threshold. */
export const INITIAL_PAGE_SIZE = 25;

export function useSessionNavigation() {
  const sessionStore = useSessionStore();
  const chatStore = useChatStore();
  useTaskStore((state) => state.tasksByProject);

  const [isLoading, setIsLoading] = useState(false);
  const loadingRequestCountRef = useRef(0);

  const materializeSession = useCallback(async (sessionId: string, projectViewId?: string) => (
    projectViewWorkspaceState.materializeSession(sessionId, projectViewId)
  ), []);

  /**
   * Switch to a different session (already loaded)
   */
  const switchSession = useCallback(
    (sessionId: string) => {
      sessionStore.setActiveSession(sessionId);
    },
    [sessionStore]
  );

  /**
   * View a session (read-only JSONL load).
   * If session is running and JSONL history already loaded, just activate.
   * If not running or history not loaded, fetch from API.
   *
   * Uses historyLoaded flag (not messages Map existence) to avoid race condition
   * where WebSocket streaming messages arrive before JSONL history is fetched.
   */
  const viewSession = useCallback(
    async (
      session: UnifiedSession,
      options?: { forceReload?: boolean; activate?: boolean },
    ) => {
      const shouldActivate = options?.activate !== false;
      // Navigation intent belongs to the user action that called this function.
      // Never defer it until after history I/O: a slower, older request could
      // otherwise steal focus from the session the user selected meanwhile.
      if (shouldActivate) sessionStore.setActiveSession(session.id);

      if (!options?.forceReload && chatStore.isHistoryLoaded(session.id)) {
        return;
      }

      sessionStore.setLoadingSession(session.id);
      loadingRequestCountRef.current += 1;
      if (loadingRequestCountRef.current === 1) setIsLoading(true);

      try {
        const params = new URLSearchParams({
          limit: String(INITIAL_PAGE_SIZE),
        });
        const response = await fetch(`/api/sessions/${session.id}/messages?${params}`);

        if (!response.ok) {
          if (response.status === 404) {
            if (session.isRunning) {
              restoreSessionReplay(session.id, { messages: [] });
              return;
            }
            toast.error(i18n.t('errors.sessionFileNotFound'));
            sessionStore.removeSession(session.id);
            return;
          }
          throw new Error('Failed to load session messages');
        }

        const result = await response.json();

        restoreSessionReplay(session.id, result);

        if (result.pagination) {
          chatStore.setReadOnlyPagination(session.id, {
            projectDir: session.projectDir,
            hasMore: result.pagination.hasMore,
            nextBeforeBytes: result.pagination.nextBeforeBytes,
          });
        }

      } catch (err) {
        toast.error(i18n.t('errors.sessionLoadFailed'));
        console.error('View session error:', err);
      } finally {
        loadingRequestCountRef.current = Math.max(0, loadingRequestCountRef.current - 1);
        if (loadingRequestCountRef.current === 0) setIsLoading(false);
        sessionStore.setLoadingSession(null);
      }
    },
    [sessionStore, chatStore]
  );

  return {
    viewSession,
    switchSession,
    materializeSession,

    isLoading,

    sessions: projectViewWorkspaceState.getCanonicalSessions(),
    activeSessionId: sessionStore.activeSessionId,
  };
}
