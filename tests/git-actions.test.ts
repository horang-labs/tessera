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
  promoteHookRejection,
  resolveGitActionFilePath,
  type GitActionTarget,
} from '@/lib/git/git-actions';
import { GitCommandError } from '@/lib/worktrees/git-runner';
import type { AgentEnvironment } from '@/lib/settings/types';

const execFileAsync = promisify(execFile);

/**
 * 'wsl' is the environment that reaches a plain local `spawn` on every non-Windows
 * platform, including a server running inside WSL — 'native' there means *Windows*
 * binaries (spawn-cli-runtime.ts:175), which cannot see a distro-local temp repo.
 */
const LOCAL_ENVIRONMENT: AgentEnvironment = 'wsl';
const SKIP_ON_WINDOWS = process.platform === 'win32';

test('untracked revert resolves a CLI-reported path for the host filesystem', async () => {
  const reportedWorkDir = '/home/work/Source/tessera-dev';
  const expectedHostRoot = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\Source\\tessera-dev';
  const expectedHostPath = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\Source\\tessera-dev\\fresh.txt';
  const inputs: string[] = [];

  const resolved = await resolveGitActionFilePath(
    reportedWorkDir,
    'fresh.txt',
    async (candidate) => {
      inputs.push(candidate);
      return expectedHostRoot;
    },
  );

  assert.deepEqual(inputs, [reportedWorkDir]);
  assert.equal(resolved, expectedHostPath);
});

async function withTempRepo(
  run: (target: GitActionTarget, repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-actions-'));
  try {
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@tessera.local'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Tessera Test'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: repoDir });

    await run({ workDir: repoDir, agentEnvironment: LOCAL_ENVIRONMENT }, repoDir);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

async function statusOf(repoDir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoDir });
  return stdout;
}

async function filesInHead(repoDir: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['show', '--name-only', '--format=', 'HEAD'],
    { cwd: repoDir },
  );
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

test('committing a subset commits exactly those files and leaves the rest dirty', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    // One tracked modification, one untracked addition, one file left behind.
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');
    fs.writeFileSync(path.join(repoDir, 'added.txt'), 'brand new\n');
    fs.writeFileSync(path.join(repoDir, 'left-behind.txt'), 'not this time\n');

    const result = await executeGitAction(target, {
      action: 'commit',
      message: 'commit the selected two',
      files: ['seed.txt', 'added.txt'],
    });

    assert.equal(result.ok, true, 'expected the commit to succeed');
    if (!result.ok) return;
    assert.equal(result.outcome.action, 'commit');
    assert.match(result.outcome.sha, /^[0-9a-f]{40}$/);
    assert.equal(result.outcome.subject, 'commit the selected two');
    assert.equal(result.outcome.branch, 'main');
    assert.deepEqual(result.outcome.files, ['seed.txt', 'added.txt']);

    assert.deepEqual(await filesInHead(repoDir), ['added.txt', 'seed.txt']);
    // The deselected file survives as a working-tree change, uncommitted.
    assert.equal(await statusOf(repoDir), '?? left-behind.txt\n');
  });
});

test('a deletion and a rename in the selection are both recorded', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'doomed.txt'), 'delete me\n');
    fs.writeFileSync(path.join(repoDir, 'old-name.txt'), 'rename me\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'add the fixtures'], { cwd: repoDir });

    fs.rmSync(path.join(repoDir, 'doomed.txt'));
    await execFileAsync('git', ['mv', 'old-name.txt', 'new-name.txt'], { cwd: repoDir });

    const result = await executeGitAction(target, {
      action: 'commit',
      message: 'delete and rename',
      files: ['doomed.txt', 'new-name.txt'],
    });

    assert.equal(result.ok, true, 'expected the commit to succeed');
    // Both halves of the rename ride along, so the old path does not linger.
    const { stdout: nameStatus } = await execFileAsync(
      'git',
      ['show', '--name-status', '--format=', 'HEAD'],
      { cwd: repoDir },
    );
    assert.match(nameStatus, /^D\tdoomed\.txt$/m);
    assert.match(nameStatus, /^R\d+\told-name\.txt\tnew-name\.txt$/m);
    assert.equal(await statusOf(repoDir), '');
  });
});

test('an empty message is refused and nothing is committed', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');
    const headBefore = await filesInHead(repoDir);

    for (const message of ['', '   \n  ']) {
      const rejection = await executeGitAction(target, {
        action: 'commit',
        message,
        files: ['seed.txt'],
      }).then(() => null, (error: unknown) => error);

      assert.ok(
        rejection instanceof GitActionRejection,
        `expected a GitActionRejection for ${JSON.stringify(message)}`,
      );
      assert.equal(rejection.code, 'empty_message');
    }

    assert.deepEqual(await filesInHead(repoDir), headBefore);
    assert.equal(await statusOf(repoDir), ' M seed.txt\n');
  });
});

