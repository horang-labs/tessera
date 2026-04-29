/**
 * Session Navigation Hook
 *
 * React hook providing session navigation: view and switch.
 */

import { useCallback, useState } from 'react';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { toast } from '@/stores/notification-store';
import { i18n } from '@/lib/i18n';
import { restoreSessionReplay } from '@/lib/chat/restore-session-replay';
import type { UnifiedSession } from '@/types/chat';

/** Number of messages loaded per API page. Used as the bloat threshold. */
export const INITIAL_PAGE_SIZE = 25;

export function useSessionNavigation() {
  const sessionStore = useSessionStore();
  const chatStore = useChatStore();

  const [isLoading, setIsLoading] = useState(false);

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
    async (session: UnifiedSession, options?: { forceReload?: boolean }) => {
      if (!options?.forceReload && chatStore.isHistoryLoaded(session.id)) {
        sessionStore.setActiveSession(session.id);
        return;
      }

      sessionStore.setLoadingSession(session.id);
      setIsLoading(true);

      try {
        const params = new URLSearchParams({
          limit: String(INITIAL_PAGE_SIZE),
        });
        const response = await fetch(`/api/sessions/${session.id}/messages?${params}`);

        if (!response.ok) {
          if (response.status === 404) {
            if (session.isRunning) {
              restoreSessionReplay(session.id, { messages: [] });
              sessionStore.setActiveSession(session.id);
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

        sessionStore.setActiveSession(session.id);
      } catch (err) {
        toast.error(i18n.t('errors.sessionLoadFailed'));
        console.error('View session error:', err);
      } finally {
        setIsLoading(false);
        sessionStore.setLoadingSession(null);
      }
    },
    [sessionStore, chatStore]
  );

  return {
    viewSession,
    switchSession,

    isLoading,

    sessions: sessionStore.projects.flatMap((p) => p.sessions),
    activeSessionId: sessionStore.activeSessionId,
  };
}
