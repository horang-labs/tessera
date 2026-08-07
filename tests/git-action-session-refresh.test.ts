/**
 * `docs/design/git-delivery.md` §11 — a Git action refreshes every session that
 * shares the working directory, the server triggers it, and nothing about it can
 * change what the action reported.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-action-refresh-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

/**
 * 'wsl' is the environment that reaches a plain local spawn on every non-Windows
 * platform; 'native' inside WSL means *Windows* binaries, which cannot see a
 * distro-local temp repo (tests/git-actions.test.ts:22).
 */
const USER_ID = 'git-refresh-user';
const TASK_ID = 'git-refresh-task';
const LEGACY_TASK_ID = 'git-refresh-legacy-task';
const SKIP_ON_WINDOWS = process.platform === 'win32';

const sharedRepo = path.join(dataDir, 'shared-repo');
const otherRepo = path.join(dataDir, 'other-repo');

let dbSessions: typeof import('../src/lib/db/sessions');
let subscribeGitPanelData:
  typeof import('../src/lib/git/git-panel-cache')['subscribeGitPanelData'];
let runSessionGitAction:
  typeof import('../src/lib/git/session-git-action')['runSessionGitAction'];

/** sessionIds the panel cache recomputed, in the order they landed. */
const recomputed: string[] = [];
let unsubscribe: (() => void) | null = null;

