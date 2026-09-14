import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('saved policy schedules the actual runner without a settings API request', async (t) => {
  let removed = 0;
  let enabled = true;
  const fixture = {
    resolveServerDefaultUserId: async () => 'saved-user',
    SettingsManager: { load: async () => ({ autoDeleteArchivedWorktrees: enabled, archivedWorktreeRetentionDays: 1 }) },
    listExpiredArchivedWorktreeCandidates: async () => [{ worktreeId: 'expired', id: 'task', kind: 'task', title: 'Expired' }],
    pruneExpiredArchivedWorktrees: async (days: number, userId: string) => {
      assert.equal(days, 1);
      assert.equal(userId, 'saved-user');
      removed++;
      return { removed: 1, attempted: 1, skipped: 0, errors: [] };
    },
  };
  Object.assign(globalThis, { retentionStartupFixture: fixture });
  const bundle = await build({
    stdin: { contents: `export * from './src/lib/archive/archive-retention-startup'; export * from './src/lib/archive/archive-retention-runner';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'startup-fixture', setup(b) {
      b.onResolve({ filter: /^(?:@\/lib\/(?:server-default-user|settings\/manager|logger)|\.\/archive-service)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('logger')
        ? 'export default {warn(){},error(){}}'
        : 'export const {resolveServerDefaultUserId, SettingsManager, listExpiredArchivedWorktreeCandidates, pruneExpiredArchivedWorktrees} = globalThis.retentionStartupFixture;' }));
    } }],
  });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await runtime.startArchivedWorktreeRetention();
    t.mock.timers.tick(59_999);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed, 0);
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed, 1);
    enabled = false;
    await runtime.startArchivedWorktreeRetention();
    t.mock.timers.tick(120_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed, 1, 'disabled saved policy never starts deletion');
    enabled = true;
    await runtime.startArchivedWorktreeRetention();
    runtime.stopArchivedWorktreeRetention();
    t.mock.timers.tick(120_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed, 1);
  } finally {
    runtime.stopArchivedWorktreeRetention();
    t.mock.timers.reset();
    Reflect.deleteProperty(globalThis, 'retentionStartupFixture');
  }
});
