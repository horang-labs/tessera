import assert from 'node:assert/strict';
import test from 'node:test';

import { activateSessionPanel } from '@/lib/session/focus-session-panel';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { wsClient } from '@/lib/ws/client';
import { useBoardStore } from '@/stores/board-store';
import { useCollectionStore } from '@/stores/collection-store';
import { useNotificationStore } from '@/stores/notification-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { useTabStore } from '@/stores/tab-store';
import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';

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
  assert.equal(projectViewWorkspaceState.resolveSession(retainedSession.id)?.unreadCount, 0);
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

test('a linked Task Session with a direct origin stays resolvable and targets its Worktree', async () => {
  const directSession: UnifiedSession = {
    id: 'session-linked',
    title: 'Linked Session',
    projectDir: 'project-a',
    originProjectId: 'project-a',
    workDir: '/repo/a',
    provider: 'codex',
    kind: 'chat',
    status: 'completed',
    isRunning: false,
    hasStarted: true,
    archived: false,
    unreadCount: 0,
    sortOrder: 0,
    createdAt: '2026-08-12T00:00:00.000Z',
    lastModified: '2026-08-12T01:00:00.000Z',
  };
  const task: TaskEntity = {
    id: 'task-linked',
    worktreeId: 'wt-linked',
    projectId: 'project-a',
    projectViewId: 'project-c',
    title: 'Linked Worktree',
    collectionId: 'collection-a',
    workflowStatus: 'in_progress',
    workDir: '/repo/linked',
    sortOrder: 0,
    sessions: [{
      id: 'session-linked',
      originProjectId: 'project-a',
      title: 'Linked Session',
      provider: 'codex',
      kind: 'chat',
      lastModified: '2026-08-12T01:00:00.000Z',
      isRunning: false,
      sortOrder: 0,
    }],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T01:00:00.000Z',
  };
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [{
      encodedDir: 'project-a',
      displayName: 'Project A',
      decodedPath: '/repo/a',
      isCurrent: false,
      sessions: [directSession],
      totalSessions: 1,
      allLoaded: true,
      loadedCount: 1,
      nextCursor: null,
      loadBatchIndex: 0,
    }, {
      encodedDir: 'project-c',
      displayName: 'Project C',
      decodedPath: '/repo/c',
      isCurrent: true,
      sessions: [],
      totalSessions: 0,
      allLoaded: true,
      loadedCount: 0,
      nextCursor: null,
      loadBatchIndex: 0,
    }],
  }, true);
  useTaskStore.setState({
    ...useTaskStore.getInitialState(),
    tasks: [task],
    tasksByProject: { 'project-c': [task] },
    currentProjectId: 'project-c',
  }, true);
  useCollectionStore.setState({
    ...useCollectionStore.getInitialState(),
    collectionsByProject: {
      'project-c': [{
        id: 'collection-a',
        projectId: 'project-c',
        label: 'Doing',
        color: '#888888',
        sortOrder: 0,
      }],
    },
  }, true);
  useBoardStore.setState({
    ...useBoardStore.getInitialState(),
    selectedProjectDir: 'project-c',
  }, true);
  useTabStore.setState({
    ...useTabStore.getInitialState(),
    tabs: [{ id: 'tab-linked', projectDir: 'project-c', title: null, isPreview: false }],
    activeTabId: 'tab-linked',
    lruTabIds: ['tab-linked'],
    currentProjectDir: 'project-c',
  }, true);
  usePanelStore.setState({
    ...usePanelStore.getInitialState(),
    activeTabId: 'tab-linked',
    tabPanels: {
      'tab-linked': {
        layout: { type: 'leaf', panelId: 'panel-linked' },
        panels: { 'panel-linked': { id: 'panel-linked', sessionId: null } },
        activePanelId: 'panel-linked',
      },
    },
  }, true);

  const session = await projectViewWorkspaceState.materializeSession('session-linked', 'project-c');
  assert.equal(session?.worktreeId, 'wt-linked');
  assert.equal(useSessionStore.getState().projects[0]?.sessions.length, 1);
  assert.equal(useSessionStore.getState().projects[1]?.sessions.length, 0);
  assert.equal(
    useSessionStore.getState().retainedSessions['session-linked']?.worktreeId,
    'wt-linked',
  );
  assert.equal(
    useSessionStore.getState().getMaterializedSession('session-linked')?.worktreeId,
    'wt-linked',
  );
  useBoardStore.getState().openSessionPeek('session-linked');
  assert.equal(
    projectViewWorkspaceState.resolveSession('session-linked', 'project-c')?.workDir,
    '/repo/linked',
  );

  useTabStore.getState().openPreview('session-linked');
  const panel = usePanelStore.getState().tabPanels['tab-linked']?.panels['panel-linked'];
  assert.equal(panel?.sessionId, 'session-linked');
  assert.equal(panel?.worktreeId, 'wt-linked');
});
