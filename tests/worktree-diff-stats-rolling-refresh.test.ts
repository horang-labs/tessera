import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// Keep the real cache, generation tracking, bulk reads and scheduler. Only the
// Git process and environment lookup are controlled to exercise refresh races.
async function fixture() {
  const pending: Array<(value: unknown) => void> = [];
  const id = `diffRolling${Math.random().toString(36).slice(2)}`;
  Object.assign(globalThis, { [id]: {
    computeWorktreeDiffStats: () => new Promise((resolve) => pending.push(resolve)),
    resolveGitEnvironment: async () => 'wsl',
  } });
  const bundle = await build({
    stdin: { contents: `export * from './src/lib/git/worktree-diff-stats-cache';
      export * from './src/lib/git/worktree-diff-stats-bulk';
      export { invalidateGitReads } from './src/lib/git/git-read-cache';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'controlled-git', setup(b) {
      b.onResolve({ filter: /(?:^\.\/worktree-diff-stats$|git-environment$|path-environment$)/ }, args => ({ path: args.path, namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
        `export const { computeWorktreeDiffStats, resolveGitEnvironment } = globalThis.${id};
         export const isWindowsHostedWslFilesystemPath = () => false;` }));
    } }],
  });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  async function finish(added: number) {
    for (let i = 0; !pending.length && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(pending.length, 'a requested computation must eventually run');
    pending.shift()!({ added, removed: 1, changedFiles: 1, newFiles: 0, deletedFiles: 0, computedAt: new Date().toISOString() });
  }
  return { runtime, pending, finish, cleanup() { Reflect.deleteProperty(globalThis, id); } };
}

test('project list retains cached counts throughout invalidation and rolling refresh', async () => {
  const f = await fixture();
  const { runtime: r } = f;
  const a = '/rolling/a', b = '/rolling/b', user = 'rolling-user';
  try {
    const first = r.computeAndCache(a, user);
    await f.finish(8); await first;
    const second = r.computeAndCache(b, user);
    await f.finish(12); await second;
    r.invalidateGitReads();
    const list = r.getCachedOrScheduleBulk([a, b], user);
    // The old values remain visible while each worktree refreshes in turn.
    assert.equal(list.get(a)?.added, 8);
    assert.equal(list.get(b)?.added, 12);
    const refreshA = r.flushRecompute(a, user);
    const refreshB = r.flushRecompute(b, user);
    assert.equal(r.getCachedDiffStats(a, user)?.added, 8);
    await f.finish(9); await refreshA;
    assert.equal(r.getCachedDiffStats(a, user)?.added, 9);
    assert.equal(r.getCachedDiffStats(b, user)?.added, 12);
    await f.finish(13); await refreshB;
    assert.equal(r.isDiffStatsStale(b, Date.now(), user), false);
    assert.equal(r.getCachedOrScheduleBulk([a, b], user).get(b)?.added, 13);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(f.pending.length, 0, 'returning to a fresh project must reuse its cache');
  } finally { f.cleanup(); }
});

test('invalidation during a computation retries and publishes without another list request', async () => {
  const f = await fixture();
  const { runtime: r } = f;
  const dir = '/rolling/race', user = 'rolling-race';
  const seen: number[] = [];
  const unsubscribe = r.subscribeDiffStats((wd: string, stats: { added: number }) => { if (wd === dir) seen.push(stats.added); });
  try {
    const initial = r.computeAndCache(dir, user);
    await f.finish(4); await initial;
    const refresh = r.flushRecompute(dir, user);
    // Invalidate after the Git read started, before it completes.
    while (!f.pending.length) await new Promise(r => setTimeout(r, 1));
    r.invalidateGitReads();
    await f.finish(5);
    await f.finish(6);
    await refresh;
    assert.deepEqual(seen, [4, 6]);
    assert.equal(r.getCachedDiffStats(dir, user)?.added, 6);
    assert.equal(r.isDiffStatsStale(dir, Date.now(), user), false);
  } finally { unsubscribe(); f.cleanup(); }
});

test('a refs-only invalidation such as a fetch keeps diff stats fresh', async () => {
  const f = await fixture();
  const { runtime: r } = f;
  const dir = '/rolling/fetch', user = 'rolling-fetch';
  try {
    const initial = r.computeAndCache(dir, user);
    await f.finish(3); await initial;
    r.invalidateGitReads('refs');
    assert.equal(r.isDiffStatsStale(dir, Date.now(), user), false);
    assert.equal(r.getCachedOrScheduleBulk([dir], user).get(dir)?.added, 3);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(f.pending.length, 0, 'a fetch must not recompute working-tree counts');
  } finally { f.cleanup(); }
});
