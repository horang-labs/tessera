import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp-retention-'));
process.env.TESSERA_DATA_DIR = path.join(root, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';
const git = (cwd: string, args: string[]) => execFileSync('git', args, {
  cwd, stdio: 'pipe', encoding: 'utf8',
});

test.after(async () => {
  const { processManager } = await import('@/lib/cli/process-manager');
  await processManager.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

test('single-item retention progresses past missing and previously deleted worktrees', async () => {
  const database = await import('@/lib/db/database');
  await database.initDatabase();
  const projects = await import('@/lib/db/projects');
  const sessions = await import('@/lib/db/sessions');
  const archive = await import('@/lib/archive/archive-service');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init']);
  projects.registerProject('retention-origin', repo, 'Retention origin');
  for (const [index, name] of ['missing', 'first', 'second'].entries()) {
    const workDir = path.join(root, name);
    git(repo, ['worktree', 'add', '-b', name, workDir]);
    sessions.createSession(name, 'retention-origin', name, 'claude-code', {
      workDir, worktreeBranch: name, worktreeManaged: true,
    });
    sessions.updateSession(name, {
      archived: 1, archived_at: `2020-01-0${3 - index}T00:00:00.000Z`,
    });
  }
  fs.rmSync(path.join(root, 'missing'), { recursive: true });
  const candidates = await archive.listExpiredArchivedWorktreeCandidates(7);
  assert.equal(candidates.length, 2, 'missing folders do not enter the progress total');
  const firstId = sessions.getSession('first')!.worktree_id!;
  sessions.updateSession('first', { archived: 0 });
  const restored = await archive.pruneExpiredArchivedWorktrees(7, undefined, {
    maxWorktreeAttempts: 1, worktreeIds: new Set([firstId]),
  });
  assert.equal(restored.attempted, 0, 'a queued folder restored before its turn must survive');
  assert.equal(fs.existsSync(path.join(root, 'first')), true);
  assert.equal(fs.existsSync(path.join(root, 'second')), true, 'only the selected folder may be attempted');
  sessions.updateSession('first', { archived: 1 });
  for (const name of ['first', 'second']) {
    const result = await archive.pruneExpiredArchivedWorktrees(7, undefined, { maxWorktreeAttempts: 1 });
    assert.equal(result.removed, 1, JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(root, name)), false);
    assert.ok(sessions.getSession(name), 'archive history survives retention');
  }
  assert.equal(sessions.getSession('missing')?.worktree_deleted_at, null,
    'missing paths preserve canonical records');
});
