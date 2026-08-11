'use client';

import { useCallback } from 'react';
import { useNotificationStore } from '@/stores/notification-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';

function splitSessionIds(sessionIdsKey: string): string[] {
  return sessionIdsKey ? sessionIdsKey.split('\0') : [];
}

export function selectProjectViewSessionUnreadState(state: {
  canonicalUnread: boolean;
  taskSummaryUnread: boolean;
  notificationUnread: boolean;
}): boolean {
  return state.canonicalUnread || state.taskSummaryUnread || state.notificationUnread;
}

/** React subscription for the canonical unread rule exposed by workspace state. */
export function useAnyProjectViewSessionUnread(
  sessionIds: readonly string[],
  excludeSessionId?: string | null,
): boolean {
  const sessionIdsKey = Array.from(new Set(sessionIds)).sort().join('\0');

  const hasCanonicalUnread = useSessionStore(
    useCallback(
      (state) => splitSessionIds(sessionIdsKey).some((sessionId) => (
        sessionId !== excludeSessionId
        && (state.getSession(sessionId)?.unreadCount ?? 0) > 0
      )),
      [excludeSessionId, sessionIdsKey],
    ),
  );
  const hasTaskSummaryUnread = useTaskStore(
    useCallback(
      (state) => splitSessionIds(sessionIdsKey).some((sessionId) => (
        sessionId !== excludeSessionId
        && [state.tasks, ...Object.values(state.tasksByProject)].some((tasks) =>
          tasks.some((task) => task.sessions.some(
            (session) => session.id === sessionId && (session.unreadCount ?? 0) > 0,
          )),
        )
      )),
      [excludeSessionId, sessionIdsKey],
    ),
  );
  const hasUnreadNotification = useNotificationStore(
    useCallback(
      (state) => splitSessionIds(sessionIdsKey).some((sessionId) => (
        sessionId !== excludeSessionId
        && state.notifications.some(
          (notification) => notification.sessionId === sessionId && !notification.read,
        )
      )),
      [excludeSessionId, sessionIdsKey],
    ),
  );

  return selectProjectViewSessionUnreadState({
    canonicalUnread: hasCanonicalUnread,
    taskSummaryUnread: hasTaskSummaryUnread,
    notificationUnread: hasUnreadNotification,
  });
}

export function useProjectViewSessionUnread(sessionId: string | null): boolean {
  return useAnyProjectViewSessionUnread(sessionId ? [sessionId] : []);
}
