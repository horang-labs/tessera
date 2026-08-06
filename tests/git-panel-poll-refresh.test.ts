import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GIT_PANEL_POLL_INTERVAL_MS,
  startGitPanelPolling,
  type GitPanelPollTimers,
} from '@/lib/git/git-panel-poll';
import { readGitPanelState } from '@/lib/git/git-panel-read';
import {
  derivePrimaryGitAction,
  gitStateSnapshotFromPanel,
} from '@/lib/git/primary-git-action';
import type { GitPanelData } from '@/types/git';

function panelState(overrides: Partial<GitPanelData> = {}): GitPanelData {
  return {
    sessionId: 'session-1',
    workDir: '/repo',
    repoRoot: '/repo',
    repoName: 'repo',
    worktreeName: 'repo',
    worktreePath: '/repo',
    branch: 'main',
    detached: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    remoteUrl: 'git@github.com:acme/repo.git',
    hasRemote: true,
    repoUrl: 'https://github.com/acme/repo',
    defaultBranch: 'main',
    branches: ['main'],
    changedFiles: [],
    recentCommits: [],
    github: {
      available: true,
      reasonCode: null,
      reason: null,
      pullRequest: null,
    },
    ...overrides,
  };
}

/**
 * A clock the test moves by hand. The poller schedules its next tick from the
 * one that just finished, so a real timer would make "one poll interval" a
 * sleep, and the whole point of these tests is what a single cycle carries.
 */
function fakeClock() {
  let now = 0;
  let nextHandle = 1;
  const pending = new Map<number, { run: () => void; dueAt: number }>();

  const timers: GitPanelPollTimers = {
    setTimer: (run, delayMs) => {
      const handle = nextHandle++;
      pending.set(handle, { run, dueAt: now + delayMs });
      return handle;
    },
    clearTimer: (handle) => {
      pending.delete(handle as number);
    },
    now: () => now,
  };

  return {
    timers,
    pendingCount: () => pending.size,
    /** Fire everything due within `ms`, then let each tick's async work settle. */
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const [handle, timer] of [...pending]) {
        if (timer.dueAt > now) continue;
        pending.delete(handle);
        timer.run();
      }
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('the panel read asks the endpoint that carries the branch and ahead/behind', async () => {
  const requested: string[] = [];
  const state = panelState({ branch: 'feature/e2e-pr', ahead: 0, behind: 2 });

  const result = await readGitPanelState('session one', {
    fetchImpl: async (input) => {
      requested.push(String(input));
      return jsonResponse(200, state);
    },
  });

  assert.deepEqual(requested, ['/api/sessions/session%20one/git']);
  assert.equal(result.kind, 'loaded');
  assert.equal(result.kind === 'loaded' && result.data.branch, 'feature/e2e-pr');
  assert.equal(result.kind === 'loaded' && result.data.behind, 2);
});

test('a session the database has not caught up with is read as missing, not as a failure', async () => {
  const result = await readGitPanelState('temp-1', {
    fetchImpl: async () =>
      jsonResponse(404, {
        error: { code: 'session_not_found', message: 'Session not found' },
      }),
  });

  assert.equal(result.kind, 'session_missing');
});

test('a refused read carries what the route said', async () => {
  const result = await readGitPanelState('session-1', {
    fetchImpl: async () =>
      jsonResponse(422, {
        error: {
          code: 'not_git_repo',
          message: 'Working directory is not a git repository',
        },
      }),
  });

  assert.equal(result.kind, 'failed');
  assert.equal(
    result.kind === 'failed' && result.message,
    'Working directory is not a git repository',
  );
});

test('a read that never reached the server is a failure, not a crash', async () => {
  const result = await readGitPanelState('session-1', {
    fetchImpl: async () => {
      throw new Error('Failed to fetch');
    },
  });

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' && result.message, 'Failed to fetch');
});

test('a branch switched outside the panel arrives on the next poll', async () => {
  const clock = fakeClock();
  const applied: GitPanelData[] = [];
  const responses = [
    panelState({ branch: 'main' }),
    panelState({ branch: 'feature/e2e-pr' }),
  ];

  const stop = startGitPanelPolling({
    sessionId: 'session-1',
    apply: (data) => applied.push(data),
    isVisible: () => true,
    fetchImpl: async () => jsonResponse(200, responses.shift() ?? panelState()),
    timers: clock.timers,
  });

  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);
  assert.equal(applied.at(-1)?.branch, 'main');

  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);
  assert.equal(applied.at(-1)?.branch, 'feature/e2e-pr');

  stop();
});

