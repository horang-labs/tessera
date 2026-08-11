import { createProjectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state';
import { wsClient } from '@/lib/ws/client';
import { useCollectionStore } from '@/stores/collection-store';
import { useNotificationStore } from '@/stores/notification-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';

/** Live adapter that keeps the workspace-state contract beside the existing stores. */
export const projectViewWorkspaceState = createProjectViewWorkspaceState({
  getProjects: () => useSessionStore.getState().projects,
  getRetainedSessions: () => useSessionStore.getState().retainedSessions,
  getTasksByProject: () => useTaskStore.getState().tasksByProject,
  getCollectionsByProject: () => useCollectionStore.getState().collectionsByProject,
  loadSession: async (sessionId) => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        cache: 'no-store',
      });
      if (!response.ok) return undefined;
      const result = await response.json() as { session?: import('@/types/chat').UnifiedSession };
      return result.session;
    } catch {
      return undefined;
    }
  },
  materializeSession: (session) => useSessionStore.getState().retainSession(session),
  hasUnreadNotification: (sessionId) => useNotificationStore.getState().notifications.some(
    (notification) => notification.sessionId === sessionId && !notification.read,
  ),
  clearSessionUnread: (sessionId) => useSessionStore.getState().clearUnreadCount(sessionId),
  clearTaskSessionUnread: (sessionId) => {
    useTaskStore.getState().setLinkedSessionUnreadCount(sessionId, 0);
  },
  markNotificationsRead: (sessionId) => {
    useNotificationStore.getState().markSessionAsRead(sessionId);
  },
  acknowledgeSessionRead: (sessionId) => wsClient.sendMarkAsRead(sessionId),
});
