import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { CREATE_TABLES } from '@/lib/db/schema';

test('v34 Sessions migrate with null scope and remain legacy-visible', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-session-scope-migration-'));
  try {
    const SqlJs = await initSqlJs();
    const fixture = new SqlJs.Database();
    fixture.exec(CREATE_TABLES
      .replace('  worktree_id      TEXT,\n', '')
      .replace('  scope_branch     TEXT,\n', ''));
    fixture.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', '34')`);
    fixture.run(`
      INSERT INTO projects (
        id, decoded_path, display_name, visible, sort_order, registered_at, updated_at
      ) VALUES ('legacy-project', '/legacy', 'Legacy', 1, 0, ?, ?)
    `, ['2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z']);
    fixture.run(`
      INSERT INTO sessions (
        id, project_id, title, provider, created_at, updated_at
      ) VALUES ('legacy-session', 'legacy-project', 'Legacy', 'codex', ?, ?)
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
      SELECT worktree_id, scope_branch FROM sessions WHERE id = 'legacy-session'
    `);
    assert.equal(statement.step(), true);
    assert.deepEqual(statement.getAsObject(), { worktree_id: null, scope_branch: null });
    statement.free();
    migrated.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
