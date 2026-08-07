import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  buildGitBatchScript,
  getGitPanelBatchCommands,
  getGitPanelSnapshot,
  resolveUpstreamState,
} from '@/lib/git/git-panel';
import { executeGitAction, runPush } from '@/lib/git/git-actions';
import type { GitRunner } from '@/lib/worktrees/git-runner';
import { resolveConfiguredUpstream } from '@/lib/git/upstream-config';
import { derivePrimaryGitAction } from '@/lib/git/primary-git-action';
import { deriveGitActionMenu } from '@/lib/git/git-action-menu';
import type { GitStateSnapshot } from '@/lib/git/primary-git-action';
import { createGitShellRunner } from '@/lib/worktrees/git-runner';
import type { AgentEnvironment } from '@/lib/settings/types';

const execFileAsync = promisify(execFile);

/** As in `git-push-action.test.ts`: the environment that spawns Git locally. */
const LOCAL_ENVIRONMENT: AgentEnvironment = 'wsl';
const SKIP_ON_WINDOWS = process.platform === 'win32';

const BRANCH = 'feature/0803-kq';

interface NarrowFixture {
  /** The clone whose fetch refspec covers `main` and nothing else. */
  cloneDir: string;
  remoteDir: string;
}

/**
 * A clone whose `remote.origin.fetch` was narrowed after the fact, checked out
 * on a branch that exists on the remote and has no remote-tracking ref.
 *
 * This is the shape every existing Git test misses. They all clone with the
 * default `+refs/heads/*:refs/remotes/origin/*`, under which `@{upstream}`
 * always answers — which is precisely why a panel that depends on `@{upstream}`
 * passed its whole suite and then showed Publish Branch forever.
 */
