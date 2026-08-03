import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-worktree-identity-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

type Modules = {
  adapter: typeof import('@/lib/control/database-worktree-source');
  database: typeof import('@/lib/db/database');
  sessions: typeof import('@/lib/db/sessions');
  tasks: typeof import('@/lib/db/tasks');
};

let loaded: Promise<Modules> | null = null;
function modules(): Promise<Modules> {
  loaded ??= (async () => {
    const [adapter, database, sessions, tasks] = await Promise.all([
      import('@/lib/control/database-worktree-source'),
      import('@/lib/db/database'),
      import('@/lib/db/sessions'),
      import('@/lib/db/tasks'),
    ]);
    await database.initDatabase();
    return { adapter, database, sessions, tasks };
  })();
  return loaded;
}

test('new Worktree parents receive opaque persisted IDs with database uniqueness', async () => {
  const { database, tasks } = await modules();
  tasks.createTask({ id: 'legacy-internal-one', projectId: 'project-one', title: 'One' });
  tasks.createTask({ id: 'legacy-internal-two', projectId: 'project-one', title: 'Two' });

  const rows = database.getDb().prepare(`
    SELECT id, public_worktree_id, worktree_path
    FROM tasks
    ORDER BY id
  `).all() as Array<{
    id: string;
    public_worktree_id: string;
    worktree_path: string | null;
  }>;

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.public_worktree_id, /^wt_[A-Za-z0-9_-]+$/);
    assert.equal(row.public_worktree_id.includes(row.id), false);
    assert.equal(row.worktree_path, null);
  }
  assert.notEqual(rows[0].public_worktree_id, rows[1].public_worktree_id);
  assert.throws(() => {
    database.getDb().prepare(`
      UPDATE tasks SET public_worktree_id = ? WHERE id = ?
    `).run(rows[0].public_worktree_id, rows[1].id);
  }, /unique/i);
});

test('UI reads prefer the parent checkout path and retain the legacy child fallback', async () => {
  const { sessions, tasks } = await modules();
  const parentPath = path.join(dataDir, 'parent-owned');
  const staleChildPath = path.join(dataDir, 'stale-child');

  tasks.createTask({ id: 'parent-owned', projectId: 'project-one', title: 'Parent owned' });
  tasks.setTaskWorktreeCheckout('parent-owned', {
    branch: 'feature/parent-owned',
    path: parentPath,
  });
  sessions.createSession('stale-child', 'project-one', 'Stale child', 'codex', {
    taskId: 'parent-owned',
    workDir: staleChildPath,
    worktreeManaged: true,
  });

  assert.equal(tasks.getTask('parent-owned')?.workDir, parentPath);
  assert.equal(tasks.getTask('parent-owned')?.worktreeBranch, 'feature/parent-owned');

  tasks.createTask({ id: 'legacy-fallback', projectId: 'project-one', title: 'Legacy fallback' });
  sessions.createSession('legacy-child', 'project-one', 'Legacy child', 'claude-code', {
    taskId: 'legacy-fallback',
    workDir: staleChildPath,
    worktreeManaged: true,
  });

  assert.equal(tasks.getTask('legacy-fallback')?.workDir, staleChildPath);
});

test('the persistence adapter lists zero-session Worktrees and resolves only public IDs', async () => {
  const { adapter, database, sessions, tasks } = await modules();
  tasks.createTask({ id: 'adapter-zero', projectId: 'adapter-project', title: 'Adapter zero' });
  tasks.createTask({ id: 'adapter-populated', projectId: 'adapter-project', title: 'Adapter populated' });
  sessions.createSession('adapter-session', 'adapter-project', 'Adapter session', 'codex', {
    taskId: 'adapter-populated',
    workDir: '/legacy/adapter-fallback',
  });
  database.getDb().prepare(`
    UPDATE tasks
    SET worktree_branch = 'feature/adapter',
        preparation_status = 'running',
        preparation_phase = 'after'
    WHERE id = 'adapter-populated'
  `).run();

  const source = adapter.createDatabaseControlWorktreeSource();
  const listed = source.list('adapter-project');
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((worktree) => ({
    title: worktree.title,
    path: worktree.filesystemPath,
    sessions: worktree.sessions.map((session) => session.sessionId),
  })), [
    {
      title: 'Adapter populated',
      path: '/legacy/adapter-fallback',
      sessions: ['adapter-session'],
    },
    { title: 'Adapter zero', path: null, sessions: [] },
  ]);

  const publicId = listed[0].worktreeId;
  assert.equal(source.get(publicId)?.worktreeId, publicId);
  assert.equal(source.get('adapter-zero'), undefined);

  const zeroSessionPublicId = listed.find((worktree) => worktree.title === 'Adapter zero')?.worktreeId;
  assert.ok(zeroSessionPublicId);
  database.getDb().prepare(`
    UPDATE tasks SET archived = 1, worktree_deleted_at = ? WHERE id = 'adapter-zero'
  `).run('2026-08-03T00:00:00.000Z');
  assert.equal(source.list('adapter-project').some(
    (worktree) => worktree.worktreeId === zeroSessionPublicId,
  ), false);
  assert.equal(source.get(zeroSessionPublicId)?.sessions.length, 0);
});
