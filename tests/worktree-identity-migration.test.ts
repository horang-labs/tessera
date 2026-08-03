import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { CREATE_TABLES } from '../src/lib/db/schema';

const REPO_ROOT = process.cwd();

test('v32 migration preserves every parent and backfills only an eligible child checkout', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-worktree-migration-'));
  try {
    await writeV32Fixture(dataDir);
    await runDatabaseStartup(dataDir);

    const firstStartup = await readMigratedRows(dataDir);
    assert.deepEqual(
      firstStartup.map((row) => ({ id: row.id, path: row.worktree_path })),
      [
        { id: 'deleted-child', path: null },
        { id: 'populated', path: '/eligible/first' },
        { id: 'zero-session', path: null },
      ],
    );
    for (const row of firstStartup) assert.match(row.public_worktree_id, /^wt_[A-Za-z0-9_-]+$/);
    await assertMigratedPersistenceGuards(dataDir);

    await runDatabaseStartup(dataDir);
    const repeatedStartup = await readMigratedRows(dataDir);
    assert.deepEqual(repeatedStartup, firstStartup);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

async function writeV32Fixture(dataDir: string): Promise<void> {
  const SqlJs = await initSqlJs();
  const db = new SqlJs.Database();
  const v32Tables = CREATE_TABLES
    .replace('  public_worktree_id TEXT NOT NULL UNIQUE,\n', '')
    .replace('  worktree_path    TEXT,\n', '');
  db.exec(v32Tables);
  db.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', '32')`);

  const insertParent = db.prepare(`
    INSERT INTO tasks (
      id, project_id, title, workflow_status, created_at, updated_at
    ) VALUES (?, 'project-one', ?, 'todo', ?, ?)
  `);
  for (const id of ['populated', 'zero-session', 'deleted-child']) {
    insertParent.run([id, id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  }
  insertParent.free();

  const insertChild = db.prepare(`
    INSERT INTO sessions (
      id, project_id, title, provider, work_dir, deleted, task_id, created_at, updated_at
    ) VALUES (?, 'project-one', ?, 'codex', ?, ?, ?, ?, ?)
  `);
  insertChild.run([
    'deleted-earliest', 'Deleted earliest', '/deleted/ignored', 1, 'populated',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  ]);
  insertChild.run([
    'eligible-first', 'Eligible first', '/eligible/first', 0, 'populated',
    '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
  ]);
  insertChild.run([
    'eligible-second', 'Eligible second', '/eligible/second', 0, 'populated',
    '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
  ]);
  insertChild.run([
    'only-deleted', 'Only deleted', '/deleted/only', 1, 'deleted-child',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  ]);
  insertChild.free();

  await fs.writeFile(path.join(dataDir, 'tessera.db'), Buffer.from(db.export()));
  db.close();
}

async function assertMigratedPersistenceGuards(dataDir: string): Promise<void> {
  const SqlJs = await initSqlJs();
  const bytes = await fs.readFile(path.join(dataDir, 'tessera.db'));
  const db = new SqlJs.Database(bytes);
  const insert = (id: string, publicId?: string) => db.run(`
    INSERT INTO tasks (
      id, ${publicId === undefined ? '' : 'public_worktree_id,'}
      project_id, title, workflow_status, created_at, updated_at
    ) VALUES (
      ?, ${publicId === undefined ? '' : '?,'}
      'project-one', 'guard', 'todo',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `, publicId === undefined ? [id] : [id, publicId]);

  assert.throws(() => insert('missing-public-id'), /public Worktree ID/i);
  assert.throws(() => insert('invalid-public-id', 'legacy-id'), /public Worktree ID/i);
  db.close();
}

function runDatabaseStartup(dataDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      '--eval',
      `(async () => { const database = await import('./src/lib/db/database.ts'); const init = database.initDatabase ?? database.default?.initDatabase; await init(); })().catch((error) => { console.error(error); process.exitCode = 1; })`,
    ], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TESSERA_DATA_DIR: dataDir,
        TESSERA_PRODUCTION_DB: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `database startup exited ${code}`));
    });
  });
}

async function readMigratedRows(dataDir: string): Promise<Array<{
  id: string;
  public_worktree_id: string;
  worktree_path: string | null;
}>> {
  const SqlJs = await initSqlJs();
  const bytes = await fs.readFile(path.join(dataDir, 'tessera.db'));
  const db = new SqlJs.Database(bytes);
  const result = db.exec(`
    SELECT id, public_worktree_id, worktree_path
    FROM tasks
    ORDER BY id
  `)[0];
  const rows = result.values.map((values) => Object.fromEntries(
    result.columns.map((column, index) => [column, values[index]]),
  )) as Array<{ id: string; public_worktree_id: string; worktree_path: string | null }>;
  db.close();
  return rows;
}
