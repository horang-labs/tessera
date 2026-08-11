import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRecentWorkOrderedSessionIds,
  buildSidebarOrderedSessionIds,
  selectSidebarProjectTasks,
} from '../src/components/chat/sidebar-utils';
import type { RecentWorkItem } from '../src/lib/chat/recent-work';
import { useSelectionStore } from '../src/stores/selection-store';
import type { ProjectGroup, UnifiedSession } from '../src/types/chat';
import type { TaskEntity } from '../src/types/task-entity';

function task(id: string, projectViewId: string): TaskEntity {
  return { id, projectViewId } as TaskEntity;
}

test('Sidebar selects the target Project task cache instead of the last loaded Project slot', () => {
  const staleCurrentTasks = [task('task-from-project-a', 'project-a')];
  const targetProjectTasks = [task('task-from-project-b', 'project-b')];

  assert.strictEqual(
    selectSidebarProjectTasks({
      tasks: staleCurrentTasks,
      tasksByProject: {
        'project-a': staleCurrentTasks,
        'project-b': targetProjectTasks,
      },
    }, 'project-b'),
    targetProjectTasks,
  );
});

test('Sidebar uses one stable empty task list while a Project cache is unavailable', () => {
  const state = {
    tasks: [task('task-from-project-a', 'project-a')],
    tasksByProject: {},
  };

  assert.strictEqual(
    selectSidebarProjectTasks(state, 'project-b'),
    selectSidebarProjectTasks(state, 'project-b'),
  );
  assert.deepEqual(selectSidebarProjectTasks(state, 'project-b'), []);
});

test('Shift range selection includes rendered task sessions missing from the direct Session projection', () => {
  const session = (id: string, taskId: string): UnifiedSession => ({
    id,
    taskId,
    archived: false,
    sortOrder: 0,
  }) as UnifiedSession;
  const linkedTask = (id: string, sessionId: string, sortOrder: number): TaskEntity => ({
    id,
    projectId: 'project-a',
    projectViewId: 'project-a',
    sortOrder,
    sessions: [{ id: sessionId, sortOrder: 0 }],
  }) as TaskEntity;

  const first = linkedTask('task-a', 'session-a', 0);
  const projectedOnly = linkedTask('task-b', 'session-b', 1);
  const last = linkedTask('task-c', 'session-c', 2);
  const project = {
    encodedDir: 'project-a',
    sessions: [session('session-a', 'task-a'), session('session-c', 'task-c')],
  } as ProjectGroup;

  const orderedIds = buildSidebarOrderedSessionIds({
    selectedProjectDir: project.encodedDir,
    projects: [project],
    selectedProject: project,
    collectionGroups: [{
      collectionId: null,
      tasks: [first, projectedOnly, last],
      chats: [],
    }],
  });

  useSelectionStore.getState().clearSelection();
  useSelectionStore.getState().toggleSelect('session-a');
  useSelectionStore.getState().rangeSelect('session-c', orderedIds);

  assert.deepEqual(
    [...useSelectionStore.getState().selectedIds],
    ['session-a', 'session-b', 'session-c'],
  );
});

test('Recent Work Shift range selection follows the rendered recent-item order', () => {
  const recentItems = [
    { type: 'task', task: { sessions: [{ id: 'session-a' }] } },
    { type: 'task', task: { sessions: [{ id: 'session-b' }] } },
    { type: 'chat', session: { id: 'session-c' } },
  ] as RecentWorkItem[];

  useSelectionStore.getState().clearSelection();
  useSelectionStore.getState().toggleSelect('session-a');
  useSelectionStore.getState().rangeSelect(
    'session-c',
    buildRecentWorkOrderedSessionIds(recentItems),
  );

  assert.deepEqual(
    [...useSelectionStore.getState().selectedIds],
    ['session-a', 'session-b', 'session-c'],
  );
});