async function withNarrowRefspecClone(
  run: (fixture: NarrowFixture) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-narrow-'));
  const remoteDir = path.join(root, 'remote.git');
  const seedDir = path.join(root, 'seed');
  const cloneDir = path.join(root, 'clone');
  const git = (args: string[], cwd: string) => execFileAsync('git', args, { cwd });

  try {
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
    await execFileAsync('git', ['init', '--initial-branch=main', seedDir]);
    await git(['config', 'user.email', 'test@tessera.local'], seedDir);
    await git(['config', 'user.name', 'Tessera Test'], seedDir);
    await git(['config', 'commit.gpgsign', 'false'], seedDir);
    await git(['remote', 'add', 'origin', remoteDir], seedDir);
    fs.writeFileSync(path.join(seedDir, 'seed.txt'), 'seed\n');
    await git(['add', '.'], seedDir);
    await git(['commit', '-m', 'seed'], seedDir);
    await git(['push', 'origin', 'main'], seedDir);
    await git(['checkout', '-b', BRANCH], seedDir);
    fs.writeFileSync(path.join(seedDir, 'feature.txt'), 'feature\n');
    await git(['add', '.'], seedDir);
    await git(['commit', '-m', 'the published commit'], seedDir);
    await git(['push', 'origin', BRANCH], seedDir);

    await execFileAsync('git', ['clone', remoteDir, cloneDir]);
    await git(['config', 'user.email', 'test@tessera.local'], cloneDir);
    await git(['config', 'user.name', 'Tessera Test'], cloneDir);
    await git(['config', 'commit.gpgsign', 'false'], cloneDir);
    // The narrowing itself. Nothing in Tessera writes this; it is how the
    // affected clone was configured, and the panel has to survive it.
    await git(['config', '--unset-all', 'remote.origin.fetch'], cloneDir);
    await git(
      ['config', '--add', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main'],
      cloneDir,
    );
    await git(['fetch', '--prune', 'origin'], cloneDir);
    // The branch arrives through `FETCH_HEAD`, which the refspec does not map,
    // so it lands with tracking config and no `refs/remotes` ref behind it.
    await git(['fetch', 'origin', BRANCH], cloneDir);
    await git(['branch', BRANCH, 'FETCH_HEAD'], cloneDir);
    await git(['config', `branch.${BRANCH}.remote`, 'origin'], cloneDir);
    await git(['config', `branch.${BRANCH}.merge`, `refs/heads/${BRANCH}`], cloneDir);
    await git(['checkout', BRANCH], cloneDir);
    await execFileAsync(
      'git',
      ['update-ref', '-d', `refs/remotes/origin/${BRANCH}`],
      { cwd: cloneDir },
    ).catch(() => undefined);

    await run({ cloneDir, remoteDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The bug's precondition, asserted rather than assumed. */
async function assertUpstreamUnresolvable(cloneDir: string): Promise<void> {
  await assert.rejects(
    () =>
      execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        { cwd: cloneDir },
      ),
    /not stored as a remote-tracking branch/,
    'the fixture must reproduce the refspec that breaks @{upstream}',
  );
}

test('a branch the fetch refspec does not map still reports the upstream it has', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withNarrowRefspecClone(async ({ cloneDir }) => {
    await assertUpstreamUnresolvable(cloneDir);

    const snapshot = await getGitPanelSnapshot(cloneDir, LOCAL_ENVIRONMENT);
    assert.equal(snapshot.upstream, null, '@{upstream} answers nothing here');

    const state = await resolveUpstreamState(cloneDir, LOCAL_ENVIRONMENT, snapshot);
    assert.equal(state.upstream, `origin/${BRANCH}`);
    // No remote-tracking ref means no local comparison, and zero would be a
    // claim that the branch is in sync.
    assert.equal(state.ahead, null);
    assert.equal(state.behind, null);
  });
});

test('the counts come back once the remote-tracking ref the failure asks for exists', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withNarrowRefspecClone(async ({ cloneDir }) => {
    // Exactly the command `describeMissingTrackingRef` prints. It has to be the
    // fix, not just advice.
    await execFileAsync(
      'git',
      ['fetch', 'origin', `${BRANCH}:refs/remotes/origin/${BRANCH}`],
      { cwd: cloneDir },
    );
    // Still refused: Git resolves `@{upstream}` through the refspec, not through
    // the ref, so the fallback is what answers even now.
    await assertUpstreamUnresolvable(cloneDir);

    fs.writeFileSync(path.join(cloneDir, 'local.txt'), 'local\n');
    await execFileAsync('git', ['add', '.'], { cwd: cloneDir });
    await execFileAsync('git', ['commit', '-m', 'unpushed'], { cwd: cloneDir });

    const snapshot = await getGitPanelSnapshot(cloneDir, LOCAL_ENVIRONMENT);
    const state = await resolveUpstreamState(cloneDir, LOCAL_ENVIRONMENT, snapshot);

    assert.equal(state.upstream, `origin/${BRANCH}`);
    assert.equal(state.ahead, 1);
    assert.equal(state.behind, 0);
  });
});

test('an ordinary clone is unaffected: @{upstream} answers and the counts are real', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-wide-'));
  try {
    const remoteDir = path.join(root, 'remote.git');
    const repoDir = path.join(root, 'work');
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
    await execFileAsync('git', ['init', '--initial-branch=main', repoDir]);
    const git = (args: string[]) => execFileAsync('git', args, { cwd: repoDir });
    await git(['config', 'user.email', 'test@tessera.local']);
    await git(['config', 'user.name', 'Tessera Test']);
    await git(['config', 'commit.gpgsign', 'false']);
    await git(['remote', 'add', 'origin', remoteDir]);
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'seed']);
    await git(['push', '--set-upstream', 'origin', 'main']);
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'more\n');
    await git(['commit', '--all', '-m', 'ahead by one']);

    const snapshot = await getGitPanelSnapshot(repoDir, LOCAL_ENVIRONMENT);
    const state = await resolveUpstreamState(repoDir, LOCAL_ENVIRONMENT, snapshot);

    assert.equal(snapshot.upstream, 'origin/main');
    assert.equal(state.upstream, 'origin/main');
    assert.equal(state.ahead, 1);
    assert.equal(state.behind, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the batched command set reads the same tracking config as the plain one', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withNarrowRefspecClone(async ({ cloneDir }) => {
    // The bridged path builds its commands once and runs them behind one shell,
    // so a read added to only one of the two paths is a bug that shows up on
    // Windows alone. Run the real command set here.
    const { stdout } = await createGitShellRunner(LOCAL_ENVIRONMENT, { timeoutMs: 20_000 })(
      buildGitBatchScript(getGitPanelBatchCommands()),
      { cwd: cloneDir },
    );

    const decoded = new Map(
      stdout.trimEnd().split('\n').map((line) => {
        const [key, encodedField = ''] = line.split('\t');
        return [key, Buffer.from(encodedField.slice(4), 'base64').toString('utf8')] as const;
      }),
    );

    assert.equal(decoded.get('upstream')?.trim(), '', '@{upstream} answers nothing here');
    const configured = resolveConfiguredUpstream(
      decoded.get('upstreamConfig') ?? null,
      decoded.get('branch')?.trim() ?? null,
    );
    assert.equal(configured?.name, `origin/${BRANCH}`);
    assert.equal(configured?.trackingRef, `refs/remotes/origin/${BRANCH}`);
  });
});

