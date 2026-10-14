import assert from 'node:assert/strict';
import test from 'node:test';
import { useBoardStore } from '@/stores/board-store';

test('a worktree task starts expanded and toggles collapse by task id', () => {
  const { toggleTaskCollapse } = useBoardStore.getState();
  assert.equal(useBoardStore.getState().collapsedTasks['task-a'] ?? false, false);

  toggleTaskCollapse('task-a');
  assert.equal(useBoardStore.getState().collapsedTasks['task-a'], true);
  assert.equal(useBoardStore.getState().collapsedTasks['task-b'] ?? false, false);

  // Re-expanding drops the key so the persisted record only holds collapsed tasks.
  toggleTaskCollapse('task-a');
  assert.equal('task-a' in useBoardStore.getState().collapsedTasks, false);
});