test('a path outside the current change set is refused', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');
    // Present in the repository, but not changed — so not selectable.
    fs.writeFileSync(path.join(repoDir, 'untouched.txt'), 'clean\n');
    await execFileAsync('git', ['add', 'untouched.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'add an untouched file'], { cwd: repoDir });
    const headBefore = await filesInHead(repoDir);

    for (const outsider of ['untouched.txt', '../escape.txt', 'never-existed.txt']) {
      const rejection = await executeGitAction(target, {
        action: 'commit',
        message: 'should not run',
        files: ['seed.txt', outsider],
      }).then(() => null, (error: unknown) => error);

      assert.ok(
        rejection instanceof GitActionRejection,
        `expected a GitActionRejection for ${outsider}`,
      );
      assert.equal(rejection.code, 'file_not_in_change_set');
    }

    // Rejected before `git add` ran, so the selected file is untouched too.
    assert.deepEqual(await filesInHead(repoDir), headBefore);
    assert.equal(await statusOf(repoDir), ' M seed.txt\n');
  });
});

test('an empty selection is refused', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target) => {
    const rejection = await executeGitAction(target, {
      action: 'commit',
      message: 'nothing selected',
      files: [],
    }).then(() => null, (error: unknown) => error);

    assert.ok(rejection instanceof GitActionRejection);
    assert.equal(rejection.code, 'no_files_selected');
  });
});

test('a hook that refuses without saying anything is still reported as a hook', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');
    // A hand-written hook need not print anything, and Git prints nothing of
    // its own for a rejected commit. Silence is the whole signal.
    installPreCommitHook(repoDir, '#!/bin/sh\nexit 1\n');

    const result = await executeGitAction(target, {
      action: 'commit',
      message: 'refused in silence',
      files: ['seed.txt'],
    });

    assert.equal(result.ok, false, 'expected the commit to fail');
    if (result.ok) return;
    assert.equal(result.failure.kind, 'hook_rejected');
    assert.deepEqual(
      result.failure.changedFiles.map((file) => file.path),
      ['seed.txt'],
    );
  });
});

test('a commit Git itself refuses is not dressed up as a hook rejection', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');
    // No hook here. Git fails on its own and says so in its own voice.
    await execFileAsync('git', ['config', 'commit.gpgsign', 'true'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.signingkey', 'no-such-key'], { cwd: repoDir });

    const result = await executeGitAction(target, {
      action: 'commit',
      message: 'git says no',
      files: ['seed.txt'],
    });

    assert.equal(result.ok, false, 'expected the commit to fail');
    if (result.ok) return;
    assert.equal(result.failure.kind, 'command_failed');
    assert.match(result.failure.stderr, /gpg/i);
  });
});

test('only a commit Git itself rejected can be promoted to a hook rejection', () => {
  const silentHook = new GitCommandError('command_failed', 'git exited with code 1', {
    exitCode: 1,
    stdout: '',
    stderr: '',
  });
  assert.equal(promoteHookRejection(silentHook), 'hook_rejected');

  // Killed from outside — by a supervisor, by the OOM killer. Git never
  // reported an exit code, so no hook can have run to completion either.
  assert.equal(
    promoteHookRejection(new GitCommandError('command_failed', 'terminated', {
      exitCode: null,
      stdout: '',
      stderr: '',
    })),
    'command_failed',
  );

  // Under a bridged agent environment the command goes through
  // `sh -c "cd -- '<path>' && exec git ..."`, so a wrapper that fails reports
  // sh's stderr and sh's exit code. `exec` passes Git's own code straight
  // through, which keeps a real hook rejection at 1.
  for (const [exitCode, stderr] of [
    [2, "sh: 1: cd: can't cd to /gone/worktree"],
    [127, 'sh: 1: exec: git: not found'],
  ] as const) {
    assert.equal(
      promoteHookRejection(new GitCommandError('command_failed', stderr, {
        exitCode,
        stdout: '',
        stderr,
      })),
      'command_failed',
      `exit ${exitCode} is the wrapper failing, not a hook`,
    );
  }
});

function installRejectingPreCommitHook(repoDir: string): void {
  installPreCommitHook(repoDir, '#!/bin/sh\necho "lint said no" >&2\nexit 1\n');
}

