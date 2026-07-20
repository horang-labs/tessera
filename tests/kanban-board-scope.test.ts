import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectKanbanScopeData,
  resolveKanbanScope,
} from '@/lib/kanban/board-scope';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import type { TaskEntity } from '@/types/task-entity';

function session(id: string, projectDir: string): UnifiedSession {
  return {
    id,
    title: id,
    projectDir,
    isRunning: false,
    status: 'completed',
    lastModified: '2026-07-14T00:00:00.000Z',
    createdAt: '2026-07-14T00:00:00.000Z',
    archived: false,
    sortOrder: 0,
  };
}

function project(id: string, sessions: UnifiedSession[]): ProjectGroup {
  return {
    encodedDir: id,
    displayName: id.toUpperCase(),
    decodedPath: `/work/${id}`,
    isCurrent: false,
    sessions,
    totalSessions: sessions.length,
    allLoaded: true,
    loadedCount: sessions.length,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function task(id: string, projectId: string): TaskEntity {
  return {
    id,
    projectId,
    title: id,
    workflowStatus: 'todo',
    sortOrder: 0,
    sessions: [],
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}

const projects = [
  project('alpha', [session('chat-alpha', 'alpha')]),
  project('beta', [session('chat-beta', 'beta')]),
];

const tasksByProject: Record<string, TaskEntity[]> = {
  alpha: [task('task-alpha', 'alpha')],
  beta: [task('task-beta', 'beta')],
};

const collectionsByProject: Record<string, Collection[]> = {
  alpha: [{ id: 'collection-alpha', projectId: 'alpha', label: 'Alpha', color: '#111111', sortOrder: 0 }],
  beta: [{ id: 'collection-beta', projectId: 'beta', label: 'Beta', color: '#222222', sortOrder: 0 }],
};

test('all-projects scope exposes every project without treating the sentinel as a project id', () => {
  const scope = resolveKanbanScope(ALL_PROJECTS_SENTINEL, projects);
  assert.deepEqual(scope, {
    kind: 'all-projects',
    projectIds: ['alpha', 'beta'],
  });

  const data = collectKanbanScopeData(scope, projects, tasksByProject, collectionsByProject);
  assert.deepEqual(data.projects.map((item) => item.encodedDir), ['alpha', 'beta']);
  assert.deepEqual(data.sessions.map((item) => item.id), ['chat-alpha', 'chat-beta']);
  assert.deepEqual(data.tasks.map((item) => item.id), ['task-alpha', 'task-beta']);
  assert.deepEqual(Object.keys(data.collectionsByProject), ['alpha', 'beta']);
});
test('single-project scope keeps sessions, tasks, and collections project-local', () => {
  const scope = resolveKanbanScope('beta', projects);
  assert.deepEqual(scope, { kind: 'project', projectId: 'beta' });

  const data = collectKanbanScopeData(scope, projects, tasksByProject, collectionsByProject);
  assert.deepEqual(data.projects.map((item) => item.encodedDir), ['beta']);
  assert.deepEqual(data.sessions.map((item) => item.id), ['chat-beta']);
  assert.deepEqual(data.tasks.map((item) => item.id), ['task-beta']);
  assert.deepEqual(Object.keys(data.collectionsByProject), ['beta']);
});
