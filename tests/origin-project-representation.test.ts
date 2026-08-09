import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOriginProjectRepresentation,
  getCanonicalRunningSessionRepresentatives,
  originProjectContainsRunningSession,
} from '@/lib/projects/origin-project-representation';
import { getProjectIdsMissingTaskProjection } from '@/lib/tasks/project-task-projection-loading';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';

const timestamp = '2026-08-09T00:00:00.000Z';

function session(
  id: string,
  projectDir: string,
  originProjectId: string,
  isRunning = false,
): UnifiedSession {
  return {
    id,
    title: id,
    projectDir,
    originProjectId,
    isRunning,
    status: isRunning ? 'running' : 'completed',
    lastModified: timestamp,
    createdAt: timestamp,
    archived: false,
    sortOrder: 0,
  };
}

function project(id: string, sessions: UnifiedSession[]): ProjectGroup {
  return {
    encodedDir: id,
    displayName: id,
    decodedPath: `/repo/${id}`,
    isCurrent: false,
    sessions,
    totalSessions: sessions.length,
    allLoaded: true,
    loadedCount: sessions.length,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function task(id: string, projectId: string, sessions: TaskEntity['sessions'] = []): TaskEntity {
  return {
    id,
    projectId,
    projectViewId: projectId,
    title: id,
    workflowStatus: 'todo',
    sortOrder: 0,
    sessions,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test('global representation keeps canonical items only at their origin Project', () => {
  const shared = session('shared', 'project-c', 'project-a');
  const projects = [
    project('project-a', [session('direct-a', 'project-a', 'project-a')]),
    project('project-c', [shared, session('direct-c', 'project-c', 'project-c')]),
  ];
  const linked = task('linked-c', 'project-a', [
    {
      id: 'shared',
      originProjectId: 'project-a',
      title: 'shared',
      lastModified: timestamp,
      isRunning: true,
      sortOrder: 0,
    },
    {
      id: 'direct-c',
      originProjectId: 'project-c',
      title: 'direct-c',
      lastModified: timestamp,
      isRunning: false,
      sortOrder: 1,
    },
  ]);
  const representation = buildOriginProjectRepresentation(projects, {
    'project-a': [linked],
    'project-c': [linked],
  });

  assert.deepEqual(representation.projects.map((item) => [
    item.encodedDir,
    item.sessions.map((value) => value.id),
  ]), [
    ['project-a', ['direct-a']],
    ['project-c', ['direct-c']],
  ]);
  assert.deepEqual(representation.tasks.map((item) => item.id), ['linked-c']);
  assert.deepEqual(representation.tasks[0]?.sessions.map((item) => item.id), ['shared']);
  assert.equal(originProjectContainsRunningSession(
    representation.projects[0],
    representation.tasksByProject['project-a'] ?? [],
  ), true);
});

test('running navigation deduplicates canonical Sessions and targets the origin Project', () => {
  const projects = [
    project('project-a', [session('shared', 'project-a', 'project-a', true)]),
    project('project-c', [
      session('shared', 'project-c', 'project-a', true),
      session('running-c', 'project-c', 'project-c', true),
    ]),
  ];

  assert.deepEqual(
    getCanonicalRunningSessionRepresentatives(projects).map((item) => [item.id, item.projectDir]),
    [['shared', 'project-a'], ['running-c', 'project-c']],
  );
});

test('fresh global surfaces request every missing Project task projection', () => {
  const projects = [project('project-a', []), project('project-c', [])];

  assert.deepEqual(getProjectIdsMissingTaskProjection(
    projects,
    { 'project-a': true },
    {},
    new Set(),
  ), ['project-c']);
  assert.deepEqual(getProjectIdsMissingTaskProjection(projects, {}, {}, new Set()), [
    'project-a',
    'project-c',
  ]);
  assert.deepEqual(getProjectIdsMissingTaskProjection(
    projects,
    {},
    {},
    new Set(['project-a', 'project-c']),
  ), []);
});
