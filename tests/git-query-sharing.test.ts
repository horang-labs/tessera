import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Set isolation before importing anything that resolves the application's home.
const root = fs.mkdtempSync(path.join(process.cwd(), '.scratch-git-sharing-'));
process.env.TESSERA_DATA_DIR = path.join(root, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';
const repo = path.join(root, "한글 repo ' $ name");
const user = 'query-sharing-user';
let panel: typeof import('@/lib/git/git-panel');
let runner: typeof import('@/lib/worktrees/git-runner');
let cache: typeof import('@/lib/git/git-read-cache');
let stats: typeof import('@/lib/git/worktree-diff-stats-cache');
let worktreeId: string;
const spawn = childProcess.spawn;
let spawns: string[] = [];

test.before(async () => {
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  fs.appendFileSync(path.join(repo, 'tracked.txt'), 'after\n');
  fs.writeFileSync(path.join(repo, "한글 ' file.txt"), 'new\n');
  const database = await import('@/lib/db/database');
  await database.initDatabase();
  const { SettingsManager } = await import('@/lib/settings/manager');
  for (const id of [user, 'other-user']) {
    await SettingsManager.save(id, { ...await SettingsManager.load(id), agentEnvironment: 'wsl' });
  }
  const { persistCreatedSessionRecord } = await import('@/lib/session/session-persistence');
  persistCreatedSessionRecord({ sessionId: 'query-session', resolvedWorkDir: repo, title: 'query', providerId: 'claude-code' });
  const worktrees = await import('@/lib/db/worktrees');
  worktreeId = worktrees.resolveCanonicalWorktree(repo)!.id;
  panel = await import('@/lib/git/git-panel');
  runner = await import('@/lib/worktrees/git-runner');
  cache = await import('@/lib/git/git-read-cache');
  stats = await import('@/lib/git/worktree-diff-stats-cache');
  // Warm the environment resolver before measuring only parent Git launches.
  await runner.createGitRunner('wsl')(['status', '--porcelain'], { cwd: repo });
  test.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    if (args[0] === 'git' || args[0] === 'sh') spawns.push(String(args[0]));
    return Reflect.apply(spawn, childProcess, args);
  });
});

