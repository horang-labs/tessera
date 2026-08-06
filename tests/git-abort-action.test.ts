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

interface ConflictFixture {
  target: GitActionTarget;
  repoDir: string;
  /** What `file.txt` said, and what the branch pointed at, before the operation. */
  before: { contents: string; head: string; branch: string };
}

async function configureIdentity(cwd: string): Promise<void> {
  await execFileAsync('git', ['config', 'user.email', 'tessera@tessera.local'], { cwd });
  await execFileAsync('git', ['config', 'user.name', 'Tessera'], { cwd });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd });
}

async function readHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

async function readBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd });
  return stdout.trim();
}

/**
 * A repository with two branches that disagree about one line, stopped in the
 * middle of `operation` when it tries to reconcile them. A real conflict rather
 * than a stubbed runner: what is under test is that the right `--abort` runs and
 * that the worktree actually comes back, and neither is observable from a fake.
 */
async function withConflictedRepo(
  operation: 'merge' | 'rebase' | 'cherry-pick',
  run: (fixture: ConflictFixture) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-abort-'));
  const repoDir = path.join(root, 'work');

  try {
    await execFileAsync('git', ['init', '--initial-branch=main', repoDir]);
    await configureIdentity(repoDir);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'base\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repoDir });

    await execFileAsync('git', ['checkout', '-b', 'other'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'other\n');
    await execFileAsync('git', ['commit', '-am', 'other'], { cwd: repoDir });

    await execFileAsync('git', ['checkout', 'main'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'main\n');
    await execFileAsync('git', ['commit', '-am', 'main'], { cwd: repoDir });

    const before = {
      contents: fs.readFileSync(path.join(repoDir, 'file.txt'), 'utf8'),
      head: await readHead(repoDir),
      branch: await readBranch(repoDir),
    };
    // Non-zero is the point: this is the command stopping on the conflict.
    await execFileAsync('git', [operation, 'other'], { cwd: repoDir }).catch(() => null);

    await run({
      target: { workDir: repoDir, agentEnvironment: LOCAL_ENVIRONMENT },
      repoDir,
      before,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('aborting a merge puts the worktree back where it was', { skip: SKIP_ON_WINDOWS }, async () => {
  await withConflictedRepo('merge', async ({ target, repoDir, before }) => {
    const result = await executeGitAction(target, { action: 'abort' });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome.action, 'abort');
    assert.equal(result.ok && result.outcome.action === 'abort' && result.outcome.operation, 'merge');
    // The pre-operation state, read out of the repository rather than off the
    // result: what §9 promises is a way out, and only the worktree can say
    // whether the user got one.
    assert.equal(fs.readFileSync(path.join(repoDir, 'file.txt'), 'utf8'), before.contents);
    assert.equal(await readHead(repoDir), before.head);
    assert.equal(await readBranch(repoDir), before.branch);
  });
});

test('aborting a rebase runs the rebase abort, not the merge one', { skip: SKIP_ON_WINDOWS }, async () => {
  await withConflictedRepo('rebase', async ({ target, repoDir, before }) => {
    const result = await executeGitAction(target, { action: 'abort' });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome.action === 'abort' && result.outcome.operation, 'rebase');
    assert.equal(fs.readFileSync(path.join(repoDir, 'file.txt'), 'utf8'), before.contents);
    assert.equal(await readHead(repoDir), before.head);
    // A rebase stops on a detached HEAD, so this is also the assertion that the
    // branch came back — and that the outcome read it after the unwind, not
    // before, where there would have been none to report.
    assert.equal(await readBranch(repoDir), before.branch);
    assert.equal(result.ok && result.outcome.action === 'abort' && result.outcome.branch, before.branch);
  });
});

test('aborting a cherry-pick runs the cherry-pick abort', { skip: SKIP_ON_WINDOWS }, async () => {
  await withConflictedRepo('cherry-pick', async ({ target, repoDir, before }) => {
    const result = await executeGitAction(target, { action: 'abort' });

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.outcome.action === 'abort' && result.outcome.operation,
      'cherry_pick',
    );
    assert.equal(fs.readFileSync(path.join(repoDir, 'file.txt'), 'utf8'), before.contents);
    assert.equal(await readHead(repoDir), before.head);
  });
});

test('a session working inside a subdirectory can still abort', { skip: SKIP_ON_WINDOWS }, async () => {
  await withConflictedRepo('merge', async ({ target, repoDir, before }) => {
    // A working directory is allowed to sit below the repository root, and the
    // markers only ever live beside the root. Probing the subdirectory finds no
    // `.git` at all, so the panel would draw an abort that always refused.
    const subDir = path.join(repoDir, 'nested');
    fs.mkdirSync(subDir, { recursive: true });

    const result = await executeGitAction({ ...target, workDir: subDir }, { action: 'abort' });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome.action === 'abort' && result.outcome.operation, 'merge');
    assert.equal(fs.readFileSync(path.join(repoDir, 'file.txt'), 'utf8'), before.contents);
    assert.equal(await readHead(repoDir), before.head);
  });
});

test('a worktree with nothing in progress refuses the abort before Git runs', { skip: SKIP_ON_WINDOWS }, async () => {
  await withConflictedRepo('merge', async ({ target, repoDir, before }) => {
    await execFileAsync('git', ['merge', '--abort'], { cwd: repoDir });

    // A press that raced the state it was drawn from. It is a rejection rather
    // than a failure: nothing ran, so there is no Git output to report.
    await assert.rejects(
      () => executeGitAction(target, { action: 'abort' }),
      (error: unknown) =>
        error instanceof GitActionRejection
        && error.code === 'no_conflict_in_progress',
    );
    assert.equal(await readHead(repoDir), before.head);
  });
});
