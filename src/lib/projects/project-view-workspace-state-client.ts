import { createProjectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state';
import { getProjectViewOpenSessionIds } from '@/lib/projects/project-view-open-surfaces';
import { wsClient } from '@/lib/ws/client';
import { useCollectionStore } from '@/stores/collection-store';
import { useNotificationStore } from '@/stores/notification-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import type { WorkspaceMutationIdentity } from './project-view-workspace-state';

/** Live adapter that keeps the workspace-state contract beside the existing stores. */
export const projectViewWorkspaceState = createProjectViewWorkspaceState({
  getProjects: () => useSessionStore.getState().projects,
  getRetainedSessions: () => useSessionStore.getState().retainedSessions,
  getTasksByProject: () => {
    const state = useTaskStore.getState();
    if (!state.currentProjectId || state.tasksByProject[state.currentProjectId]) {
      return state.tasksByProject;
    }
    return { ...state.tasksByProject, [state.currentProjectId]: state.tasks };
  },
  getCollectionsByProject: () => useCollectionStore.getState().collectionsByProject,
  replaceProjects: (projects) => useSessionStore.setState({ projects }),
  replaceRetainedSessions: (retainedSessions) => useSessionStore.setState({ retainedSessions }),
  replaceTasksByProject: (tasksByProject) => useTaskStore.setState((state) => ({
    tasksByProject,
    ...(state.currentProjectId
      ? { tasks: tasksByProject[state.currentProjectId] ?? [] }
      : {}),
  })),
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
  stopSession: (sessionId) => wsClient.stopSession(sessionId),
  getOpenSurfaceSessionIds: getProjectViewOpenSessionIds,
});

/** Refresh every loaded Project appearance after a canonical cross-window mutation. */
export async function refreshProjectViewWorkspaceMutation(
  identity: WorkspaceMutationIdentity,
): Promise<void> {
  const projectViewIds = projectViewWorkspaceState.getAffectedProjectViewIds(identity);
  await Promise.all([
    useSessionStore.getState().loadProjects(),
    ...projectViewIds.map((projectId) => useTaskStore.getState().loadTasks(projectId, {
      setCurrent: false,
    })),
  ]);
}
