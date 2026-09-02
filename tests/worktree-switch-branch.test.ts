import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import type { GitRunner } from '../src/lib/worktrees/git-runner';
import {
  switchWorktreeBranch,
  WorktreeBranchSwitchError,
} from '../src/lib/worktrees/switch-branch';

const execFileAsync = promisify(execFile);
const branchRoutePath = new URL('../src/app/api/worktrees/[id]/branch/route.ts', import.meta.url);
const checkoutControlPath = new URL('../src/components/worktree/project-checkout-branch.tsx', import.meta.url);
const worktreePeekPath = new URL('../src/components/worktree/worktree-peek.tsx', import.meta.url);

async function withRepository(run: (repoDir: string, runGit: GitRunner) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-switch-branch-'));
  const repoDir = path.join(root, 'repo');
  try {
    await execFileAsync('git', ['init', '-b', 'main', repoDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'main\n');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['branch', 'branch-b'], { cwd: repoDir });

    await run(repoDir, async (args) => execFileAsync('git', args));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('switchWorktreeBranch changes the existing checkout to an exact local branch', async () => {
  await withRepository(async (repoDir, runGit) => {
    const branch = await switchWorktreeBranch({ workDir: repoDir, branch: 'branch-b', runGit });
    assert.equal(branch, 'branch-b');
    const current = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoDir });
    assert.equal(current.stdout.trim(), 'branch-b');
  });
});

test('switchWorktreeBranch accepts the current branch without invoking git switch', async () => {
  await withRepository(async (repoDir, runGit) => {
    const invocations: string[][] = [];
    const recordingRunGit: GitRunner = async (args, options) => {
      invocations.push(args);
      return runGit(args, options);
    };
    assert.equal(
      await switchWorktreeBranch({ workDir: repoDir, branch: 'main', runGit: recordingRunGit }),
      'main',
    );
    assert.equal(invocations.some((args) => args.includes('switch')), false);
  });
});

test('switchWorktreeBranch rejects branches that are not exact local refs', async () => {
  await withRepository(async (repoDir, runGit) => {
    await assert.rejects(
      switchWorktreeBranch({ workDir: repoDir, branch: 'missing', runGit }),
      (error) => error instanceof WorktreeBranchSwitchError
        && error.code === 'branch_not_found',
    );
  });
});

test('switchWorktreeBranch refuses normalized or option-like branch input', async () => {
  await withRepository(async (repoDir, runGit) => {
    for (const branch of [' branch-b', 'branch-b ', '-branch-b']) {
      await assert.rejects(
        switchWorktreeBranch({ workDir: repoDir, branch, runGit }),
        (error) => error instanceof WorktreeBranchSwitchError
          && error.code === 'branch_not_found',
      );
    }
    const current = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoDir });
    assert.equal(current.stdout.trim(), 'main');
  });
});

test('switchWorktreeBranch preserves Git refusal details when another Worktree owns the branch', async () => {
  await withRepository(async (repoDir, runGit) => {
    const otherWorktree = path.join(path.dirname(repoDir), 'other-worktree');
    await runGit(['-C', repoDir, 'worktree', 'add', otherWorktree, 'branch-b']);

    await assert.rejects(
      switchWorktreeBranch({ workDir: repoDir, branch: 'branch-b', runGit }),
      (error) => typeof error === 'object'
        && error !== null
        && 'stderr' in error
        && typeof error.stderr === 'string'
        && /already (?:used by|checked out in) worktree/i.test(error.stderr),
    );
    const current = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoDir });
    assert.equal(current.stdout.trim(), 'main');
  });
});

test('Project checkout switching resolves refs by canonical Worktree id only', () => {
  const route = fs.readFileSync(branchRoutePath, 'utf8');
  const control = fs.readFileSync(checkoutControlPath, 'utf8');
  const peek = fs.readFileSync(worktreePeekPath, 'utf8');

  assert.match(route, /requireAuthenticatedUserId/);
  assert.match(route, /resolveWorktreeGitTarget\(id, auth\.userId\)/);
  assert.match(route, /export async function GET/);
  assert.match(route, /listWorktreeBaseRefs\(/);
  assert.match(route, /error\.stderr \|\| error\.message/);
  assert.doesNotMatch(route, /projectDir/);
  assert.match(control, /\/api\/worktrees\/\$\{encodeURIComponent\(worktreeId\)\}\/branch/);
  assert.doesNotMatch(control, /useWorktreeBaseRefs/);
  assert.match(peek, /isProjectWorktree && project\?\.projectWorktree/);
});