test('a dotted, slashed branch name is not mis-split by the config parser', () => {
  // `--get-regexp` prints every branch, and `feature/0803-kq` carries a dot in
  // the middle of it — splitting on dots would hand back the wrong key.
  const raw = [
    'branch.main.remote origin',
    'branch.main.merge refs/heads/main',
    'branch.feature/0803-kq.remote origin',
    'branch.feature/0803-kq.merge refs/heads/feature/0803-kq',
    'branch.release/v1.2.3.remote upstream',
    'branch.release/v1.2.3.merge refs/heads/release/v1.2.3',
  ].join('\n');

  assert.equal(resolveConfiguredUpstream(raw, 'feature/0803-kq')?.name, 'origin/feature/0803-kq');
  assert.equal(resolveConfiguredUpstream(raw, 'release/v1.2.3')?.name, 'upstream/release/v1.2.3');
  assert.equal(
    resolveConfiguredUpstream(raw, 'release/v1.2.3')?.trackingRef,
    'refs/remotes/upstream/release/v1.2.3',
  );
  assert.equal(resolveConfiguredUpstream(raw, 'nothing-here'), null);
});

test('an incomplete or unusable tracking config tracks nothing', () => {
  // Git's own rule: the pair, or no upstream.
  assert.equal(resolveConfiguredUpstream('branch.main.remote origin', 'main'), null);
  assert.equal(resolveConfiguredUpstream('branch.main.merge refs/heads/main', 'main'), null);
  assert.equal(resolveConfiguredUpstream(null, 'main'), null);
  assert.equal(resolveConfiguredUpstream('branch.main.remote origin', null), null);
  // A URL in place of a remote name names no `refs/remotes/…` to compare with.
  assert.equal(
    resolveConfiguredUpstream(
      'branch.main.remote https://example.com/repo.git\nbranch.main.merge refs/heads/main',
      'main',
    ),
    null,
  );
  // `.` is Git's own spelling of a branch tracking another local branch, and it
  // prints without a remote in front of it.
  const local = resolveConfiguredUpstream(
    'branch.topic.remote .\nbranch.topic.merge refs/heads/main',
    'topic',
  );
  assert.equal(local?.name, 'main');
  assert.equal(local?.trackingRef, 'refs/heads/main');
});

test('pushing such a branch pushes, and does not claim it set an upstream', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withNarrowRefspecClone(async ({ cloneDir, remoteDir }) => {
    fs.writeFileSync(path.join(cloneDir, 'local.txt'), 'local\n');
    await execFileAsync('git', ['add', '.'], { cwd: cloneDir });
    await execFileAsync('git', ['commit', '-m', 'the commit to push'], { cwd: cloneDir });

    const result = await executeGitAction(
      { workDir: cloneDir, agentEnvironment: LOCAL_ENVIRONMENT },
      { action: 'push' },
    );

    assert.equal(result.ok, true, 'expected the push to succeed');
    if (!result.ok || result.outcome.action !== 'push') return;
    // Before the fix this ran `push --set-upstream` on a branch that already
    // tracked, then reported `setUpstream: true` with a null `remoteBranch`.
    assert.equal(result.outcome.setUpstream, false);
    assert.equal(result.outcome.remoteBranch, `origin/${BRANCH}`);

    const { stdout: remoteSubject } = await execFileAsync(
      'git',
      ['log', '-1', '--format=%s', BRANCH],
      { cwd: remoteDir },
    );
    assert.equal(remoteSubject.trim(), 'the commit to push');
  });
});

