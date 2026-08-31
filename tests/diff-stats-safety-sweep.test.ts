import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runDiffStatsSafetySweep,
  type DiffStatsSafetySweepDependencies,
} from '@/lib/git/diff-stats-safety-sweep';

interface Fixture {
  connectedUserIds?: string[];
  sessionsByUser?: Record<string, string[]>;
  workDirBySession?: Record<string, string | null>;
  staleWorkDirs?: string[];
}

function createDependencies(fixture: Fixture): {
  dependencies: DiffStatsSafetySweepDependencies;
  recomputed: Array<{ workDir: string; userId: string }>;
} {
  const recomputed: Array<{ workDir: string; userId: string }> = [];
  const stale = new Set(fixture.staleWorkDirs ?? []);

  return {
    recomputed,
    dependencies: {
      getConnectedUserIds: () => fixture.connectedUserIds ?? [],
      getActiveSessionIds: (userId) => fixture.sessionsByUser?.[userId] ?? [],
      getSessionWorkDir: (sessionId) => fixture.workDirBySession?.[sessionId] ?? null,
      needsRefresh: (workDir) => stale.has(workDir),
      recompute: (workDir, userId) => {
        recomputed.push({ workDir, userId });
      },
    },
  };
}

test('sweep refreshes only the worktrees whose cached stats went stale', () => {
  const { dependencies, recomputed } = createDependencies({
    connectedUserIds: ['user-a'],
    sessionsByUser: { 'user-a': ['session-stale', 'session-fresh'] },
    workDirBySession: {
      'session-stale': '/repo/stale',
      'session-fresh': '/repo/fresh',
    },
    staleWorkDirs: ['/repo/stale'],
  });

  const result = runDiffStatsSafetySweep(dependencies);

  assert.deepEqual(recomputed, [{ workDir: '/repo/stale', userId: 'user-a' }]);
  assert.deepEqual(result.refreshed, ['/repo/stale']);
  assert.equal(result.inspected, 2);
});

test('sweep does nothing when no user is connected to receive the broadcast', () => {
  const { dependencies, recomputed } = createDependencies({
    connectedUserIds: [],
    sessionsByUser: { 'user-a': ['session-stale'] },
    workDirBySession: { 'session-stale': '/repo/stale' },
    staleWorkDirs: ['/repo/stale'],
  });

  const result = runDiffStatsSafetySweep(dependencies);

  assert.deepEqual(recomputed, []);
  assert.equal(result.inspected, 0);
});

test('sessions sharing one workDir produce a single recompute', () => {
  const { dependencies, recomputed } = createDependencies({
    connectedUserIds: ['user-a'],
    sessionsByUser: { 'user-a': ['session-1', 'session-2', 'session-3'] },
    workDirBySession: {
      'session-1': '/repo/shared',
      'session-2': '/repo/shared',
      'session-3': '/repo/shared',
    },
    staleWorkDirs: ['/repo/shared'],
  });

  runDiffStatsSafetySweep(dependencies);

  assert.deepEqual(recomputed, [{ workDir: '/repo/shared', userId: 'user-a' }]);
});

test('a workDir shared across users is recomputed once, for the first owner seen', () => {
  const { dependencies, recomputed } = createDependencies({
    connectedUserIds: ['user-a', 'user-b'],
    sessionsByUser: {
      'user-a': ['session-a'],
      'user-b': ['session-b'],
    },
    workDirBySession: {
      'session-a': '/repo/shared',
      'session-b': '/repo/shared',
    },
    staleWorkDirs: ['/repo/shared'],
  });

  runDiffStatsSafetySweep(dependencies);

  assert.deepEqual(recomputed, [{ workDir: '/repo/shared', userId: 'user-a' }]);
});

test('sessions without a work_dir are skipped', () => {
  const { dependencies, recomputed } = createDependencies({
    connectedUserIds: ['user-a'],
    sessionsByUser: { 'user-a': ['session-no-dir'] },
    workDirBySession: { 'session-no-dir': null },
    staleWorkDirs: ['/repo/stale'],
  });

  const result = runDiffStatsSafetySweep(dependencies);

  assert.deepEqual(recomputed, []);
  assert.equal(result.inspected, 0);
});

test('idle sessions are out of scope: only live runtimes are swept', () => {
  // getActiveSessionIds is the sole source of sessions, so a stopped session's
  // workDir never reaches needsRefresh even when its cached stats are stale.
  const inspectedWorkDirs: string[] = [];
  const { dependencies } = createDependencies({
    connectedUserIds: ['user-a'],
    sessionsByUser: { 'user-a': [] },
    workDirBySession: { 'session-idle': '/repo/idle' },
    staleWorkDirs: ['/repo/idle'],
  });

  const result = runDiffStatsSafetySweep({
    ...dependencies,
    needsRefresh: (workDir) => {
      inspectedWorkDirs.push(workDir);
      return true;
    },
  });

  assert.deepEqual(inspectedWorkDirs, []);
  assert.equal(result.inspected, 0);
});
