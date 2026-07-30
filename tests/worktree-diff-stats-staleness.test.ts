import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DIFF_STATS_STALE_TTL_MS,
  isDiffStatsEntryStale,
} from '@/lib/git/worktree-diff-stats-staleness';

test('an entry younger than the TTL is trusted', () => {
  const now = 1_000_000;

  assert.equal(isDiffStatsEntryStale(now - (DIFF_STATS_STALE_TTL_MS - 1), now), false);
});

test('an entry that reached the TTL is stale', () => {
  const now = 1_000_000;

  assert.equal(isDiffStatsEntryStale(now - DIFF_STATS_STALE_TTL_MS, now), true);
});

test('a just-computed entry is never stale', () => {
  const now = 1_000_000;

  assert.equal(isDiffStatsEntryStale(now, now), false);
});

/**
 * The freeze this backstop exists for: a diff badge kept two-hour-old counts
 * because every push trigger stayed quiet. Any TTL that fails this assertion
 * would let that recur.
 */
test('a two-hour-old entry is stale', () => {
  const now = 1_000_000;

  assert.equal(isDiffStatsEntryStale(now - 2 * 60 * 60_000, now), true);
});
