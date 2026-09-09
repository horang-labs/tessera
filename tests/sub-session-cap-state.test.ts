import assert from 'node:assert/strict';
import test from 'node:test';
import { useSubSessionCapStateStore } from '@/stores/sub-session-cap-state-store';

test.afterEach(() => {
  useSubSessionCapStateStore.setState(
    useSubSessionCapStateStore.getInitialState(),
    true,
  );
});

test('a task keeps its revealed sub-session state while its project view is unmounted', () => {
  const taskId = 'task-in-project-a';

  useSubSessionCapStateStore.getState().toggleRevealed(taskId);

  // Project changes unmount this task row. The UI state must belong to the
  // task, rather than to that short-lived component instance.
  assert.equal(useSubSessionCapStateStore.getState().isRevealed(taskId), true);
  assert.equal(useSubSessionCapStateStore.getState().isRevealed('task-in-project-b'), false);
});
