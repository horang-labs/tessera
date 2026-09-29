import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// Exercise the real initial list route and bulk scheduler. Only process/DB/Git
// dependencies are fixtures: no selected session or focused task request exists.
test('initial project list schedules every checkout without opening a session', async () => {
  const scheduled: Array<[string, string]> = [];
  const cached = { added: 3, removed: 1, changedFiles: 1 };
  const fixture = {
    requireAuthenticatedUserId: async () => ({ userId: 'sidebar-user' }),
    getAgentEnvironment: async () => 'wsl',
    getRuntimePlatform: () => 'win32',
    getActiveSessionIds: () => new Set(),
    processManager: {
      getGeneratingSessionIds: () => new Set(),
      getSessionRuntimeConfigs: () => new Map(),
    },
    getVisibleProjects: () => [{ id: 'a', decoded_path: '/repo/a' }, { id: 'b', decoded_path: '/repo/b' }],
    getProjectViewProjection: (id: string) => ({
      projectWorktree: { id, filesystemPath: `/repo/${id}` },
      linkedWorktrees: [
        { worktreeBranch: 'feature', workDir: `/repo/${id}-feature` },
        { worktreeBranch: 'feature', workDir: `/repo/${id}-feature` },
        { worktreeBranch: 'deleted', workDir: `/repo/${id}-deleted`, worktreeDeletedAt: '2026-09-01' },
      ],
      sessions: [{ id: `${id}-chat`, updated_at: '2026-09-01' }],
    }),
    getProjectViewCreationBranches: () => [],
    mapSessionRowToApi: (row: unknown) => row,
    formatPathForAgentDisplay: (path: string) => path,
    hasPreparationScript: () => false,
    isElectronAppRuntimeProjectPath: () => false,
    shouldAutoRegisterCurrentProject: () => false,
    getSessionHistoryModifiedAt: () => null,
    getCachedDiffStats: (path: string) => path === '/repo/a' ? cached : undefined,
    isDiffStatsStale: () => false,
    scheduleRecompute: (path: string, userId: string) => scheduled.push([path, userId]),
  };
  Object.assign(globalThis, { sidebarDiffStartupFixture: fixture });
  const bundle = await build({
    entryPoints: ['src/app/api/sessions/projects/route.ts'],
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'sidebar-startup-fixture', setup(builder) {
      builder.onResolve({ filter: /^(?:next\/server|@\/)/ }, (args) => {
        if (args.path === '@/lib/git/worktree-diff-stats-bulk') return undefined;
        return { path: args.path, namespace: 'fixture' };
      });
      builder.onResolve({ filter: /^\.\/worktree-diff-stats-cache$/ }, (args) => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
        contents: args.path === 'next/server'
          ? 'export const NextResponse = { json: (data) => ({ status: 200, json: async () => data }) };'
          : args.path.endsWith('logger')
            ? 'export default { info(){}, error(){}, warn(){} };'
            : `export const { ${Object.keys(fixture).join(', ')} } = globalThis.sidebarDiffStartupFixture;`,
      }));
    } }],
  });
  try {
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    const response = await runtime.GET({ url: 'http://localhost/api/sessions/projects' });
    assert.equal(response.status, 200);
    assert.deepEqual(scheduled, [
      ['/repo/a-feature', 'sidebar-user'],
      ['/repo/b', 'sidebar-user'],
      ['/repo/b-feature', 'sidebar-user'],
    ]);
    const data = await response.json();
    assert.deepEqual(data.projects[0].projectWorktree.diffStats, cached);
    assert.deepEqual(data.projects[0].sessions[0].diffStats, cached);
  } finally {
    Reflect.deleteProperty(globalThis, 'sidebarDiffStartupFixture');
  }
});
