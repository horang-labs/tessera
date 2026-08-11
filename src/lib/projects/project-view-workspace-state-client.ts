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
  stopSession: (sessionId) => wsClient.stopSession(sessionId),
});
