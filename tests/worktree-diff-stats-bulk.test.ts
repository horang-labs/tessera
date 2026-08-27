import assert from 'node:assert/strict';
import test from 'node:test';
import { getCachedBulk, getCachedOrScheduleBulk } from '@/lib/git/worktree-diff-stats-bulk';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';

const cachedStats: WorktreeDiffStats = {
  added: 1,
  removed: 0,
  changedFiles: 1,
  newFiles: 1,
  deletedFiles: 0,
  computedAt: '2026-08-20T00:00:00.000Z',
};

test('cold bulk reads deduplicate checkout paths without scheduling work', () => {
  const reads: string[] = [];
  const result = getCachedBulk(
    ['/repo/project', '/repo/project', undefined],
    (workDir) => {
      reads.push(workDir);
      return cachedStats;
    },
  );

  assert.deepEqual(reads, ['/repo/project']);
  assert.deepEqual(Array.from(result.entries()), [['/repo/project', cachedStats]]);
});

test('cold bulk reads deduplicate WSL display and UNC spellings', () => {
  const reads: string[] = [];
  const posix = '/home/work/Source/tessera-dev';
  const unc = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\Source\\tessera-dev';

  getCachedBulk([posix, unc], (workDir) => {
    reads.push(workDir);
    return cachedStats;
  });

  assert.deepEqual(reads, [posix]);
});

test('bulk list reads return cached values and schedule every unique miss in list order', () => {
  const reads: string[] = [];
  const scheduled: Array<{ workDir: string; userId: string }> = [];
  const result = getCachedOrScheduleBulk(
    ['/repo/a', '/repo/b', '/repo/a', undefined],
    'user-1',
    {
      readCached: (workDir) => {
        reads.push(workDir);
        return workDir === '/repo/a' ? cachedStats : undefined;
      },
      isStale: () => false,
      schedule: (workDir, userId) => {
        scheduled.push({ workDir, userId });
      },
    },
  );

  assert.deepEqual(reads, ['/repo/a', '/repo/b']);
  assert.deepEqual(Array.from(result.entries()), [['/repo/a', cachedStats]]);
  assert.deepEqual(scheduled, [{ workDir: '/repo/b', userId: 'user-1' }]);
});

test('bulk list reads keep stale values visible while scheduling one refresh', () => {
  const scheduled: string[] = [];
  const result = getCachedOrScheduleBulk(
    ['/repo/a', '/repo/a'],
    'user-1',
    {
      readCached: () => cachedStats,
      isStale: () => true,
      schedule: (workDir) => scheduled.push(workDir),
    },
  );

  assert.deepEqual(Array.from(result.entries()), [['/repo/a', cachedStats]]);
  assert.deepEqual(scheduled, ['/repo/a']);
});

test('bulk list schedules one refresh for WSL display and UNC spellings', () => {
  const scheduled: string[] = [];
  const posix = '/home/work/Source/tessera-dev';
  const unc = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\Source\\tessera-dev';

  getCachedOrScheduleBulk([posix, unc], 'user-1', {
    readCached: () => undefined,
    isStale: () => false,
    schedule: (workDir) => scheduled.push(workDir),
  });

  assert.deepEqual(scheduled, [posix]);
});
