import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  executeGitAction,
  GitActionRejection,
  type GitActionTarget,
} from '@/lib/git/git-actions';
import type { AgentEnvironment } from '@/lib/settings/types';

const execFileAsync = promisify(execFile);

/**
 * 'wsl' is the environment that reaches a plain local `spawn` on every non-Windows
 * platform, including a server running inside WSL — 'native' there means *Windows*
 * binaries (spawn-cli-runtime.ts:175), which cannot see a distro-local temp repo.
 */
const LOCAL_ENVIRONMENT: AgentEnvironment = 'wsl';
const SKIP_ON_WINDOWS = process.platform === 'win32';

interface PushFixture {
  target: GitActionTarget;
  repoDir: string;
  remoteDir: string;
}

/**
 * A repository with one commit and a bare remote on disk. The remote is a real
 * one so a push is a real push — the upstream Git writes afterwards is the thing
 * under test, and a fake would be the code's own answer read back.
 */
async function withPushableRepo(
  run: (fixture: PushFixture) => Promise<void>,
  options: { addRemote?: boolean } = {},
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-push-'));
  const repoDir = path.join(root, 'work');
  const remoteDir = path.join(root, 'remote.git');

  try {
    fs.mkdirSync(repoDir);
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@tessera.local'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Tessera Test'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
    if (options.addRemote !== false) {
      await execFileAsync('git', ['remote', 'add', 'origin', remoteDir], { cwd: repoDir });
    }
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: repoDir });

    await run({
      target: { workDir: repoDir, agentEnvironment: LOCAL_ENVIRONMENT },
      repoDir,
      remoteDir,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function remoteBranches(remoteDir: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { cwd: remoteDir },
  );
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

test('a branch that already tracks is pushed without claiming it set an upstream', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withPushableRepo(async ({ target, remoteDir, repoDir }) => {
    await execFileAsync('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');
    await execFileAsync('git', ['commit', '--all', '-m', 'the commit to push'], { cwd: repoDir });

    const result = await executeGitAction(target, { action: 'push' });

    assert.equal(result.ok, true, 'expected the push to succeed');
    if (!result.ok) return;
    assert.equal(result.outcome.setUpstream, false);
    assert.equal(result.outcome.remoteBranch, 'origin/main');

    const { stdout: remoteSubject } = await execFileAsync(
      'git',
      ['log', '-1', '--format=%s', 'main'],
      { cwd: remoteDir },
    );
    assert.equal(remoteSubject.trim(), 'the commit to push');
  });
});

test('a rejected push comes back as a failure value with Git speaking', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withPushableRepo(async ({ target, remoteDir, repoDir }) => {
    await execFileAsync('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: repoDir });
    // The remote moves on without us, so our push is behind and refused.
    const clone = path.join(path.dirname(repoDir), 'other');
    await execFileAsync('git', ['clone', remoteDir, clone]);
    await execFileAsync('git', ['config', 'user.email', 'other@tessera.local'], { cwd: clone });
    await execFileAsync('git', ['config', 'user.name', 'Other'], { cwd: clone });
    fs.writeFileSync(path.join(clone, 'theirs.txt'), 'theirs\n');
    await execFileAsync('git', ['add', '.'], { cwd: clone });
    await execFileAsync('git', ['commit', '-m', 'their commit'], { cwd: clone });
    await execFileAsync('git', ['push'], { cwd: clone });

    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'diverged\n');
    await execFileAsync('git', ['commit', '--all', '-m', 'our commit'], { cwd: repoDir });

    const result = await executeGitAction(target, { action: 'push' });

    assert.equal(result.ok, false, 'expected the push to be rejected');
    if (result.ok) return;
    // ADR 0005: the classified kind, the raw stderr and the exit code survive.
    assert.equal(result.failure.kind, 'command_failed');
    assert.match(result.failure.stderr, /rejected|non-fast-forward/i);
    assert.equal(result.failure.exitCode, 1);
  });
});

test('a repository with no remote refuses the push before running one', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withPushableRepo(
    async ({ target }) => {
      await assert.rejects(
        () => executeGitAction(target, { action: 'push' }),
        (error: unknown) =>
          error instanceof GitActionRejection && error.code === 'no_remote',
      );
    },
    { addRemote: false },
  );
});

test('a detached HEAD is refused rather than pushed to whatever it resolves to', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withPushableRepo(async ({ target, repoDir }) => {
    await execFileAsync('git', ['checkout', '--detach'], { cwd: repoDir });

    await assert.rejects(
      () => executeGitAction(target, { action: 'push' }),
      (error: unknown) =>
        error instanceof GitActionRejection && error.code === 'detached_head',
    );
  });
});

test('publishing a branch creates the remote branch and reports which one', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withPushableRepo(async ({ target, remoteDir, repoDir }) => {
    const result = await executeGitAction(target, { action: 'push' });

    assert.equal(result.ok, true, 'expected the push to succeed');
    if (!result.ok) return;
    assert.equal(result.outcome.action, 'push');
    assert.equal(result.outcome.branch, 'main');
    // A first push is explained after the fact as well as before it (§7).
    assert.equal(result.outcome.setUpstream, true);
    assert.equal(result.outcome.remoteBranch, 'origin/main');

    assert.deepEqual(await remoteBranches(remoteDir), ['main']);
    const { stdout: upstream } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { cwd: repoDir },
    );
    assert.equal(upstream.trim(), 'origin/main');
  });
});
