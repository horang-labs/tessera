import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { CREATE_TABLES } from '../src/lib/db/schema';

const REPO_ROOT = process.cwd();

test('v33 migration conservatively backfills PR relation and knownness', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-pr-migration-'));
  try {
    await writeV33Fixture(dataDir);
    const legacyBytes = await fs.readFile(path.join(dataDir, 'tessera.db'));
    await runConcurrentDatabaseStartups(dataDir, 4);

    const backupBytes = await fs.readFile(path.join(dataDir, 'tessera.db.pre-native-sqlite.bak'));
    assert.deepEqual(backupBytes, legacyBytes);

    const rows = await readRows(dataDir);
    assert.deepEqual(rows, [
      { id: 'closed', pr_relation: 'historical', pr_status_known: 1 },
      { id: 'known-none', pr_relation: null, pr_status_known: 1 },
      { id: 'merged', pr_relation: 'current', pr_status_known: 1 },
      { id: 'open', pr_relation: 'current', pr_status_known: 1 },
      { id: 'unsupported', pr_relation: null, pr_status_known: 0 },
    ]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

async function writeV33Fixture(dataDir: string): Promise<void> {
  const SqlJs = await initSqlJs();
  const db = new SqlJs.Database();
  const v33Tables = CREATE_TABLES
    .replace('  pr_relation      TEXT,\n', '')
    .replace('  pr_status_known  INTEGER NOT NULL DEFAULT 0,\n', '');
  db.exec(v33Tables);
  db.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', '33')`);

  const insert = db.prepare(`
    INSERT INTO tasks (
      id, public_worktree_id, project_id, title, workflow_status,
      pr_number, pr_url, pr_state, pr_last_synced, pr_unsupported,
      created_at, updated_at
    ) VALUES (?, ?, 'project', ?, 'todo', ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = '2026-08-09T00:00:00.000Z';
  for (const state of ['open', 'merged', 'closed'] as const) {
    insert.run([
      state,
      `wt_${state}`,
      state,
      state === 'open' ? 1 : state === 'merged' ? 2 : 3,
      `https://github.com/horang-labs/tessera/pull/${state}`,
      state,
      now,
      0,
      now,
      now,
    ]);
  }
  insert.run(['known-none', 'wt_known_none', 'known-none', null, null, null, now, 0, now, now]);
  insert.run(['unsupported', 'wt_unsupported', 'unsupported', null, null, null, now, 1, now, now]);
  insert.free();

  await fs.writeFile(path.join(dataDir, 'tessera.db'), Buffer.from(db.export()));
  db.close();
}

async function runConcurrentDatabaseStartups(dataDir: string, count: number): Promise<void> {
  const startups = Array.from({ length: count }, () => createDatabaseStartup(dataDir));
  await Promise.all(startups.map((startup) => startup.ready));
  startups.forEach((startup) => startup.start());
  await Promise.all(startups.map((startup) => startup.done));
}

function createDatabaseStartup(dataDir: string): {
  ready: Promise<void>;
  start: () => void;
  done: Promise<void>;
} {
  let markReady: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  let start = () => {};
  const done = new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      '--eval',
      `process.stdout.write('READY\\n'); process.stdin.once('data', async () => { try { const database = await import('./src/lib/db/database.ts'); const init = database.initDatabase ?? database.default?.initDatabase; await init(); } catch (error) { console.error(error); process.exitCode = 1; } });`,
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, TESSERA_DATA_DIR: dataDir, TESSERA_PRODUCTION_DB: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    start = () => { child.stdin.end('START\n'); };
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('READY\n')) markReady();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `database startup exited ${code}`));
    });
  });
  return { ready, start: () => start(), done };
}

async function readRows(dataDir: string): Promise<Array<{
  id: string;
  pr_relation: string | null;
  pr_status_known: number;
}>> {
  const SqlJs = await initSqlJs();
  const bytes = await fs.readFile(path.join(dataDir, 'tessera.db'));
  const db = new SqlJs.Database(bytes);
  const result = db.exec(`
    SELECT id, pr_relation, pr_status_known
    FROM tasks
    ORDER BY id
  `)[0];
  const rows = result.values.map((values) => Object.fromEntries(
    result.columns.map((column, index) => [column, values[index]]),
  )) as Array<{ id: string; pr_relation: string | null; pr_status_known: number }>;
  db.close();
  return rows;
}
