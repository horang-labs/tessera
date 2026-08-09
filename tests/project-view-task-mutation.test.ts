import assert from 'node:assert/strict';
import test from 'node:test';
import { useTaskStore } from '@/stores/task-store';
import type { TaskEntity } from '@/types/task-entity';

const originalFetch = globalThis.fetch;

function task(projectId: string, projectViewId: string): TaskEntity {
  return {
    id: 'shared-worktree',
    projectId,
    projectViewId,
    title: 'Shared Worktree',
    workflowStatus: 'todo',
    sortOrder: 0,
    sessions: [],
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  useTaskStore.setState(useTaskStore.getInitialState(), true);
});

test('canonical Task mutations update every cached Project appearance without leaking Collections', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const inA = task('project-a', 'project-a');
  const inC = task('project-a', 'project-c');
  useTaskStore.setState({
    ...useTaskStore.getInitialState(),
    tasks: [inC],
    tasksByProject: { 'project-a': [inA], 'project-c': [inC] },
    currentProjectId: 'project-c',
    loaded: true,
    loadedProjects: { 'project-a': true, 'project-c': true },
  }, true);

  assert.equal(await useTaskStore.getState().updateTask('shared-worktree', {
    title: 'Renamed everywhere',
    workflowStatus: 'done',
  }), true);
  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject).map((tasks) => ({
      title: tasks[0]?.title,
      status: tasks[0]?.workflowStatus,
    })),
    [
      { title: 'Renamed everywhere', status: 'done' },
      { title: 'Renamed everywhere', status: 'done' },
    ],
  );

  assert.equal(await useTaskStore.getState().updateTask('shared-worktree', {
    collectionId: 'collection-a',
  }), true);
  assert.equal(useTaskStore.getState().tasksByProject['project-a'][0]?.collectionId, 'collection-a');
  assert.equal(useTaskStore.getState().tasksByProject['project-c'][0]?.collectionId, undefined);
  assert.equal(useTaskStore.getState().tasks[0]?.projectViewId, 'project-c');
});