test.beforeEach(() => { cache.invalidateGitReads(); spawns = []; });
test.after(() => { test.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

test('Session and Worktree API service paths share one actual snapshot spawn and preserve identities', async () => {
  const [session, worktree, changes] = await Promise.all([
    panel.getGitPanelData('query-session', user),
    panel.getWorktreeGitPanelData(worktreeId, user),
    panel.getGitChangedFilesData('query-session', user),
  ]);
  assert.deepEqual(spawns, ['sh']);
  assert.equal(session.sessionId, 'query-session');
  assert.equal(worktree.worktreeId, worktreeId);
  assert.equal(session.repoRoot, repo);
  assert.deepEqual(session.changedFiles, worktree.changedFiles);
  assert.deepEqual(changes.changedFiles, session.changedFiles);
  assert.equal(session.changedFiles.length, 2);
  const shellCount = spawns.length;
  await panel.getGitPanelData('query-session', user);
  assert.equal(spawns.length, shellCount, 'short result cache avoids another spawn');
});

test('batch and separate adapters return equivalent real Git snapshots with fewer parent spawns', async () => {
  const batch = await panel.getGitPanelSnapshot(repo, 'wsl', user);
  assert.deepEqual(spawns, ['sh']);
  spawns = [];
  const separate = await panel.getSeparateGitPanelSnapshot(repo, 'wsl');
  assert.deepEqual(batch, separate);
  assert.ok(spawns.length >= 15);
  assert.ok(spawns.every((command) => command === 'git'));
});

test('file diff readers share repository reads and diff output across target identities', async () => {
  const [session, worktree] = await Promise.all([
    panel.getGitDiffData('query-session', 'tracked.txt', user),
    panel.getWorktreeGitDiffData(worktreeId, 'tracked.txt', user),
  ]);
  assert.deepEqual(spawns, ['sh', 'git']);
  assert.equal(session.sessionId, 'query-session');
  assert.equal(worktree.sessionId, worktreeId);
  assert.equal(session.diff, worktree.diff);
  assert.match(session.diff, /\+after/);
});

test('users and normalized targets are isolated, while equivalent lexical paths coalesce', async () => {
  await Promise.all([
    panel.getGitPanelSnapshot(repo, 'wsl', user),
    panel.getGitPanelSnapshot(path.join(repo, '.'), 'wsl', user),
    panel.getGitPanelSnapshot(repo, 'wsl', 'other-user'),
  ]);
  assert.deepEqual(spawns, ['sh', 'sh']);
  const key = cache.gitReadKey(repo, 'wsl', user, 'snapshot');
  for (const other of [
    cache.gitReadKey(repo, 'native', user, 'snapshot'),
    cache.gitReadKey(repo, 'wsl', user, 'diff', ['a']),
    cache.gitReadKey(repo, 'wsl', user, 'diff', ['b']),
    cache.gitReadKey(repo + ' ', 'wsl', user, 'snapshot'),
  ]) assert.notEqual(key, other);
  assert.notEqual(cache.gitReadKey('\\\\wsl.localhost\\Ubuntu\\home\\repo', 'wsl', user, 'snapshot'),
    cache.gitReadKey('\\\\wsl.localhost\\Debian\\home\\repo', 'wsl', user, 'snapshot'));
});

test('failed snapshot is evicted and a repository created at the same path can retry', async () => {
  const missing = path.join(root, 'not-yet-repo');
  fs.mkdirSync(missing);
  fs.writeFileSync(path.join(missing, '.git'), 'gitdir: missing-target\n');
  await assert.rejects(panel.getGitPanelSnapshot(missing, 'wsl', user), /not a git repository/);
  fs.unlinkSync(path.join(missing, '.git'));
  execFileSync('git', ['init', '-q'], { cwd: missing });
  assert.equal((await panel.getGitPanelSnapshot(missing, 'wsl', user)).repoRoot, missing);
  assert.deepEqual(spawns, ['sh', 'sh']);
});

test('checkout/config mutations and explicit refresh invalidate shared results immediately', async () => {
  await panel.getGitPanelData('query-session', user);
  await runner.createGitRunner('wsl')(['checkout', '-b', 'changed'], { cwd: repo });
  assert.equal((await panel.getWorktreeGitPanelData(worktreeId, user)).branch, 'changed');
  const before = spawns.filter((x) => x === 'sh').length;
  const { flushGitPanelRecompute } = await import('@/lib/git/git-panel-cache');
  await flushGitPanelRecompute('query-session', user);
  assert.equal(spawns.filter((x) => x === 'sh').length, before + 1);
  await runner.createGitRunner('wsl')(['checkout', 'main'], { cwd: repo });
});

test('a real local fetch invalidates the snapshot and exposes newly fetched tracking refs', async () => {
  const remote = path.join(root, 'local-remote.git');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  const git = runner.createGitRunner('wsl');
  await git(['remote', 'add', 'origin', remote], { cwd: repo });
  await git(['push', 'origin', 'main'], { cwd: repo });
  await git(['config', 'branch.main.remote', 'origin'], { cwd: repo });
  await git(['config', 'branch.main.merge', 'refs/heads/main'], { cwd: repo });
  await git(['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: repo });
  assert.equal((await panel.getGitPanelSnapshot(repo, 'wsl', user)).upstream, null);
  const before = spawns.filter((command) => command === 'sh').length;
  await panel.fetchGitRemote(repo, { userId: user });
  assert.equal((await panel.getGitPanelSnapshot(repo, 'wsl', user)).upstream, 'origin/main');
  assert.equal(spawns.filter((command) => command === 'sh').length, before + 1);
  await git(['remote', 'remove', 'origin'], { cwd: repo });
});

test('diff-stats ordinary concurrent reads share exactly one batch without a trailing rerun', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => stats.computeAndCache(repo, user)));
  assert.deepEqual(spawns, ['sh']);
  assert.ok(results[0]);
  assert.equal(results[0].changedFiles, 2);
  assert.equal(results[0].added, 2);
  assert.ok(results.every((value) => value === results[0]));
  await stats.computeAndCache(repo, user);
  assert.deepEqual(spawns, ['sh', 'sh'], 'computeAndCache preserves its explicit recompute/broadcast contract');
  assert.equal(stats.getCachedDiffStats(repo, 'other-user'), undefined);
  await stats.computeAndCache(repo, 'other-user');
  assert.deepEqual(spawns, ['sh', 'sh', 'sh']);
});

test('invalidating a pending read prevents new callers joining it or old completion replacing the new entry', async () => {
  const reads = new cache.GitReadCache<number>(250);
  let release!: (value: number) => void;
  let count = 0;
  const first = reads.read('key', () => { count++; return new Promise<number>((resolve) => { release = resolve; }); });
  await Promise.resolve();
  cache.invalidateGitReads();
  assert.equal(await reads.read('key', async () => { count++; return 2; }), 2);
  release(1);
  assert.equal(await first, 1);
  assert.equal(await reads.read('key', async () => 3), 2);
  assert.equal(count, 2);
  const finishMutation = cache.beginGitMutation();
  assert.equal(await reads.read('key', async () => 4), 4);
  assert.equal(await reads.read('key', async () => 5), 5);
  finishMutation();
  assert.equal(await reads.read('key', async () => 6), 6);
});