/**
 * A runner that answers as a repository would if `--set-upstream` left no
 * upstream behind: the push exits zero and every way of reading a tracking
 * branch afterwards comes back empty. No real repository can be asked for that
 * state on demand — Git writes the config whenever the push succeeds — which is
 * why the runner is supplied here.
 */
function runnerWithNoUpstreamAfterPush(pushed: string[][]): GitRunner {
  return async (args) => {
    const ok = (stdout: string) => ({
      stdout, stderr: '', exitCode: 0, truncated: false, stoppedEarly: false,
    });
    if (args[0] === 'branch' && args[1] === '--show-current') return ok(BRANCH);
    if (args[0] === 'remote') return ok('origin\n');
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok('/repo');
    if (args[0] === 'rev-parse') throw new Error('no upstream');
    if (args[0] === 'config') return ok('');
    if (args[0] === 'status') return ok('');
    if (args[0] === 'push') {
      pushed.push(args);
      return ok('');
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

test('a push that leaves the branch tracking nothing is a failure, not a success', async () => {
  const pushed: string[][] = [];
  const result = await runPush(
    { workDir: '/repo', agentEnvironment: LOCAL_ENVIRONMENT },
    runnerWithNoUpstreamAfterPush(pushed),
  );

  assert.deepEqual(pushed, [['push', '--set-upstream', 'origin', BRANCH]]);
  assert.equal(result.ok, false, 'a push that changed nothing readable is not a success');
  if (result.ok) return;
  assert.equal(result.failure.kind, 'no_tracking_ref');
  // The banner falls back to the message verbatim, so the message has to carry
  // both the cause and the command that repairs it.
  assert.match(result.failure.message, /fetch refspec/);
  assert.match(
    result.failure.message,
    new RegExp(`git -C /repo fetch origin ${BRANCH}:refs/remotes/origin/${BRANCH}`),
  );
});

const TRACKING_UNCOUNTABLE: GitStateSnapshot = {
  branch: BRANCH,
  upstream: `origin/${BRANCH}`,
  ahead: null,
  behind: null,
  changedFileCount: 0,
  hasRemote: true,
  pullRequest: 'none',
  defaultBranch: 'main',
  conflictOperation: null,
};

test('an uncounted tracking branch is offered a push, not Publish Branch', () => {
  const action = derivePrimaryGitAction(TRACKING_UNCOUNTABLE);

  assert.equal(action.kind, 'push');
  assert.equal(action.enabled, true);
  // The whole bug: a published branch under a button that publishes it.
  assert.notEqual(action.kind, 'publish');
  assert.equal(action.disabledReasonKey, null);
});

test('the menu never claims there is nothing to push or pull without counting', () => {
  const menu = deriveGitActionMenu(TRACKING_UNCOUNTABLE);
  const push = menu.find((entry) => entry.id === 'push');
  const pull = menu.find((entry) => entry.id === 'pull');

  assert.equal(push?.enabled, true);
  assert.equal(push?.labelParams, undefined, 'there is no count to name');
  assert.notEqual(push?.disabledReasonKey, 'gitPanel.push.nothingToPush');
  assert.equal(pull?.enabled, true);
  assert.notEqual(pull?.disabledReasonKey, 'gitPanel.pull.nothingToPull');
});

test('a branch known to be in sync still says so', () => {
  const synced: GitStateSnapshot = { ...TRACKING_UNCOUNTABLE, ahead: 0, behind: 0 };
  const push = deriveGitActionMenu(synced).find((entry) => entry.id === 'push');

  assert.equal(push?.enabled, false);
  assert.equal(push?.disabledReasonKey, 'gitPanel.push.nothingToPush');
  // Zero is still a real answer, and the ladder moves on to the pull request.
  assert.equal(derivePrimaryGitAction(synced).kind, 'create_pr');
});
