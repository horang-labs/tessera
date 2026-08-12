'use client';

import { useCallback } from 'react';
import { useNotificationStore } from '@/stores/notification-store';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { useProjectViewSessions } from './use-project-view-workspace-state';

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

  useProjectViewSessions(splitSessionIds(sessionIdsKey));
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

  const hasCanonicalUnread = splitSessionIds(sessionIdsKey).some((sessionId) => (
    sessionId !== excludeSessionId
    && projectViewWorkspaceState.isSessionUnread(sessionId)
  ));
  return selectProjectViewSessionUnreadState({
    canonicalUnread: hasCanonicalUnread,
    taskSummaryUnread: false,
    notificationUnread: hasUnreadNotification,
  });
}

export function useProjectViewSessionUnread(sessionId: string | null): boolean {
  return useAnyProjectViewSessionUnread(sessionId ? [sessionId] : []);
}
