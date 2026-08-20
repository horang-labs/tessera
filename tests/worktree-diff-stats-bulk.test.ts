import assert from 'node:assert/strict';
import test from 'node:test';
import { getCachedBulk } from '@/lib/git/worktree-diff-stats-bulk';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';

const cachedStats: WorktreeDiffStats = {
  added: 1,
  removed: 0,
  changedFiles: 1,
  newFiles: 1,
  deletedFiles: 0,
  computedAt: '2026-08-20T00:00:00.000Z',
};

test('cold bulk list reads ignore cache misses without scheduling work', () => {
  const reads: string[] = [];
  const result = getCachedBulk(
    ['/repo/a', '/repo/b', '/repo/a', undefined],
    (workDir) => {
      reads.push(workDir);
      return workDir === '/repo/a' ? cachedStats : undefined;
    },
  );

  assert.deepEqual(reads, ['/repo/a', '/repo/b']);
  assert.deepEqual(Array.from(result.entries()), [['/repo/a', cachedStats]]);
});
