import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { CREATE_TABLES } from '../src/lib/db/schema';

const REPO_ROOT = process.cwd();

test('v39 databases gain Project-owned Control audit persistence', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-audit-migration-'));
  try {
    await writeV39Fixture(dataDir);
    await runDatabaseStartup(dataDir);

    const SqlJs = await initSqlJs();
    const bytes = await fs.readFile(path.join(dataDir, 'tessera.db'));
    const db = new SqlJs.Database(bytes);
    const schemaVersion = db.exec(`SELECT value FROM _meta WHERE key = 'schema_version'`)[0]
      ?.values[0]?.[0];
    const auditTable = db.exec(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'control_audit_history'
    `)[0]?.values[0]?.[0];
    const deleteTrigger = db.exec(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'trg_projects_delete_control_audit'
    `)[0]?.values[0]?.[0];
    db.close();

    assert.equal(schemaVersion, '41');
    assert.equal(auditTable, 'control_audit_history');
    assert.equal(deleteTrigger, 'trg_projects_delete_control_audit');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

async function writeV39Fixture(dataDir: string): Promise<void> {
  const SqlJs = await initSqlJs();
  const db = new SqlJs.Database();
  const v39Tables = CREATE_TABLES.replace(
    /\nCREATE TABLE IF NOT EXISTS control_audit_history[\s\S]*?END;\n\nCREATE TABLE IF NOT EXISTS sessions/,
    '\nCREATE TABLE IF NOT EXISTS sessions',
  );
  assert.equal(v39Tables.includes('control_audit_history'), false);
  db.exec(v39Tables);
  db.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', '39')`);
  await fs.writeFile(path.join(dataDir, 'tessera.db'), Buffer.from(db.export()));
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
      env: { ...process.env, TESSERA_DATA_DIR: dataDir, TESSERA_PRODUCTION_DB: '1' },
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