test('a branch that fell behind reaches the Pull rung on the poll, without a remount', async () => {
  const clock = fakeClock();
  const applied: GitPanelData[] = [];
  const responses = [panelState({ behind: 0 }), panelState({ behind: 2 })];

  const stop = startGitPanelPolling({
    sessionId: 'session-1',
    apply: (data) => applied.push(data),
    isVisible: () => true,
    fetchImpl: async () => jsonResponse(200, responses.shift() ?? panelState()),
    timers: clock.timers,
  });

  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);
  const beforeFetch = derivePrimaryGitAction(
    gitStateSnapshotFromPanel(applied.at(-1) ?? null),
  );
  assert.notEqual(beforeFetch.kind, 'pull');

  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);
  const afterFetch = derivePrimaryGitAction(
    gitStateSnapshotFromPanel(applied.at(-1) ?? null),
  );
  assert.equal(afterFetch.kind, 'pull');
  assert.equal(afterFetch.enabled, true);
  assert.deepEqual(afterFetch.labelParams, { count: 2 });

  stop();
});

test('a hidden panel is not read, and resumes on the tick after it comes back', async () => {
  const clock = fakeClock();
  const applied: GitPanelData[] = [];
  let visible = false;
  let reads = 0;

  const stop = startGitPanelPolling({
    sessionId: 'session-1',
    apply: (data) => applied.push(data),
    isVisible: () => visible,
    fetchImpl: async () => {
      reads += 1;
      return jsonResponse(200, panelState({ branch: 'feature/e2e-pr' }));
    },
    timers: clock.timers,
  });

  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);
  assert.equal(reads, 0);
  assert.equal(applied.length, 0);

  visible = true;
  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);
  assert.equal(reads, 1);
  assert.equal(applied.at(-1)?.branch, 'feature/e2e-pr');

  stop();
});

test('a failed poll leaves the panel showing what it already had', async () => {
  const clock = fakeClock();
  const applied: GitPanelData[] = [];
  const responses: Array<() => Response> = [
    () => jsonResponse(200, panelState({ branch: 'main' })),
    () => jsonResponse(500, { error: { code: 'internal_error' } }),
    () => jsonResponse(200, panelState({ branch: 'feature/e2e-pr' })),
  ];

  const stop = startGitPanelPolling({
    sessionId: 'session-1',
    apply: (data) => applied.push(data),
    isVisible: () => true,
    fetchImpl: async () => (responses.shift() ?? (() => jsonResponse(200, panelState())))(),
    timers: clock.timers,
  });

  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);
  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);
  assert.equal(applied.length, 1);
  assert.equal(applied.at(-1)?.branch, 'main');

  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);
  assert.equal(applied.at(-1)?.branch, 'feature/e2e-pr');

  stop();
});

test('stopping the poll cancels the next tick and drops a read still in flight', async () => {
  const clock = fakeClock();
  const applied: GitPanelData[] = [];
  let release: ((response: Response) => void) | null = null;

  const stop = startGitPanelPolling({
    sessionId: 'session-1',
    apply: (data) => applied.push(data),
    isVisible: () => true,
    fetchImpl: () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    timers: clock.timers,
  });

  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);
  assert.ok(release, 'the tick should have started a read');

  stop();
  release!(jsonResponse(200, panelState({ branch: 'feature/e2e-pr' })));
  await clock.advance(GIT_PANEL_POLL_INTERVAL_MS);

  assert.deepEqual(applied, []);
  assert.equal(clock.pendingCount(), 0);
});
