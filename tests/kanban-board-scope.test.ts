import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectKanbanScopeData,
  filterKanbanTasks,
  resolveKanbanScope,
  selectKanbanProjectionItems,
} from '@/lib/kanban/board-scope';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import type { TaskEntity } from '@/types/task-entity';
import { buildProjectCollectionGroups } from '@/lib/chat/build-collection-groups';

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

test('selected Project treats projected direct Sessions as Chats and linked Worktrees as Tasks', () => {
  const canonicalLinkedSession = session('session-c', 'project-c');
  canonicalLinkedSession.taskId = 'linked-c';
  canonicalLinkedSession.originProjectId = 'project-a';
  const directSession = session('direct-c', 'project-c');
  directSession.originProjectId = 'project-c';
  const descendant = task('descendant-d', 'project-c');

  const scope = resolveKanbanScope('project-c', [
    project('project-c', [canonicalLinkedSession, directSession]),
  ]);
  const data = collectKanbanScopeData(
    scope,
    [project('project-c', [canonicalLinkedSession, directSession])],
    { 'project-c': [descendant] },
    { 'project-c': [] },
  );
  const items = selectKanbanProjectionItems(data, null);
  const sidebarGroups = buildProjectCollectionGroups(
    project('project-c', [canonicalLinkedSession, directSession]),
    [],
    [descendant],
  );

  assert.deepEqual(items.chats.map((item) => item.id), ['session-c', 'direct-c']);
  assert.deepEqual(items.tasks.map((item) => item.id), ['descendant-d']);
  assert.deepEqual(
    sidebarGroups.flatMap((group) => group.chats.map((item) => item.id)),
    items.chats.map((item) => item.id),
  );
  assert.deepEqual(
    sidebarGroups.flatMap((group) => group.tasks.map((item) => item.id)),
    items.tasks.map((item) => item.id),
  );
});

test('All Projects emits only origin Project representatives for canonical items', () => {
  const directA = session('direct-a', 'project-a');
  directA.originProjectId = 'project-a';
  const projectedC = session('session-c', 'project-c');
  projectedC.taskId = 'linked-c';
  projectedC.originProjectId = 'project-a';
  const directC = session('direct-c', 'project-c');
  directC.originProjectId = 'project-c';
  const linkedC = task('linked-c', 'project-a');
  linkedC.sessions = [{
    id: 'session-c',
    originProjectId: 'project-a',
    title: 'session-c',
    lastModified: '2026-07-14T00:00:00.000Z',
    isRunning: false,
    sortOrder: 0,
  }];

  const allProjects = [
    project('project-a', [directA]),
    project('project-c', [projectedC, directC]),
  ];
  const data = collectKanbanScopeData(
    resolveKanbanScope(ALL_PROJECTS_SENTINEL, allProjects),
    allProjects,
    { 'project-a': [linkedC], 'project-c': [] },
    { 'project-a': [], 'project-c': [] },
  );

  assert.deepEqual(data.sessions.map((item) => [item.id, item.projectDir]), [
    ['direct-a', 'project-a'],
    ['direct-c', 'project-c'],
  ]);
  assert.deepEqual(data.tasks.map((item) => [item.id, item.projectId]), [
    ['linked-c', 'project-a'],
  ]);
});

test('kanban trusts branch-scoped linked Worktree children and keeps zero-session Worktrees', () => {
  const visibleChild = session('visible-child', 'alpha');
  visibleChild.taskId = 'visible-task';

  const visibleTask = task('visible-task', 'alpha');
  visibleTask.sessions = [{
    id: visibleChild.id,
    title: visibleChild.title,
    lastModified: visibleChild.lastModified,
    isRunning: false,
  }];

  const hiddenTask = task('hidden-task', 'alpha');
  hiddenTask.sessions = [{
    id: 'archived-child',
    title: 'archived-child',
    lastModified: '2026-07-14T00:00:00.000Z',
    isRunning: false,
  }];

  assert.deepEqual(filterKanbanTasks(
    [task('zero-session-task', 'alpha'), visibleTask, hiddenTask],
    null,
  ).map((item) => item.id), [
    'zero-session-task',
    'visible-task',
    'hidden-task',
  ]);
});
