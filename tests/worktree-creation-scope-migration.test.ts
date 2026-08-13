import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { CREATE_TABLES } from '@/lib/db/schema';

test('v35 Worktrees migrate with null Creation Scope and Start Point', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-worktree-scope-migration-'));
  try {
    const SqlJs = await initSqlJs();
    const fixture = new SqlJs.Database();
    fixture.exec(CREATE_TABLES
      .replace('  creation_scope_worktree_id TEXT,\n', '')
      .replace('  creation_scope_branch TEXT,\n', '')
      .replace('  start_point      TEXT,\n', ''));
    fixture.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', '35')`);
    fixture.run(`
      INSERT INTO tasks (
        id, public_worktree_id, project_id, title, workflow_status, created_at, updated_at
      ) VALUES ('legacy-task', 'wt_legacy', 'legacy-project', 'Legacy', 'todo', ?, ?)
    `, ['2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z']);
    await fs.writeFile(path.join(dataDir, 'tessera.db'), Buffer.from(fixture.export()));
    fixture.close();

    await new Promise<void>((resolve, reject) => {
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

    const migrated = new SqlJs.Database(await fs.readFile(path.join(dataDir, 'tessera.db')));
    const statement = migrated.prepare(`
      SELECT creation_scope_worktree_id, creation_scope_branch, start_point
      FROM tasks WHERE id = 'legacy-task'
    `);
    assert.equal(statement.step(), true);
    assert.deepEqual(statement.getAsObject(), {
      creation_scope_worktree_id: null,
      creation_scope_branch: null,
      start_point: null,
    });
    statement.free();
    migrated.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
