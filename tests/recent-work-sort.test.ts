import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecentWorkItems } from '../src/lib/chat/recent-work';
import type { ProjectGroup, UnifiedSession } from '../src/types/chat';
import type { TaskEntity } from '../src/types/task-entity';

function makeSession(overrides: Partial<UnifiedSession> & Pick<UnifiedSession, 'id'>): UnifiedSession {
  return {
    title: `session ${overrides.id}`,
    projectDir: 'proj',
    isRunning: false,
    status: 'completed',
    lastModified: '2026-06-13T10:00:00.000Z',
    createdAt: '2026-06-13T09:00:00.000Z',
    archived: false,
    sortOrder: 0,
    ...overrides,
  };
}

function makeProject(sessions: UnifiedSession[]): ProjectGroup {
  return {
    encodedDir: 'proj',
    displayName: 'proj',
    decodedPath: '/proj',
    isCurrent: true,
    sessions,
    totalSessions: sessions.length,
    allLoaded: true,
    loadedCount: sessions.length,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function build(sessions: UnifiedSession[]) {
  return buildRecentWorkItems({
    projects: [makeProject(sessions)],
    tasksByProject: {},
    limit: 8,
  });
}

function idsOf(sessions: UnifiedSession[]): string[] {
  return build(sessions).map((item) => item.id);
}

test('two running sessions keep a stable order while their lastModified keeps advancing', () => {
  // A was created before B. Both are streaming, so their lastModified bumps on every chunk.
  const a = makeSession({
    id: 'a',
    isRunning: true,
    status: 'running',
    createdAt: '2026-06-13T09:00:00.000Z',
    lastModified: '2026-06-13T10:00:00.001Z',
  });
  const b = makeSession({
    id: 'b',
    isRunning: true,
    status: 'running',
    createdAt: '2026-06-13T09:00:05.000Z',
    lastModified: '2026-06-13T10:00:00.002Z',
  });

  // createdAt desc => newer-created B first, then A.
  const initial = idsOf([a, b]);
  assert.deepEqual(initial, ['b', 'a']);

  // Simulate several streaming ticks where A and B alternately become "most recent".
  const ticks: UnifiedSession[][] = [
    [{ ...a, lastModified: '2026-06-13T10:00:00.050Z' }, b],
    [a, { ...b, lastModified: '2026-06-13T10:00:00.099Z' }],
    [{ ...a, lastModified: '2026-06-13T10:00:01.500Z' }, b],
    [a, { ...b, lastModified: '2026-06-13T10:00:02.700Z' }],
  ];

  for (const tick of ticks) {
    assert.deepEqual(idsOf(tick), initial, 'running order must not change as lastModified advances');
  }
});

test('completed sessions still sort by most recent activity (lastActivityAt desc)', () => {
  const older = makeSession({ id: 'old', lastModified: '2026-06-13T08:00:00.000Z' });
  const newer = makeSession({ id: 'new', lastModified: '2026-06-13T11:00:00.000Z' });
  const mid = makeSession({ id: 'mid', lastModified: '2026-06-13T09:30:00.000Z' });

  assert.deepEqual(idsOf([older, newer, mid]), ['new', 'mid', 'old']);
});

test('a running session ranks above a more-recently-active completed session', () => {
  const running = makeSession({
    id: 'run',
    isRunning: true,
    status: 'running',
    createdAt: '2026-06-13T07:00:00.000Z',
    // Note: its activity is OLDER than the completed one, yet it must still win.
    lastModified: '2026-06-13T09:00:00.000Z',
  });
  const completed = makeSession({
    id: 'done',
    isRunning: false,
    lastModified: '2026-06-13T12:00:00.000Z',
  });

  assert.deepEqual(idsOf([completed, running]), ['run', 'done']);
});

test('items with identical keys fall back to id and never reshuffle', () => {
  const shared = {
    isRunning: false as const,
    createdAt: '2026-06-13T09:00:00.000Z',
    lastModified: '2026-06-13T10:00:00.000Z',
  };
  const x = makeSession({ id: 'x', ...shared });
  const y = makeSession({ id: 'y', ...shared });
  const z = makeSession({ id: 'z', ...shared });

  const expected = ['x', 'y', 'z']; // id ascending tie-break
  assert.deepEqual(idsOf([x, y, z]), expected);
  // Input order must not matter once all sort keys are equal.
  assert.deepEqual(idsOf([z, y, x]), expected);
  assert.deepEqual(idsOf([y, z, x]), expected);
});

test('fallback task groups (orphaned task sessions) keep stable order while running', () => {
  // taskId가 있지만 tasksByProject에 없는 세션들은 fallbackTaskItemsFromSessions 경로를 탄다.
  // 같은 그룹 안에서 두 세션이 동시에 스트리밍하며 lastModified가 번갈아 최신이 되어도,
  // 그룹(task 항목)의 정렬 anchor는 그룹의 가장 이른 createdAt으로 고정되어야 한다.
  const t1s1 = makeSession({
    id: 't1s1', taskId: 'T1', isRunning: true, status: 'running',
    createdAt: '2026-06-13T09:00:00.000Z', lastModified: '2026-06-13T10:00:00.010Z',
  });
  const t1s2 = makeSession({
    id: 't1s2', taskId: 'T1', isRunning: true, status: 'running',
    createdAt: '2026-06-13T09:00:01.000Z', lastModified: '2026-06-13T10:00:00.020Z',
  });
  const t2s1 = makeSession({
    id: 't2s1', taskId: 'T2', isRunning: true, status: 'running',
    createdAt: '2026-06-13T09:00:05.000Z', lastModified: '2026-06-13T10:00:00.030Z',
  });

  // anchor: T1 earliest=09:00:00, T2 earliest=09:00:05 => createdAt desc로 T2가 먼저.
  // (fallback 항목의 RecentWorkItem.id는 taskId 이다.)
  const initial = idsOf([t1s1, t1s2, t2s1]);
  assert.deepEqual(initial, ['T2', 'T1']);

  // 어느 세션이 "가장 최근"이 되든(= recentSession이 flip 되든) 그룹 순서는 그대로여야 한다.
  const ticks: UnifiedSession[][] = [
    [{ ...t1s1, lastModified: '2026-06-13T10:00:05.000Z' }, t1s2, t2s1],
    [t1s1, { ...t1s2, lastModified: '2026-06-13T10:00:09.000Z' }, t2s1],
    [t1s1, t1s2, { ...t2s1, lastModified: '2026-06-13T10:00:01.000Z' }],
  ];
  for (const tick of ticks) {
    assert.deepEqual(idsOf(tick), initial, 'fallback task group order must stay stable');
  }
});

test('mixed running + completed: running tier (createdAt desc) above completed tier (activity desc)', () => {
  const runA = makeSession({
    id: 'runA',
    isRunning: true,
    status: 'running',
    createdAt: '2026-06-13T08:00:00.000Z',
    lastModified: '2026-06-13T10:00:01.000Z',
  });
  const runB = makeSession({
    id: 'runB',
    isRunning: true,
    status: 'running',
    createdAt: '2026-06-13T08:00:10.000Z',
    lastModified: '2026-06-13T10:00:00.500Z',
  });
  const doneOld = makeSession({ id: 'doneOld', lastModified: '2026-06-13T09:50:00.000Z' });
  const doneNew = makeSession({ id: 'doneNew', lastModified: '2026-06-13T09:59:00.000Z' });

  // running tier first (runB created later => first), then completed tier by activity desc.
  assert.deepEqual(idsOf([doneOld, runA, doneNew, runB]), ['runB', 'runA', 'doneNew', 'doneOld']);
});

test('global Recent Work represents a projected Session once through its origin Task', () => {
  const projected = makeSession({
    id: 'session-c',
    projectDir: 'project-c',
    originProjectId: 'project-a',
    taskId: 'linked-c',
  });
  const originTask: TaskEntity = {
    id: 'linked-c',
    projectId: 'project-a',
    projectViewId: 'project-a',
    title: 'Linked C',
    workflowStatus: 'todo',
    sortOrder: 0,
    sessions: [{
      id: projected.id,
      originProjectId: 'project-a',
      title: projected.title,
      lastModified: projected.lastModified,
      isRunning: false,
      sortOrder: 0,
    }],
    createdAt: projected.createdAt,
    updatedAt: projected.lastModified,
  };
  const projects = [
    { ...makeProject([]), encodedDir: 'project-a', displayName: 'Project A' },
    { ...makeProject([projected]), encodedDir: 'project-c', displayName: 'Project C' },
  ];

  const items = buildRecentWorkItems({
    projects,
    tasksByProject: { 'project-a': [originTask], 'project-c': [] },
    limit: 8,
    originOnly: true,
  });

  assert.deepEqual(items.map((item) => [item.id, item.projectId]), [
    ['linked-c', 'project-a'],
  ]);
});

test('global Recent Work uses retained canonical activity and runtime over a stale Task snapshot', () => {
  const retained = makeSession({
    id: 'session-c',
    title: 'Live retained Session',
    projectDir: 'project-c',
    originProjectId: 'project-a',
    taskId: 'linked-c',
    isRunning: true,
    status: 'running',
    createdAt: '2026-06-13T09:00:00.000Z',
    lastModified: '2026-06-13T12:00:00.000Z',
  });
  const staleTask: TaskEntity = {
    id: 'linked-c',
    projectId: 'project-a',
    projectViewId: 'project-a',
    title: 'Linked C',
    workflowStatus: 'todo',
    sortOrder: 0,
    sessions: [{
      id: retained.id,
      originProjectId: 'project-a',
      title: 'Stale Task snapshot',
      lastModified: '2026-06-13T10:00:00.000Z',
      isRunning: false,
      sortOrder: 0,
    }],
    createdAt: retained.createdAt,
    updatedAt: '2026-06-13T10:00:00.000Z',
  };
  const projects = [
    { ...makeProject([]), encodedDir: 'project-a', displayName: 'Project A' },
    { ...makeProject([]), encodedDir: 'project-c', displayName: 'Project C' },
  ];

  const items = buildRecentWorkItems({
    projects,
    tasksByProject: { 'project-a': [staleTask], 'project-c': [] },
    canonicalSessions: [retained],
    limit: 8,
    originOnly: true,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.projectId, 'project-a');
  assert.equal(items[0]?.session.title, 'Live retained Session');
  assert.equal(items[0]?.lastActivityAt, retained.lastModified);
  assert.equal(items[0]?.isRunning, true);
});
