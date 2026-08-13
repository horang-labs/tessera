import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSessionBranchPresentation } from '@/lib/session/session-branch-presentation';

test('a direct Session shows only its creation branch after the Project checkout changes', () => {
  assert.deepEqual(
    resolveSessionBranchPresentation({
      scopeBranch: 'main',
    }),
    {
      branch: 'main',
    },
  );
});

test('task Worktree branches keep the existing checkout-branch treatment', () => {
  assert.deepEqual(
    resolveSessionBranchPresentation({
      worktreeBranch: 'feature/task',
      scopeBranch: 'feature/task',
    }),
    {
      branch: 'feature/task',
    },
  );
});

test('legacy direct Sessions do not gain a scope badge', () => {
  assert.equal(resolveSessionBranchPresentation({}), null);
});
