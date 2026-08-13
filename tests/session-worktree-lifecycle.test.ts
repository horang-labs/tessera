import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSessionWorktreeLifecycleTarget } from '@/lib/session/session-worktree-lifecycle';

test('a sole Session inherits its managed Worktree lifecycle', () => {
  assert.deepEqual(resolveSessionWorktreeLifecycleTarget('session-one', {
    id: 'task-one',
    worktreeId: 'wt-one',
    sessions: [{ id: 'session-one' }],
  }), {
    kind: 'worktree',
    taskId: 'task-one',
    worktreeId: 'wt-one',
  });
});

test('a Session with Worktree siblings keeps an independent lifecycle', () => {
  assert.deepEqual(resolveSessionWorktreeLifecycleTarget('session-one', {
    id: 'task-many',
    worktreeId: 'wt-many',
    sessions: [{ id: 'session-one' }, { id: 'session-two' }],
  }), {
    kind: 'session',
    sessionId: 'session-one',
  });
});

test('a task without a canonical Worktree identity never promotes Session actions', () => {
  assert.deepEqual(resolveSessionWorktreeLifecycleTarget('session-one', {
    id: 'legacy-task',
    sessions: [{ id: 'session-one' }],
  }), {
    kind: 'session',
    sessionId: 'session-one',
  });
});
