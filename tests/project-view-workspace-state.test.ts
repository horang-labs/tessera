import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state';
import {
  countOriginProjectRunningSessions,
  originProjectContainsRunningSession,
} from '@/lib/projects/origin-project-representation';
import { buildProjectViewRecentWorkItems } from '@/lib/chat/recent-work';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import type { TaskEntity, TaskSession } from '@/types/task-entity';

const sessionId = 'session-c';

function session(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: sessionId,
    title: 'Canonical C Session',
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
    sortOrder: 0,
    createdAt: '2026-08-12T00:00:00.000Z',
    lastModified: '2026-08-12T01:00:00.000Z',
    ...overrides,
  };
}

function project(projectDir: string, sessions: UnifiedSession[]): ProjectGroup {
  return {
    encodedDir: projectDir,
    displayName: projectDir,
    decodedPath: projectDir === 'project-a' ? '/repo-a' : '/repo-c',
    isCurrent: projectDir === 'project-a',
    sessions,
    totalSessions: sessions.length,
    allLoaded: true,
    loadedCount: sessions.length,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function taskSession(id = sessionId): TaskSession {
  return {
    id,
    originProjectId: 'project-a',
    title: 'Task Session Summary',
    provider: 'codex',
    lastModified: '2026-08-12T00:30:00.000Z',
    isRunning: false,
    kind: 'chat',
    sortOrder: 0,
  };
}

function task(projectViewId: string, collectionId: string, child = taskSession()): TaskEntity {
  return {
    id: `task-${projectViewId}`,
    worktreeId: 'wt-c',
    projectId: 'project-a',
    projectViewId,
    title: 'Linked Worktree C',
    collectionId,
    workflowStatus: 'todo',
    workDir: '/repo-c',
    sortOrder: 0,
    sessions: [child],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:30:00.000Z',
  };
}

function collection(id: string, projectId: string): Collection {
  return { id, projectId, label: id, color: '#888888', sortOrder: 0 };
}

test('canonical resolution deduplicates direct, retained, and task-summary identities', () => {
  const direct = session({ id: 'direct', originProjectId: 'project-c' });
  const retained = session({ id: 'retained' });
  const summary = { ...taskSession('summary-only'), unreadCount: 2 };
  const workspace = createProjectViewWorkspaceState({
    getProjects: () => [project('project-c', [direct])],
    getRetainedSessions: () => ({ retained }),
    getTasksByProject: () => ({
      'project-a': [task('project-a', 'collection-a', summary)],
      'project-c': [task('project-c', 'collection-c', summary)],
    }),
    getCollectionsByProject: () => ({}),
    replaceProjects: () => {},
    replaceRetainedSessions: () => {},
    replaceTasksByProject: () => {},
    materializeSession: () => {},
    hasUnreadNotification: () => false,
    clearSessionUnread: () => {},
    clearTaskSessionUnread: () => {},
    markNotificationsRead: () => {},
    acknowledgeSessionRead: () => {},
    stopSession: () => {},
    getOpenSurfaceSessionIds: () => [],
  });

  assert.strictEqual(workspace.resolveSession('direct'), direct);
  assert.strictEqual(workspace.resolveSession('retained'), retained);
  assert.equal(workspace.resolveSession('summary-only')?.id, 'summary-only');
  assert.equal(workspace.resolveSession('summary-only')?.originProjectId, 'project-a');
  assert.equal(workspace.isSessionUnread('summary-only'), true);
  assert.deepEqual(
    workspace.getCanonicalSessions().map((item) => item.id).sort(),
    ['direct', 'retained', 'summary-only'],
  );
});

test('Project appearance lists direct, retained, and Task-only Sessions once through canonical resolution', () => {
  const direct = session({
    id: 'direct-c',
    projectDir: 'project-c',
    originProjectId: 'project-c',
  });
  const retained = session({ id: 'retained-c', projectDir: 'project-c' });
  const summary = taskSession('summary-c');
  const liveSummary = session({
    id: summary.id,
    projectDir: 'project-c',
    title: 'Live summary Session',
    isRunning: true,
    status: 'running',
  });
  const workspace = createProjectViewWorkspaceState({
    getProjects: () => [project('project-c', [direct])],
    getRetainedSessions: () => ({
      [retained.id]: retained,
      [liveSummary.id]: liveSummary,
    }),
    getTasksByProject: () => ({
      'project-c': [task('project-c', 'collection-c', summary)],
    }),
    getCollectionsByProject: () => ({
      'project-c': [collection('collection-c', 'project-c')],
    }),
    replaceProjects: () => {},
    replaceRetainedSessions: () => {},
    replaceTasksByProject: () => {},
    materializeSession: () => {},
    hasUnreadNotification: () => false,
    clearSessionUnread: () => {},
    clearTaskSessionUnread: () => {},
    markNotificationsRead: () => {},
    acknowledgeSessionRead: () => {},
    stopSession: () => {},
    getOpenSurfaceSessionIds: () => [],
  });

  assert.deepEqual(
    workspace.getProjectViewSessions('project-c').map((item) => [
      item.id,
      item.projectDir,
    ]),
    [
      ['direct-c', 'project-c'],
      ['retained-c', 'project-c'],
      ['summary-c', 'project-c'],
    ],
  );
  const representation = workspace.getProjectViewRepresentation('project-c');
  assert.equal(representation?.tasks[0]?.sessions[0]?.title, 'Live summary Session');
  assert.equal(representation?.tasks[0]?.sessions[0]?.isRunning, true);
  const recentItems = buildProjectViewRecentWorkItems(representation);
  assert.equal(recentItems.find((item) => item.id === 'task-project-c')?.session.title, 'Live summary Session');
  assert.equal(recentItems.find((item) => item.id === 'task-project-c')?.isRunning, true);
});

test('Project-scoped DnD resolution selects the visible Task appearance when origin loaded first', () => {
  const sharedChild = taskSession('shared-session');
  const taskInA = { ...task('project-a', 'collection-a', sharedChild), id: 'shared-task' };
  const taskInC = {
    ...task('project-c', 'collection-c', sharedChild),
    id: 'shared-task',
    sortOrder: 7,
  };
  const secondChild = taskSession('second-session');
  const secondInA = { ...task('project-a', 'collection-a', secondChild), id: 'second-task' };
  const secondInC = { ...task('project-c', 'collection-c', secondChild), id: 'second-task' };
  const workspace = createProjectViewWorkspaceState({
    getProjects: () => [project('project-a', []), project('project-c', [])],
    getRetainedSessions: () => ({}),
    getTasksByProject: () => ({
      'project-a': [taskInA, secondInA],
      'project-c': [taskInC, secondInC],
    }),
    getCollectionsByProject: () => ({}),
    replaceProjects: () => {},
    replaceRetainedSessions: () => {},
    replaceTasksByProject: () => {},
    hasUnreadNotification: () => false,
    clearSessionUnread: () => {},
    clearTaskSessionUnread: () => {},
    markNotificationsRead: () => {},
    acknowledgeSessionRead: () => {},
    stopSession: () => {},
    getOpenSurfaceSessionIds: () => [],
  });

  assert.strictEqual(workspace.resolveTask('shared-task', 'project-c'), taskInC);
  assert.strictEqual(
    workspace.resolveTaskBySessionId('shared-session', 'project-c'),
    taskInC,
  );
  assert.strictEqual(workspace.resolveTask('shared-task', 'project-a'), taskInA);
  assert.deepEqual(
    ['shared-session', 'second-session'].map((id) =>
      workspace.resolveTaskBySessionId(id, 'project-c')?.projectViewId
    ),
    ['project-c', 'project-c'],
  );
});

test('retained unread activation keeps Project-local placement and reads every surface once', () => {
  let retained = session({ unreadCount: 1, collectionId: 'collection-c' });
  let taskUnread = 1;
  let notificationUnread = true;
  let clearSessionUnreadCalls = 0;
  let clearTaskSessionUnreadCalls = 0;
  let markNotificationsReadCalls = 0;
  const acknowledgements: string[] = [];
  const taskInA = task('project-a', 'collection-a');
  const taskInC = task('project-c', 'collection-c');
  const workspace = createProjectViewWorkspaceState({
    getProjects: () => [project('project-a', []), project('project-c', [])],
    getRetainedSessions: () => ({ [sessionId]: retained }),
    getTasksByProject: () => ({ 'project-a': [taskInA], 'project-c': [taskInC] }),
    getCollectionsByProject: () => ({
      'project-a': [collection('collection-a', 'project-a')],
      'project-c': [collection('collection-c', 'project-c')],
      'project-d': [],
    }),
    replaceProjects: () => {},
    replaceRetainedSessions: () => {},
    replaceTasksByProject: () => {},
    materializeSession: () => {},
    hasUnreadNotification: (id) => id === sessionId && notificationUnread,
    clearSessionUnread: () => {
      clearSessionUnreadCalls += 1;
      retained = { ...retained, unreadCount: 0 };
    },
    clearTaskSessionUnread: () => {
      clearTaskSessionUnreadCalls += 1;
      taskUnread = 0;
    },
    markNotificationsRead: () => {
      markNotificationsReadCalls += 1;
      notificationUnread = false;
    },
    acknowledgeSessionRead: (id) => { acknowledgements.push(id); },
    stopSession: () => {},
    getOpenSurfaceSessionIds: () => [],
  });

  assert.equal(workspace.isSessionUnread(sessionId), true);
  assert.equal(workspace.resolveSession(sessionId, 'project-a')?.collectionId, 'collection-a');
  assert.equal(workspace.resolveSession(sessionId, 'project-c')?.collectionId, 'collection-c');
  assert.equal(workspace.resolveSession(sessionId, 'project-d')?.collectionId, undefined);

  assert.equal(workspace.markSessionRead(sessionId), true);
  assert.equal(retained.unreadCount, 0);
  assert.equal(taskUnread, 0);
  assert.equal(notificationUnread, false);
  assert.deepEqual(acknowledgements, [sessionId]);
  assert.equal(workspace.isSessionUnread(sessionId), false);

  assert.equal(workspace.markSessionRead(sessionId), false);
  assert.deepEqual(acknowledgements, [sessionId]);
  assert.equal(clearSessionUnreadCalls, 2);
  assert.equal(clearTaskSessionUnreadCalls, 2);
  assert.equal(markNotificationsReadCalls, 2);
});

test('global running actions deduplicate direct, retained, and linked Task Sessions at their origin', () => {
  const direct = session({
    id: 'direct-running',
    projectDir: 'project-a',
    originProjectId: 'project-a',
    isRunning: true,
    status: 'running',
    unreadCount: 0,
  });
  const retained = session({
    id: 'retained-running',
    projectDir: 'project-c',
    originProjectId: 'project-a',
    isRunning: true,
    status: 'running',
    unreadCount: 1,
  });
  const linked = {
    ...taskSession('linked-running'),
    isRunning: true,
    unreadCount: 1,
  };
  const directSummary = {
    ...taskSession('direct-running'),
    isRunning: true,
    unreadCount: 1,
  };
  const stopped: string[] = [];
  const clearedSessions: string[] = [];
  const clearedTaskSessions: string[] = [];
  const readNotifications: string[] = [];
  const acknowledgements: string[] = [];
  const workspace = createProjectViewWorkspaceState({
    getProjects: () => [project('project-a', [direct]), project('project-c', [])],
    getRetainedSessions: () => ({ [retained.id]: retained }),
    getTasksByProject: () => ({
      'project-a': [
        { ...task('project-a', 'collection-a', directSummary), id: 'direct-task' },
        task('project-a', 'collection-a', linked),
      ],
      'project-c': [
        { ...task('project-c', 'collection-c', directSummary), id: 'direct-task' },
        task('project-c', 'collection-c', linked),
      ],
    }),
    getCollectionsByProject: () => ({}),
    replaceProjects: () => {},
    replaceRetainedSessions: () => {},
    replaceTasksByProject: () => {},
    materializeSession: () => {},
    hasUnreadNotification: () => false,
    clearSessionUnread: (id) => { clearedSessions.push(id); },
    clearTaskSessionUnread: (id) => { clearedTaskSessions.push(id); },
    markNotificationsRead: (id) => { readNotifications.push(id); },
    acknowledgeSessionRead: (id) => { acknowledgements.push(id); },
    stopSession: (id) => { stopped.push(id); },
    getOpenSurfaceSessionIds: () => [],
  });

  assert.deepEqual(
    workspace.getCanonicalRunningSessions().map((item) => [item.id, item.projectDir]),
    [
      ['direct-running', 'project-a'],
      ['retained-running', 'project-a'],
      ['linked-running', 'project-a'],
    ],
  );
  assert.deepEqual(
    workspace.getOriginProjectRepresentation().projects.map((item) => [
      item.encodedDir,
      item.sessions.map((candidate) => candidate.id),
    ]),
    [
      ['project-a', ['direct-running', 'retained-running', 'linked-running']],
      ['project-c', []],
    ],
  );
  assert.equal(
    countOriginProjectRunningSessions(
      workspace.getOriginProjectRepresentation().projects[0],
    ),
    3,
  );

  assert.deepEqual(workspace.stopAllRunningSessions(), [
    'direct-running',
    'retained-running',
    'linked-running',
  ]);
  assert.deepEqual(stopped, [
    'direct-running',
    'retained-running',
    'linked-running',
  ]);
  assert.deepEqual(clearedSessions, stopped);
  assert.deepEqual(clearedTaskSessions, stopped);
  assert.deepEqual(readNotifications, stopped);
  assert.deepEqual(acknowledgements, stopped);
});

test('origin representation replaces stale Task runtime with canonical Session state', () => {
  const canonical = session({
    id: 'canonical-stopped',
    projectDir: 'project-a',
    originProjectId: 'project-a',
    isRunning: false,
    status: 'completed',
  });
  const staleSummary = {
    ...taskSession(canonical.id),
    isRunning: true,
  };
  const workspace = createProjectViewWorkspaceState({
    getProjects: () => [project('project-a', [canonical])],
    getRetainedSessions: () => ({}),
    getTasksByProject: () => ({
      'project-a': [{ ...task('project-a', 'collection-a', staleSummary), id: 'task-c' }],
    }),
    getCollectionsByProject: () => ({}),
    replaceProjects: () => {},
    replaceRetainedSessions: () => {},
    replaceTasksByProject: () => {},
    materializeSession: () => {},
    hasUnreadNotification: () => false,
    clearSessionUnread: () => {},
    clearTaskSessionUnread: () => {},
    markNotificationsRead: () => {},
    acknowledgeSessionRead: () => {},
    stopSession: () => {},
    getOpenSurfaceSessionIds: () => [],
  });

  const representation = workspace.getOriginProjectRepresentation();
  assert.equal(
    originProjectContainsRunningSession(
      representation.projects[0],
      representation.tasksByProject['project-a'],
    ),
    false,
  );
});

test('Task-derived mutation matrix updates A/C appearances, retained state, and Task summaries', () => {
  const taskId = 'shared-worktree';
  const directInA = session({
    projectDir: 'project-a',
    workflowStatus: 'todo',
    collectionId: 'collection-a',
  });
  const directInC = session({
    projectDir: 'project-c',
    workflowStatus: 'todo',
    collectionId: 'collection-c',
  });
  let projects = [project('project-a', [directInA]), project('project-c', [directInC])];
  let retainedSessions = {
    [sessionId]: session({
      projectDir: 'project-c',
      workflowStatus: 'todo',
      collectionId: 'collection-c',
    }),
  };
  const taskInA = { ...task('project-a', 'collection-a'), id: taskId };
  const taskInC = { ...task('project-c', 'collection-c'), id: taskId };
  let tasksByProject = { 'project-a': [taskInA], 'project-c': [taskInC] };
  const workspace = createProjectViewWorkspaceState({
    getProjects: () => projects,
    getRetainedSessions: () => retainedSessions,
    getTasksByProject: () => tasksByProject,
    getCollectionsByProject: () => ({
      'project-a': [collection('collection-a', 'project-a')],
      'project-c': [collection('collection-c', 'project-c')],
    }),
    replaceProjects: (next) => { projects = next; },
    replaceRetainedSessions: (next) => { retainedSessions = next; },
    replaceTasksByProject: (next) => { tasksByProject = next; },
    materializeSession: () => {},
    hasUnreadNotification: () => false,
    clearSessionUnread: () => {},
    clearTaskSessionUnread: () => {},
    markNotificationsRead: () => {},
    acknowledgeSessionRead: () => {},
    stopSession: () => {},
    getOpenSurfaceSessionIds: () => [],
  });

  const workflowRollback = workspace.applyTaskMutation({
    taskId,
    workflowStatus: 'in_review',
  });
  assert.ok(workflowRollback);
  assert.deepEqual(
    Object.values(tasksByProject).map(([appearance]) => appearance.workflowStatus),
    ['in_review', 'in_review'],
  );
  assert.deepEqual(
    projects.map(({ sessions }) => sessions[0]?.workflowStatus),
    ['in_review', 'in_review'],
  );
  assert.equal(retainedSessions[sessionId]?.workflowStatus, 'in_review');
  workflowRollback();

  workspace.promoteTodoTasks([taskId]);
  assert.deepEqual(
    Object.values(tasksByProject).map(([appearance]) => appearance.workflowStatus),
    ['in_progress', 'in_progress'],
  );
  assert.deepEqual(
    projects.map(({ sessions }) => sessions[0]?.workflowStatus),
    ['in_progress', 'in_progress'],
  );
  assert.equal(retainedSessions[sessionId]?.workflowStatus, 'in_progress');

  const collectionRollback = workspace.applyTaskMutation({
    taskId,
    projectViewId: 'project-c',
    collectionId: null,
  });
  assert.ok(collectionRollback);
  assert.equal(tasksByProject['project-a'][0]?.collectionId, undefined);
  assert.equal(tasksByProject['project-c'][0]?.collectionId, undefined);
  assert.equal(projects[0]?.sessions[0]?.collectionId, undefined);
  assert.equal(projects[1]?.sessions[0]?.collectionId, undefined);
  assert.equal(retainedSessions[sessionId]?.collectionId, undefined);
  collectionRollback();
  assert.equal(tasksByProject['project-c'][0]?.collectionId, 'collection-c');

  const archiveRollback = workspace.applyTaskMutation({ taskId, archived: true });
  assert.ok(archiveRollback);
  assert.deepEqual(tasksByProject, { 'project-a': [], 'project-c': [] });
  for (const appearance of projects.flatMap(({ sessions }) => sessions)) {
    assert.equal(appearance.archived, true);
    assert.equal(appearance.isReadOnly, true);
  }
  assert.equal(retainedSessions[sessionId]?.archived, true);
  assert.equal(retainedSessions[sessionId]?.isReadOnly, true);
  archiveRollback();
  assert.equal(tasksByProject['project-a'][0]?.id, taskId);
  assert.equal(retainedSessions[sessionId]?.archived, false);
  assert.equal(retainedSessions[sessionId]?.isReadOnly, undefined);
});

test('navigation materializes a summary-only linked Session with its owning Worktree', async () => {
  const materialized: UnifiedSession[] = [];
  const summaryOnlyTask = task('project-a', 'collection-a');
  const workspace = createProjectViewWorkspaceState({
    getProjects: () => [project('project-a', [])],
    getRetainedSessions: () => ({}),
    getTasksByProject: () => ({ 'project-a': [summaryOnlyTask] }),
    getCollectionsByProject: () => ({
      'project-a': [collection('collection-a', 'project-a')],
    }),
    replaceProjects: () => {},
    replaceRetainedSessions: () => {},
    replaceTasksByProject: () => {},
    materializeSession: (value) => { materialized.push(value); },
    hasUnreadNotification: () => false,
    clearSessionUnread: () => {},
    clearTaskSessionUnread: () => {},
    markNotificationsRead: () => {},
    acknowledgeSessionRead: () => {},
    stopSession: () => {},
    getOpenSurfaceSessionIds: () => [],
  });

  const fromProjectView = await workspace.materializeSession(sessionId, 'project-a');
  const fromGlobalNavigation = await workspace.materializeSession(sessionId);

  assert.deepEqual(
    fromProjectView && {
      id: fromProjectView.id,
      projectDir: fromProjectView.projectDir,
      originProjectId: fromProjectView.originProjectId,
      worktreeId: fromProjectView.worktreeId,
      workDir: fromProjectView.workDir,
      collectionId: fromProjectView.collectionId,
    },
    {
      id: sessionId,
      projectDir: 'project-a',
      originProjectId: 'project-a',
      worktreeId: 'wt-c',
      workDir: '/repo-c',
      collectionId: 'collection-a',
    },
  );
  assert.equal(fromGlobalNavigation?.id, fromProjectView?.id);
  assert.deepEqual(materialized, [fromProjectView, fromGlobalNavigation]);
});

test('navigation loads and retains canonical details when no client snapshot exists', async () => {
  let retained: Record<string, UnifiedSession> = {};
  const loaded = session({
    id: 'notification-only',
    worktreeId: 'wt-notification',
    workDir: '/repo/notification',
  });
  const loads: string[] = [];
  const workspace = createProjectViewWorkspaceState({
    getProjects: () => [],
    getRetainedSessions: () => retained,
    getTasksByProject: () => ({}),
    getCollectionsByProject: () => ({}),
    replaceProjects: () => {},
    replaceRetainedSessions: () => {},
    replaceTasksByProject: () => {},
    loadSession: async (id) => {
      loads.push(id);
      return id === loaded.id ? loaded : undefined;
    },
    materializeSession: (value) => { retained = { ...retained, [value.id]: value }; },
    hasUnreadNotification: () => false,
    clearSessionUnread: () => {},
    clearTaskSessionUnread: () => {},
    markNotificationsRead: () => {},
    acknowledgeSessionRead: () => {},
    stopSession: () => {},
    getOpenSurfaceSessionIds: () => [],
  });

  const materialized = await workspace.materializeSession(loaded.id);

  assert.deepEqual(loads, [loaded.id]);
  assert.equal(materialized?.worktreeId, 'wt-notification');
  assert.strictEqual(retained[loaded.id], materialized);
});
