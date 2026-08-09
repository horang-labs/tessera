import { getRenderedViewMode } from '@/lib/viewport/rendered-view-mode';
import { resolveVisibleWorkspaceSessionId } from '@/lib/session/active-workspace-session';
import { useBoardStore } from '@/stores/board-store';
import { useNotificationStore } from '@/stores/notification-store';
import { useSessionStore } from '@/stores/session-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { NotificationAction } from '@/types/notification';
import type { SessionNotificationPayload } from './session-notification';

const MAX_RECENT_SESSION_NOTIFICATION_EVENTS = 100;

export interface PageSessionNotification extends SessionNotificationPayload {
  source: 'websocket' | 'service-worker';
  actions?: NotificationAction[];
}

interface SessionNotificationPresenterOptions {
  maxRecentEvents?: number;
  present: (notification: PageSessionNotification) => void;
}

export function createSessionNotificationPresenter({
  maxRecentEvents = MAX_RECENT_SESSION_NOTIFICATION_EVENTS,
  present,
}: SessionNotificationPresenterOptions): (notification: PageSessionNotification) => boolean {
  if (!Number.isInteger(maxRecentEvents) || maxRecentEvents < 1) {
    throw new RangeError('maxRecentEvents must be a positive integer');
  }
  const recentEventIds = new Set<string>();

  return function presentOnce(notification) {
    if (recentEventIds.has(notification.eventId)) return false;
    recentEventIds.add(notification.eventId);
    if (recentEventIds.size > maxRecentEvents) {
      const oldest = recentEventIds.values().next().value;
      if (oldest !== undefined) recentEventIds.delete(oldest);
    }
    present(notification);
    return true;
  };
}

function visibleSessionId(): string | null {
  const sessionState = useSessionStore.getState();
  const boardState = useBoardStore.getState();
  const settingsState = useSettingsStore.getState();
  return resolveVisibleWorkspaceSessionId({
    activeSessionId: sessionState.activeSessionId,
    peekSessionId: boardState.peekSessionId,
    isKanbanPeekLayout:
      getRenderedViewMode() === 'board'
      && settingsState.settings.kanbanSessionOpenMode === 'peek'
      && !settingsState.sidebarCollapsed,
  });
}

export const presentSessionNotificationOnPage = createSessionNotificationPresenter({
  present(notification) {
    const notificationStore = useNotificationStore.getState();
    if (notification.sessionId === visibleSessionId()) {
      if (notification.kind === 'completed' || notification.kind === 'input_required') {
        notificationStore.playSound();
      }
      return;
    }

    const added = notificationStore.addNotification({
      sessionId: notification.sessionId,
      type: notification.kind,
      preview: notification.preview,
      actions: notification.actions,
      dedupKey: notification.eventId,
    });
    if (added) useSessionStore.getState().incrementUnreadCount(notification.sessionId);
  },
});
