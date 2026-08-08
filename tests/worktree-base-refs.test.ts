import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createGitWorktree } from '../src/lib/worktrees/create';
import {
  listWorktreeBaseRefs,
  validateWorktreeBaseRef,
  type WorktreeBaseRef,
} from '../src/lib/worktrees/base-refs';
import type { GitRunner } from '../src/lib/worktrees/git-runner';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd });
}

test('listWorktreeBaseRefs returns local and remote refs, excludes remote HEAD, and marks current branch', async () => {
  const calls: string[][] = [];
  const runGit: GitRunner = async (args) => {
    calls.push(args);
    if (args.includes('symbolic-ref')) {
      return { stdout: 'develop', stderr: '' };
    }
    if (args.includes('for-each-ref')) {
      return {
        stdout: [
          'refs/remotes/origin/main',
          'refs/heads/develop',
          'refs/remotes/origin/HEAD',
          'refs/heads/main',
        ].join('\n'),
        stderr: '',
      };
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  const refs = await listWorktreeBaseRefs('/repo', runGit);

  assert.deepEqual(refs, [
    { name: 'develop', label: 'develop', kind: 'local', current: true },
    { name: 'main', label: 'main', kind: 'local', current: false },
    { name: 'origin/main', label: 'origin/main', kind: 'remote', current: false },
  ]);
  assert.deepEqual(calls[0], ['-C', '/repo', 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  assert.deepEqual(calls[1], [
    '-C',
    '/repo',
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ]);
});

test('listWorktreeBaseRefs reads real local and remote refs from git', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-base-refs-'));
  const remoteDir = path.join(tmp, 'remote.git');
  const repoDir = path.join(tmp, 'repo');
  try {
    await git(['init', '--bare', remoteDir], tmp);
    await git(['clone', remoteDir, repoDir], tmp);
    await git(['config', 'user.email', 'test@example.com'], repoDir);
    await git(['config', 'user.name', 'Test User'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'main\n');
    await git(['add', 'file.txt'], repoDir);
    await git(['commit', '-m', 'main'], repoDir);
    await git(['branch', '-M', 'main'], repoDir);
    await git(['push', '-u', 'origin', 'main'], repoDir);
    await git(['checkout', '-b', 'develop'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'develop\n');
    await git(['commit', '-am', 'develop'], repoDir);
    await git(['push', '-u', 'origin', 'develop'], repoDir);

    const runGit: GitRunner = async (args) => execFileAsync('git', args);
    const refs = await listWorktreeBaseRefs(repoDir, runGit);

    assert.equal(refs.find((ref) => ref.name === 'develop')?.current, true);
    assert.ok(refs.some((ref) => ref.name === 'main' && ref.kind === 'local'));
    assert.ok(refs.some((ref) => ref.name === 'origin/main' && ref.kind === 'remote'));
    assert.ok(refs.some((ref) => ref.name === 'origin/develop' && ref.kind === 'remote'));
    assert.equal(refs.some((ref) => ref.name === 'origin/HEAD'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateWorktreeBaseRef only accepts listed refs and verifies they point to commits', async () => {
  const refs: WorktreeBaseRef[] = [
    { name: 'main', label: 'main', kind: 'local', current: true },
    { name: 'origin/develop', label: 'origin/develop', kind: 'remote', current: false },
  ];
  const calls: string[][] = [];
  const runGit: GitRunner = async (args) => {
    calls.push(args);
    if (args.at(-1) === 'main^{commit}') {
      return { stdout: 'abc123', stderr: '' };
    }
    throw new Error('invalid ref');
  };

  assert.equal(await validateWorktreeBaseRef('/repo', 'main', refs, runGit), true);
  assert.equal(await validateWorktreeBaseRef('/repo', 'abc123', refs, runGit), false);
  assert.equal(await validateWorktreeBaseRef('/repo', 'main~1', refs, runGit), false);
  assert.equal(await validateWorktreeBaseRef('/repo', '-bad', refs, runGit), false);
  assert.deepEqual(calls, [
    ['-C', '/repo', 'rev-parse', '--verify', '--quiet', 'main^{commit}'],
  ]);
});

test('branch-off creates from local and remote refs, records each base, and never adopts an upstream', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-worktree-add-'));
  const repoDir = path.join(tmp, 'repo');
  const localWorktreePath = path.join(tmp, 'worktrees', 'local');
  const remoteWorktreePath = path.join(tmp, 'worktrees', 'remote');
  try {
    await git(['init', repoDir], tmp);
    await git(['config', 'user.email', 'test@example.com'], repoDir);
    await git(['config', 'user.name', 'Test User'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'main\n');
    await git(['add', 'file.txt'], repoDir);
    await git(['commit', '-m', 'main'], repoDir);
    await git(['branch', '-M', 'main'], repoDir);
    await git(['checkout', '-b', 'develop'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'develop\n');
    await git(['commit', '-am', 'develop'], repoDir);
    await git(['checkout', 'main'], repoDir);
    await git(['update-ref', 'refs/remotes/origin/develop', 'develop'], repoDir);

    const runGit: GitRunner = async (args) => execFileAsync('git', args);
    const refs = await listWorktreeBaseRefs(repoDir, runGit);
    assert.equal(await validateWorktreeBaseRef(repoDir, 'origin/develop', refs, runGit), true);

    await createGitWorktree({
      projectDir: repoDir,
      worktreePath: localWorktreePath,
      branchName: 'tw/local',
      source: { mode: 'branch-off', baseRef: 'main' },
      runGit,
    });
    await createGitWorktree({
      projectDir: repoDir,
      worktreePath: remoteWorktreePath,
      branchName: 'tw/remote',
      source: { mode: 'branch-off', baseRef: 'origin/develop' },
      runGit,
    });

    assert.equal(
      (await git(['rev-parse', '--abbrev-ref', 'HEAD'], localWorktreePath)).stdout.trim(),
      'tw/local',
    );
    assert.equal(
      (await git(['show', '-s', '--format=%s', 'HEAD'], localWorktreePath)).stdout.trim(),
      'main',
    );
    assert.equal(
      (await git(['config', '--get', 'branch.tw/local.base'], repoDir)).stdout.trim(),
      'refs/heads/main',
    );
    assert.equal(
      (await git(['rev-parse', '--abbrev-ref', 'HEAD'], remoteWorktreePath)).stdout.trim(),
      'tw/remote',
    );
    assert.equal(
      (await git(['show', '-s', '--format=%s', 'HEAD'], remoteWorktreePath)).stdout.trim(),
      'develop',
    );
    assert.equal(
      (await git(['config', '--get', 'branch.tw/remote.base'], repoDir)).stdout.trim(),
      'refs/remotes/origin/develop',
    );

    // A remote-tracking start point must stay a start point. Git's default
    // `branch.autoSetupMerge` would make `origin/develop` this branch's
    // upstream, which is what bare `git push` and bare `git pull` obey: the
    // push would be refused for a name mismatch and the pull would merge
    // `develop` in. Asserted against the config pair rather than `@{upstream}`
    // because that pair is the whole of Git's definition (`upstream-config.ts`).
    const { stdout: upstreamConfig } = await git(
      ['config', '--get-regexp', '^branch\\.tw/(local|remote)\\.(remote|merge)$'],
      repoDir,
    ).catch(() => ({ stdout: '' }));
    assert.equal(upstreamConfig.trim(), '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const routePath = new URL('../src/app/api/worktrees/route.ts', import.meta.url);
const refsRoutePath = new URL('../src/app/api/worktrees/refs/route.ts', import.meta.url);

function routeSource() {
  return fs.readFileSync(routePath, 'utf8');
}

function refsRouteSource() {
  return fs.readFileSync(refsRoutePath, 'utf8');
}

test('worktree route validates selected baseRef before add', () => {
  const source = routeSource();

  assert.match(source, /listWorktreeBaseRefs/);
  assert.match(source, /baseRef\?: unknown/);
  assert.match(source, /baseRef must be a string/);
  assert.match(source, /INVALID_BASE_REF/);
  assert.match(source, /validateWorktreeBaseRef\([\s\S]*availableBaseRefs[\s\S]*runGit[\s\S]*\)/);
  assert.match(source, /createGitWorktree/);
});

test('worktree refs route exposes the base-ref listing endpoint used by the client', () => {
  const source = refsRouteSource();

  assert.match(source, /export async function GET/);
  assert.match(source, /listWorktreeBaseRefs/);
  assert.match(source, /projectDir is required/);
  assert.match(source, /checkManagedWorktreePreflight/);
});

const clientHookPath = new URL('../src/hooks/use-worktree-base-refs.ts', import.meta.url);

function clientHookSource() {
  return fs.readFileSync(clientHookPath, 'utf8');
}

test('client hook loads worktree base refs, defaults to current ref, and only submits explicit overrides', () => {
  const source = clientHookSource();

  assert.match(source, /export function useWorktreeBaseRefs/);
  assert.match(source, /fetchWithClientId/);
  assert.match(source, /\/api\/worktrees\/refs/);
  assert.match(source, /URLSearchParams/);
  assert.match(source, /currentRef/);
  assert.match(source, /setSelectedBaseRef\(currentRef\?\.name/);
  assert.match(source, /hasUserSelectedBaseRef/);
  assert.match(source, /currentBaseRefName/);
  assert.match(source, /selectedBaseRefForCreate/);
  assert.match(source, /effectiveSelectedBaseRef !== currentBaseRefName/);
  assert.doesNotMatch(source, /[^A-Za-z]fetch\(`/);
});

const sessionHookPath = new URL('../src/hooks/use-worktree-session.ts', import.meta.url);

function sessionHookSource() {
  return fs.readFileSync(sessionHookPath, 'utf8');
}

test('worktree session creation sends selected baseRef to the worktree API', () => {
  const source = sessionHookSource();

  assert.match(source, /baseRef\?: string/);
  assert.match(source, /baseRef,/);
  assert.match(source, /JSON\.stringify\(\{[\s\S]*baseRef,[\s\S]*\}\)/);
});

const quickCreatePath = new URL('../src/components/chat/collection-quick-create-sheet.tsx', import.meta.url);
const enI18nPath = new URL('../src/lib/i18n/en.ts', import.meta.url);

function quickCreateSource() {
  return fs.readFileSync(quickCreatePath, 'utf8');
}

function enI18nSource() {
  return fs.readFileSync(enI18nPath, 'utf8');
}

test('collection quick create sheet renders and submits a base ref selector', () => {
  const source = quickCreateSource();

  assert.match(source, /useWorktreeBaseRefs/);
  assert.match(source, /WorktreeStartFromControl/);
  assert.match(source, /collection-task-base-ref/);
  assert.match(source, /selectedBaseRefForCreate/);
  assert.match(source, /baseRef: selectedBaseRefForCreate/);
  assert.doesNotMatch(source, /isLoadingBaseRefs \|\| !selectedBaseRef/);
});

test('English i18n includes worktree base ref selector copy', () => {
  const source = enI18nSource();

  assert.match(source, /baseRefLabel/);
  assert.match(source, /baseRefLoading/);
  assert.match(source, /baseRefUnavailable/);
  assert.match(source, /baseRefLocalGroup/);
  assert.match(source, /baseRefRemoteGroup/);
  assert.match(source, /Start from/);
});

const emptyPanelPath = new URL('../src/components/panel/empty-panel-state.tsx', import.meta.url);

function emptyPanelSource() {
  return fs.readFileSync(emptyPanelPath, 'utf8');
}

test('empty panel task creation renders and submits a base ref selector', () => {
  const source = emptyPanelSource();

  assert.match(source, /useWorktreeBaseRefs/);
  assert.match(source, /WorktreeStartFromControl/);
  assert.match(source, /empty-panel-base-ref/);
  assert.match(source, /selectedBaseRefForCreate/);
  assert.match(source, /baseRef: selectedBaseRefForCreate/);
  assert.doesNotMatch(source, /isLoadingBaseRefs \|\| !selectedBaseRef/);
});
