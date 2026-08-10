import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSidebarProjectTasks } from '../src/components/chat/sidebar-utils';
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
