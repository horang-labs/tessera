import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs, { type Database } from 'sql.js';
import { CREATE_TABLES } from '@/lib/db/schema';

test('v37 migration replaces Project-owned membership with canonical Worktree identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-project-membership-migration-'));
  const dataDir = path.join(root, 'data');
  const repository = path.join(root, 'repository');
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(repository, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', repository], { stdio: 'ignore' });
    const linkedRepository = path.join(root, 'linked-repository');
    await fs.mkdir(linkedRepository, { recursive: true });
    await writeV37Fixture(dataDir, repository, linkedRepository);

    await runDatabaseStartup(dataDir);
    const firstStartup = await readMembership(dataDir);
    assert.equal(firstStartup.schemaVersion, '38');
    assert.match(firstStartup.projectWorktreeId, /^wt_/);
    assert.deepEqual(firstStartup.sessions, [
      { id: 'direct-session', worktree_id: firstStartup.projectWorktreeId, scope_branch: null },
      { id: 'legacy-linked-session', worktree_id: 'wt_linked', scope_branch: null },
      { id: 'task-session', worktree_id: 'wt_linked', scope_branch: null },
    ]);
    assert.deepEqual(firstStartup.task, {
      creation_scope_worktree_id: firstStartup.projectWorktreeId,
      creation_scope_branch: null,
    });

    await runDatabaseStartup(dataDir);
    assert.deepEqual(await readMembership(dataDir), firstStartup);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeV37Fixture(
  dataDir: string,
  repository: string,
  linkedRepository: string,
): Promise<void> {
  const SqlJs = await initSqlJs();
  const db = new SqlJs.Database();
  db.exec(CREATE_TABLES);
  db.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', '37')`);
  const timestamp = '2026-08-10T00:00:00.000Z';
  db.run(`
    INSERT INTO projects (
      id, decoded_path, display_name, visible, sort_order, registered_at, updated_at
    ) VALUES ('project-a', ?, 'Project A', 1, 0, ?, ?)
  `, [repository, timestamp, timestamp]);
  db.run(`
    INSERT INTO worktrees (
      id, filesystem_path, canonical_path_key, created_at, updated_at
    ) VALUES ('wt_linked', ?, ?, ?, ?)
  `, [linkedRepository, linkedRepository, timestamp, timestamp]);
  db.run(`
    INSERT INTO tasks (
      id, public_worktree_id, project_id, title, workflow_status, created_at, updated_at
    ) VALUES ('linked-task', 'wt_linked', 'project-a', 'Linked', 'todo', ?, ?)
  `, [timestamp, timestamp]);
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, project_id, title, provider, work_dir, task_id, created_at, updated_at
    ) VALUES (?, 'project-a', ?, 'codex', ?, ?, ?, ?)
  `);
  insertSession.run(['direct-session', 'Direct', null, null, timestamp, timestamp]);
  insertSession.run([
    'legacy-linked-session',
    'Legacy linked',
    linkedRepository,
    null,
    timestamp,
    timestamp,
  ]);
  insertSession.run(['task-session', 'Task child', linkedRepository, 'linked-task', timestamp, timestamp]);
  insertSession.free();
  await fs.writeFile(path.join(dataDir, 'tessera.db'), Buffer.from(db.export()));
  db.close();
}

function runDatabaseStartup(dataDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--eval',
      `(async () => { const m = await import('./src/lib/db/database.ts'); const init = m.initDatabase ?? m.default?.initDatabase; await init(); })().catch((error) => { console.error(error); process.exitCode = 1; })`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, TESSERA_DATA_DIR: dataDir, TESSERA_PRODUCTION_DB: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

async function readMembership(dataDir: string) {
  const SqlJs = await initSqlJs();
  const db = new SqlJs.Database(await fs.readFile(path.join(dataDir, 'tessera.db')));
  const projectWorktreeId = rows(db, `
    SELECT project_worktree_id FROM projects WHERE id = 'project-a'
  `)[0]?.project_worktree_id as string;
  const schemaVersion = rows(db, `
    SELECT value FROM _meta WHERE key = 'schema_version'
  `)[0]?.value as string;
  const sessions = rows(db, `
    SELECT id, worktree_id, scope_branch FROM sessions ORDER BY id
  `);
  const task = rows(db, `
    SELECT creation_scope_worktree_id, creation_scope_branch
    FROM tasks WHERE id = 'linked-task'
  `)[0];
  db.close();
  return { schemaVersion, projectWorktreeId, sessions, task };
}

function rows(db: Database, sql: string): Array<Record<string, unknown>> {
  const result = db.exec(sql)[0];
  return result.values.map((values) => Object.fromEntries(
    result.columns.map((column, index) => [column, values[index]]),
  ));
}
