import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSessionBranchPresentation } from '@/lib/session/session-branch-presentation';

test('a direct Session names stored scope separately from the live Worktree branch', () => {
  assert.deepEqual(
    resolveSessionBranchPresentation({
      scopeBranch: 'main',
      liveBranch: 'feature/external-switch',
    }),
    {
      branch: 'main',
      labelKind: 'scope',
      liveBranch: 'feature/external-switch',
      mismatch: true,
    },
  );
});

test('task Worktree branches keep the existing checkout-branch treatment', () => {
  assert.deepEqual(
    resolveSessionBranchPresentation({
      worktreeBranch: 'feature/task',
      scopeBranch: 'feature/task',
      liveBranch: 'feature/task',
    }),
    {
      branch: 'feature/task',
      labelKind: 'branch',
      liveBranch: null,
      mismatch: false,
    },
  );
});

test('legacy direct Sessions do not gain a scope badge', () => {
  assert.equal(resolveSessionBranchPresentation({}), null);
});