async function initRepo(repoDir: string): Promise<void> {
  fs.mkdirSync(repoDir, { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@tessera.local'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Tessera Test'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
  await execFileAsync('git', ['add', '.'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: repoDir });
}

test.before(async () => {
  if (SKIP_ON_WINDOWS) return;

  const database = await import('../src/lib/db/database');
  dbSessions = await import('../src/lib/db/sessions');
  ({ subscribeGitPanelData } = await import('../src/lib/git/git-panel-cache'));
  ({ runSessionGitAction } = await import('../src/lib/git/session-git-action'));
  const { persistCreatedSessionRecord } = await import('../src/lib/session/session-persistence');
  const { SettingsManager } = await import('../src/lib/settings/manager');
  const { invalidateAgentEnvironmentCache } = await import('../src/lib/cli/spawn-cli');

  await database.initDatabase();
  // ADR 0006: the setting is what decides where Git runs, so the fixture states
  // it rather than letting the resolver fall back to the platform default.
  const settings = await SettingsManager.load(USER_ID);
  await SettingsManager.save(USER_ID, { ...settings, agentEnvironment: 'wsl' });
  invalidateAgentEnvironmentCache(USER_ID);

  await initRepo(sharedRepo);
  await initRepo(otherRepo);

  // Three sessions on one working directory and one somewhere else. Sharing a
  // directory is the normal case in Tessera, so the fan-out has to reach the
  // bystander and stop at the archived session and the outsider.
  for (const [sessionId, workDir] of [
    ['acting-session', sharedRepo],
    ['bystander-session', sharedRepo],
    ['archived-session', sharedRepo],
    ['outsider-session', otherRepo],
  ] as const) {
    persistCreatedSessionRecord({
      sessionId,
      resolvedWorkDir: workDir,
      title: sessionId,
      providerId: 'claude-code',
    });
  }
  dbSessions.updateSession('archived-session', {
    archived: 1,
    archived_at: new Date().toISOString(),
  });

  // A session that reaches the shared checkout through its task rather than
  // through its own row. `getSessionWorktreeContext` resolves its working
  // directory from `tasks.worktree_path`, so it is on the same tree as the
  // acting session even with an empty `work_dir`.
  const dbTasks = await import('../src/lib/db/tasks');
  dbTasks.createTask({
    id: TASK_ID,
    projectId: persistCreatedSessionRecord({
      sessionId: 'task-bystander-session',
      resolvedWorkDir: sharedRepo,
      title: 'task bystander',
      providerId: 'claude-code',
    }).projectId,
    title: 'Shared checkout task',
    worktreeBranch: 'main',
    worktreePath: sharedRepo,
  });
  dbTasks.addSessionToTask(TASK_ID, 'task-bystander-session');
  dbSessions.updateSession('task-bystander-session', { work_dir: null });

  // The same shape one migration earlier: a task that has not stored its own
  // path yet, so the checkout is known only through its oldest child
  // (`LEGACY_WORKTREE_PATH_FROM_CHILD_SQL`). The childless sibling still
  // resolves onto the shared tree and still has a panel to update.
  dbTasks.createTask({
    id: LEGACY_TASK_ID,
    projectId: persistCreatedSessionRecord({
      sessionId: 'legacy-anchor-session',
      resolvedWorkDir: sharedRepo,
      title: 'legacy anchor',
      providerId: 'claude-code',
    }).projectId,
    title: 'Task with no stored worktree path',
    worktreeBranch: 'main',
  });
  dbTasks.addSessionToTask(LEGACY_TASK_ID, 'legacy-anchor-session');
  persistCreatedSessionRecord({
    sessionId: 'legacy-bystander-session',
    resolvedWorkDir: sharedRepo,
    title: 'legacy bystander',
    providerId: 'claude-code',
  });
  dbTasks.addSessionToTask(LEGACY_TASK_ID, 'legacy-bystander-session');
  dbSessions.updateSession('legacy-bystander-session', { work_dir: null });

  unsubscribe = subscribeGitPanelData((sessionId) => {
    recomputed.push(sessionId);
  });
});

test.after(() => {
  unsubscribe?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/**
 * The refresh is deliberately not awaited by the action, so the test waits on
 * the same signal the UI does: the panel-state broadcast.
 */
async function waitForRecompute(
  sessionIds: string[],
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sessionIds.every((id) => recomputed.includes(id))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `timed out waiting for ${sessionIds.join(', ')}; saw ${recomputed.join(', ') || '(nothing)'}`,
  );
}

/** Long enough for a stray recompute to have shown up if one was queued. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

test('a git action refreshes every active session sharing the working directory', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  fs.writeFileSync(path.join(sharedRepo, 'seed.txt'), 'changed by the acting session\n');
  recomputed.length = 0;

  const result = await runSessionGitAction('acting-session', USER_ID, {
    action: 'commit',
    message: 'commit from the acting session',
    files: ['seed.txt'],
  });

  assert.equal(result.ok, true);

  await waitForRecompute([
    'acting-session',
    'bystander-session',
    'task-bystander-session',
    'legacy-bystander-session',
  ]);
  await settle();

  // Archived sessions are on no screen, and the outsider's tree did not move.
  assert.equal(recomputed.includes('archived-session'), false);
  assert.equal(recomputed.includes('outsider-session'), false);
});

test('an action Git refused still refreshes, and reports the failure unchanged', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  // A pre-commit hook that says no: the command runs and fails, which is the
  // case where the tree can have moved even though the action did not land.
  const hookPath = path.join(sharedRepo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hookPath, 0o755);
  fs.writeFileSync(path.join(sharedRepo, 'seed.txt'), 'rejected by the hook\n');
  recomputed.length = 0;

  try {
    const result = await runSessionGitAction('acting-session', USER_ID, {
      action: 'commit',
      message: 'this one is refused',
      files: ['seed.txt'],
    });

    assert.equal(result.ok, false);
    await waitForRecompute(['acting-session', 'bystander-session']);
  } finally {
    fs.rmSync(hookPath, { force: true });
  }
});

test('an action that throws refreshes too', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  recomputed.length = 0;

  // A path outside the change set is rejected before Git runs, so the request
  // ends as an exception rather than a result. §11 asks for the refresh anyway:
  // whatever the working directory looks like now, the panels should show it.
  await assert.rejects(
    runSessionGitAction('acting-session', USER_ID, {
      action: 'commit',
      message: 'names a file that is not there',
      files: ['never-touched.txt'],
    }),
  );

  await waitForRecompute(['acting-session', 'bystander-session']);
});

test('the action answers without waiting for the refresh and carries no panel state', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  fs.writeFileSync(path.join(sharedRepo, 'seed.txt'), 'answered before the refresh\n');
  recomputed.length = 0;

  const result = await runSessionGitAction('acting-session', USER_ID, {
    action: 'commit',
    message: 'answers immediately',
    files: ['seed.txt'],
  });

  // §11: it is an invalidation and a broadcast, not a wait. The refresh has to
  // still be outstanding when the caller already has its answer.
  assert.deepEqual(recomputed, []);

  assert.equal(result.ok, true);
  // The response is the outcome of the action and nothing else — no refreshed
  // panel payload rides along on it.
  assert.deepEqual(
    Object.keys(result).sort(),
    ['ok', 'outcome'],
  );

  await waitForRecompute(['acting-session', 'bystander-session']);
});

test('a refresh that fails leaves the reported outcome alone', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  // A subscriber that throws stands in for anything downstream of the commit
  // going wrong. A display problem must never turn a landed commit into a
  // reported failure.
  const stopThrowing = subscribeGitPanelData(() => {
    throw new Error('broadcast exploded');
  });

  try {
    fs.writeFileSync(path.join(sharedRepo, 'seed.txt'), 'refresh will explode\n');
    recomputed.length = 0;

    const result = await runSessionGitAction('acting-session', USER_ID, {
      action: 'commit',
      message: 'lands despite the refresh',
      files: ['seed.txt'],
    });

    assert.equal(result.ok, true);
    // And the rest of the fan-out survives the throwing subscriber.
    await waitForRecompute(['acting-session', 'bystander-session']);
  } finally {
    stopThrowing();
  }
});
