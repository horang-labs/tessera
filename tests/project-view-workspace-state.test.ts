import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state';
import { originProjectContainsRunningSession } from '@/lib/projects/origin-project-representation';
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

test('retained unread activation keeps Project-local placement and reads every surface once', () => {
  let retained = session({ unreadCount: 1, collectionId: 'collection-c' });
  let taskUnread = 1;
  let notificationUnread = true;
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
    hasUnreadNotification: (id) => id === sessionId && notificationUnread,
    clearSessionUnread: () => { retained = { ...retained, unreadCount: 0 }; },
    clearTaskSessionUnread: () => { taskUnread = 0; },
    markNotificationsRead: () => { notificationUnread = false; },
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
    hasUnreadNotification: () => false,
    clearSessionUnread: (id) => { clearedSessions.push(id); },
    clearTaskSessionUnread: (id) => { clearedTaskSessions.push(id); },
    markNotificationsRead: (id) => { readNotifications.push(id); },
    acknowledgeSessionRead: (id) => { acknowledgements.push(id); },
    stopSession: (id) => { stopped.push(id); },
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
    hasUnreadNotification: () => false,
    clearSessionUnread: () => {},
    clearTaskSessionUnread: () => {},
    markNotificationsRead: () => {},
    acknowledgeSessionRead: () => {},
    stopSession: () => {},
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