function installPreCommitHook(repoDir: string, script: string): void {
  const hookDir = path.join(repoDir, '.git', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'pre-commit');
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

test('a failing commit returns a structured failure and leaves the tree alone', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');
    const headBefore = await filesInHead(repoDir);

    installRejectingPreCommitHook(repoDir);

    const result = await executeGitAction(target, {
      action: 'commit',
      message: 'this one fails',
      files: ['seed.txt'],
    });

    assert.equal(result.ok, false, 'expected the commit to fail');
    if (result.ok) return;
    // The hook spoke and Git did not, so this is the user's code being refused
    // rather than the tool breaking (#230).
    assert.equal(result.failure.kind, 'hook_rejected');
    assert.equal(result.failure.exitCode, 1);
    assert.match(result.failure.stderr, /lint said no/);
    assert.match(result.failure.message, /lint said no/);
    // ADR 0005: the change set survives on the failure so a later recovery
    // has it without re-probing.
    assert.deepEqual(
      result.failure.changedFiles.map((file) => file.path),
      ['seed.txt'],
    );

    assert.deepEqual(await filesInHead(repoDir), headBefore);
    assert.equal(fs.readFileSync(path.join(repoDir, 'seed.txt'), 'utf8'), 'seed changed\n');
  });
});

test('a failing commit puts back the index entries it had to create', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    // An untracked file has to be staged before `git commit` can name it, so
    // this is the one case where a failed action could leave index residue —
    // and Tessera shows no staging UI that would reveal or undo it.
    fs.writeFileSync(path.join(repoDir, 'fresh.txt'), 'brand new\n');
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');
    const statusBefore = await statusOf(repoDir);

    installRejectingPreCommitHook(repoDir);

    const result = await executeGitAction(target, {
      action: 'commit',
      message: 'this one fails too',
      files: ['seed.txt', 'fresh.txt'],
    });

    assert.equal(result.ok, false, 'expected the commit to fail');
    assert.equal(await statusOf(repoDir), statusBefore);
    if (result.ok) return;
    // The change set on the failure reports the restored state, not the
    // momentarily staged one.
    assert.deepEqual(
      result.failure.changedFiles.map((file) => [file.path, file.state]),
      [
        ['seed.txt', 'modified'],
        ['fresh.txt', 'untracked'],
      ],
    );
  });
});

test('reverting a modified file restores it to HEAD', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');

    const result = await executeGitAction(target, {
      action: 'revert',
      files: ['seed.txt'],
    });

    assert.equal(result.ok, true, 'expected the revert to succeed');
    if (!result.ok) return;
    assert.equal(result.outcome.action, 'revert');
    assert.deepEqual(result.outcome.files, ['seed.txt']);
    // The working tree is back to the committed seed.
    assert.equal(fs.readFileSync(path.join(repoDir, 'seed.txt'), 'utf8'), 'seed\n');
    assert.equal(await statusOf(repoDir), '');
  });
});

test('reverting a deleted file restores the file from HEAD', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.rmSync(path.join(repoDir, 'seed.txt'));

    const result = await executeGitAction(target, {
      action: 'revert',
      files: ['seed.txt'],
    });

    assert.equal(result.ok, true, 'expected the revert to succeed');
    if (!result.ok) return;
    assert.equal(fs.readFileSync(path.join(repoDir, 'seed.txt'), 'utf8'), 'seed\n');
    assert.equal(await statusOf(repoDir), '');
  });
});

test('reverting untracked files deletes them outright', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'fresh.txt'), 'brand new\n');
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');

    const result = await executeGitAction(target, {
      action: 'revert',
      files: ['fresh.txt', 'seed.txt'],
    });

    assert.equal(result.ok, true, 'expected the revert to succeed');
    if (!result.ok) return;
    // The untracked file is gone; the modified file is restored.
    assert.equal(fs.existsSync(path.join(repoDir, 'fresh.txt')), false);
    assert.equal(fs.readFileSync(path.join(repoDir, 'seed.txt'), 'utf8'), 'seed\n');
    assert.equal(await statusOf(repoDir), '');
  });
});

test('reverting a file outside the change set is refused', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');
    const statusBefore = await statusOf(repoDir);

    const rejection = await executeGitAction(target, {
      action: 'revert',
      files: ['never-existed.txt'],
    }).then(() => null, (error: unknown) => error);

    assert.ok(rejection instanceof GitActionRejection);
    assert.equal(rejection.code, 'file_not_in_change_set');
    assert.equal(await statusOf(repoDir), statusBefore);
  });
});

test('reverting nothing is refused', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target) => {
    const rejection = await executeGitAction(target, {
      action: 'revert',
      files: [],
    }).then(() => null, (error: unknown) => error);

    assert.ok(rejection instanceof GitActionRejection);
    assert.equal(rejection.code, 'no_files_selected');
  });
});

test('reverting a conflicted or staged-only file is refused', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    // A change that exists only in the index (staged) has no working-tree
    // state to restore, so it is not revertible.
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'staged change\n');
    await execFileAsync('git', ['add', 'seed.txt'], { cwd: repoDir });
    const statusBefore = await statusOf(repoDir);

    const rejection = await executeGitAction(target, {
      action: 'revert',
      files: ['seed.txt'],
    }).then(() => null, (error: unknown) => error);

    assert.ok(rejection instanceof GitActionRejection);
    assert.equal(rejection.code, 'not_revertible');
    assert.equal(await statusOf(repoDir), statusBefore);
  });
});
