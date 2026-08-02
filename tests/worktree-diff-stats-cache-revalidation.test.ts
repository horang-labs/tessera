import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCachedDiffStats,
  isDiffStatsStale,
} from '@/lib/git/worktree-diff-stats-cache';
import { DIFF_STATS_STALE_TTL_MS } from '@/lib/git/worktree-diff-stats-staleness';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';

interface CacheEntry {
  stats: WorktreeDiffStats | null;
  computedAt: number;
}

/**
 * Seed the module's globalThis-backed cache directly. Going through the real
 * compute path would shell out to git; what needs proving here is only how a
 * seeded entry's age is reported back to read paths.
 */
function seedCacheEntry(workDir: string, computedAt: number): void {
  const state = (globalThis as unknown as Record<
    symbol,
    { entries: Map<string, CacheEntry> } | undefined
  >)[Symbol.for('tessera.worktreeDiffStatsCache')];
  assert.ok(state, 'importing the cache module should create its global state');
  state.entries.set(workDir, {
    stats: {
      added: 8,
      removed: 0,
      changedFiles: 2,
      newFiles: 0,
      deletedFiles: 0,
      computedAt: new Date(computedAt).toISOString(),
    },
    computedAt,
  });
}

test('a cache miss is not stale — it is a distinct state with no value to serve', () => {
  assert.equal(getCachedDiffStats('/repo/never-computed'), undefined);
  assert.equal(isDiffStatsStale('/repo/never-computed'), false);
});

test('a fresh entry is served without being marked stale', () => {
  const now = 5_000_000;
  seedCacheEntry('/repo/fresh', now - 1_000);

  assert.equal(isDiffStatsStale('/repo/fresh', now), false);
  assert.equal(getCachedDiffStats('/repo/fresh')?.added, 8);
});

test('a stale entry keeps serving its value so the read path never blocks', () => {
  const now = 5_000_000;
  seedCacheEntry('/repo/stale', now - DIFF_STATS_STALE_TTL_MS - 1);

  assert.equal(isDiffStatsStale('/repo/stale', now), true);
  // Staleness marks the entry for refresh; it does not withdraw the value.
  assert.equal(getCachedDiffStats('/repo/stale')?.added, 8);
});
