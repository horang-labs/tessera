import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GIT_REMOTE_REFRESH_INTERVAL_MS,
  scheduleGitRemoteRefresh,
  type GitRemoteRefreshDeps,
} from '@/lib/git/git-remote-refresh';

/**
 * The rate limit is held per working directory in module state, so each test
 * gets a working directory of its own rather than a reset hook the product
 * would never call.
 */
let nextWorkDir = 0;
function freshWorkDir(): string {
  nextWorkDir += 1;
  return `/repo/${nextWorkDir}`;
}

interface Harness {
  deps: GitRemoteRefreshDeps;
  fetched: string[];
  recomputed: Array<{ sessionId: string; userId: string }>;
  setNow: (value: number) => void;
}

function harness(
  options: {
    runFetch?: (workDir: string, userId: string) => Promise<void>;
    /** Which Git directory each working directory's refs live in. */
    refsIn?: Record<string, string>;
  } = {},
): Harness {
  let now = 1_000_000;
  const fetched: string[] = [];
  const recomputed: Array<{ sessionId: string; userId: string }> = [];

  return {
    fetched,
    recomputed,
    setNow: (value) => {
      now = value;
    },
    deps: {
      now: () => now,
      resolveRefsKey: async (workDir) => options.refsIn?.[workDir] ?? workDir,
      runFetch: async (workDir, userId) => {
        fetched.push(workDir);
        if (options.runFetch) await options.runFetch(workDir, userId);
      },
      onFetched: (sessionId, userId) => {
        recomputed.push({ sessionId, userId });
      },
    },
  };
}

test('the first panel read on a working directory refreshes the remote refs', async () => {
  const workDir = freshWorkDir();
  const h = harness();

  await scheduleGitRemoteRefresh(
    { sessionId: 'session-1', workDir, userId: 'user-1' },
    h.deps,
  );

  assert.deepEqual(h.fetched, [workDir]);
});

test('reads inside the interval do not fetch again', async () => {
  const workDir = freshWorkDir();
  const h = harness();
  const request = { sessionId: 'session-1', workDir, userId: 'user-1' };

  await scheduleGitRemoteRefresh(request, h.deps);
  h.setNow(1_000_000 + GIT_REMOTE_REFRESH_INTERVAL_MS - 1);
  await scheduleGitRemoteRefresh(request, h.deps);

  assert.deepEqual(h.fetched, [workDir]);
});

test('the remote is refreshed again once the interval has passed', async () => {
  const workDir = freshWorkDir();
  const h = harness();
  const request = { sessionId: 'session-1', workDir, userId: 'user-1' };

  await scheduleGitRemoteRefresh(request, h.deps);
  h.setNow(1_000_000 + GIT_REMOTE_REFRESH_INTERVAL_MS);
  await scheduleGitRemoteRefresh(request, h.deps);

  assert.deepEqual(h.fetched, [workDir, workDir]);
});

test('sessions sharing a working directory fetch once between them', async () => {
  const workDir = freshWorkDir();
  const h = harness();

  await scheduleGitRemoteRefresh(
    { sessionId: 'session-1', workDir, userId: 'user-1' },
    h.deps,
  );
  await scheduleGitRemoteRefresh(
    { sessionId: 'session-2', workDir, userId: 'user-2' },
    h.deps,
  );

  assert.deepEqual(h.fetched, [workDir]);
});

test('reads that arrive together start one fetch, not two', async () => {
  // Two panels on the same checkout poll on their own clocks and do overlap.
  // Neither has resolved which refs it is asking about yet, so the guard has to
  // hold across that resolution, not just across the fetch.
  const workDir = freshWorkDir();
  let release: (() => void) | null = null;
  const h = harness({
    runFetch: () => new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  const request = { sessionId: 'session-1', workDir, userId: 'user-1' };

  const first = scheduleGitRemoteRefresh(request, h.deps);
  const second = scheduleGitRemoteRefresh(
    { ...request, sessionId: 'session-2' },
    h.deps,
  );
  while (release === null) await new Promise((resolve) => setImmediate(resolve));

  release();
  await Promise.all([first, second]);
  assert.deepEqual(h.fetched, [workDir]);
  // One fetch, one recompute — the second caller rides the first's attempt.
  assert.deepEqual(h.recomputed, [{ sessionId: 'session-1', userId: 'user-1' }]);
});

test('a remote that cannot be reached still holds the interval', async () => {
  const workDir = freshWorkDir();
  const h = harness({
    runFetch: async () => {
      throw new Error('Could not read from remote repository');
    },
  });
  const request = { sessionId: 'session-1', workDir, userId: 'user-1' };

  await scheduleGitRemoteRefresh(request, h.deps);
  h.setNow(1_000_000 + GIT_REMOTE_REFRESH_INTERVAL_MS - 1);
  await scheduleGitRemoteRefresh(request, h.deps);

  assert.deepEqual(h.fetched, [workDir]);
  assert.deepEqual(h.recomputed, []);
});

test('a fetch that landed recomputes the panel, so the new counts reach the client', async () => {
  const workDir = freshWorkDir();
  const h = harness();

  await scheduleGitRemoteRefresh(
    { sessionId: 'session-1', workDir, userId: 'user-1' },
    h.deps,
  );

  assert.deepEqual(h.recomputed, [{ sessionId: 'session-1', userId: 'user-1' }]);
});

test('two worktrees of one repository fetch once between them', async () => {
  // A managed worktree shares its repository's `refs/remotes/*`, so one fetch
  // moves the refs both panels read. Tessera's normal shape is many worktrees
  // per repository, which is exactly where fetching per working directory would
  // multiply.
  const first = freshWorkDir();
  const second = freshWorkDir();
  const gitCommonDir = `${first}/.git`;
  const h = harness({ refsIn: { [first]: gitCommonDir, [second]: gitCommonDir } });

  await scheduleGitRemoteRefresh(
    { sessionId: 'session-1', workDir: first, userId: 'user-1' },
    h.deps,
  );
  await scheduleGitRemoteRefresh(
    { sessionId: 'session-2', workDir: second, userId: 'user-1' },
    h.deps,
  );

  assert.deepEqual(h.fetched, [first]);
});

test('separate clones of the same upstream each keep their own refs warm', async () => {
  const first = freshWorkDir();
  const second = freshWorkDir();
  const h = harness({
    refsIn: { [first]: `${first}/.git`, [second]: `${second}/.git` },
  });

  await scheduleGitRemoteRefresh(
    { sessionId: 'session-1', workDir: first, userId: 'user-1' },
    h.deps,
  );
  await scheduleGitRemoteRefresh(
    { sessionId: 'session-2', workDir: second, userId: 'user-1' },
    h.deps,
  );

  assert.deepEqual(h.fetched, [first, second]);
});
