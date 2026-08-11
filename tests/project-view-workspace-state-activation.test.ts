import assert from 'node:assert/strict';
import test from 'node:test';

import { activateSessionPanel } from '@/lib/session/focus-session-panel';
import { wsClient } from '@/lib/ws/client';
import { useNotificationStore } from '@/stores/notification-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { useTabStore } from '@/stores/tab-store';
import type { UnifiedSession } from '@/types/chat';

const retainedSession: UnifiedSession = {
  id: 'retained-unread',
  title: 'Retained unread completion',
  projectDir: 'project-c',
  originProjectId: 'project-a',
  workDir: '/repo-c',
  worktreeId: 'wt-c',
  taskId: 'task-c',
  provider: 'codex',
  kind: 'chat',
  status: 'completed',
  isRunning: false,
  hasStarted: true,
  archived: false,
  unreadCount: 1,
  sortOrder: 0,
  createdAt: '2026-08-12T00:00:00.000Z',
  lastModified: '2026-08-12T01:00:00.000Z',
};

test('activating a retained Session clears canonical and notification unread with one ack', (t) => {
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [],
    retainedSessions: { [retainedSession.id]: retainedSession },
  }, true);
  useNotificationStore.setState({
    ...useNotificationStore.getInitialState(),
    notifications: [{
      id: 'notification-c',
      sessionId: retainedSession.id,
      type: 'completed',
      preview: 'Finished',
      timestamp: '2026-08-12T01:00:00.000Z',
      read: false,
      dismissed: false,
    }],
  }, true);
  useTabStore.setState({
    ...useTabStore.getInitialState(),
    tabs: [{ id: 'tab-c', projectDir: 'project-c', title: null, isPreview: false }],
    activeTabId: 'tab-c',
    lruTabIds: ['tab-c'],
    currentProjectDir: 'project-c',
  }, true);
  usePanelStore.setState({
    ...usePanelStore.getInitialState(),
    activeTabId: 'tab-c',
    tabPanels: {
      'tab-c': {
        layout: { type: 'leaf', panelId: 'panel-c' },
        panels: {
          'panel-c': { id: 'panel-c', sessionId: retainedSession.id },
        },
        activePanelId: 'panel-c',
      },
    },
  }, true);
  const taskAppearance = (projectViewId: string) => ({
    id: 'task-c',
    worktreeId: 'wt-c',
    projectId: 'project-a',
    projectViewId,
    title: 'Linked Worktree C',
    workflowStatus: 'todo' as const,
    sortOrder: 0,
    sessions: [{
      id: retainedSession.id,
      originProjectId: retainedSession.originProjectId,
      title: retainedSession.title,
      lastModified: retainedSession.lastModified,
      isRunning: false,
      unreadCount: 1,
      sortOrder: 0,
    }],
    createdAt: retainedSession.createdAt,
    updatedAt: retainedSession.lastModified,
  });
  useTaskStore.setState({
    ...useTaskStore.getInitialState(),
    tasks: [taskAppearance('project-c')],
    tasksByProject: {
      'project-a': [taskAppearance('project-a')],
      'project-c': [taskAppearance('project-c')],
    },
    currentProjectId: 'project-c',
  }, true);
  const acknowledgements: string[] = [];
  t.mock.method(wsClient, 'sendMarkAsRead', (sessionId: string) => {
    acknowledgements.push(sessionId);
  });

  assert.equal(activateSessionPanel(retainedSession.id), true);
  assert.equal(useSessionStore.getState().getSession(retainedSession.id)?.unreadCount, 0);
  assert.equal(useNotificationStore.getState().notifications[0]?.read, true);
  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject)
      .map((tasks) => tasks[0]?.sessions[0]?.unreadCount),
    [0, 0],
  );
  assert.deepEqual(acknowledgements, [retainedSession.id]);

  assert.equal(activateSessionPanel(retainedSession.id), true);
  assert.deepEqual(acknowledgements, [retainedSession.id]);
});
