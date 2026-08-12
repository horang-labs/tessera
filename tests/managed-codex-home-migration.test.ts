import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { CREATE_TABLES } from '@/lib/db/schema';

test('v40 databases gain the managed Codex origin-home binding without backfill', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-managed-home-migration-'));
  try {
    const SqlJs = await initSqlJs();
    const fixture = new SqlJs.Database();
    fixture.exec(CREATE_TABLES.replace('  origin_provider_home_identity TEXT,\n', ''));
    fixture.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', '40')`);
    fixture.run(`
      INSERT INTO projects (id, decoded_path, display_name, registered_at, updated_at)
      VALUES ('project', '/tmp/project', 'Project', 'now', 'now')
    `);
    fixture.run(`
      INSERT INTO sessions (id, project_id, title, provider, created_at, updated_at)
      VALUES ('legacy-managed', 'project', 'Legacy', 'codex', 'now', 'now')
    `);
    await fs.writeFile(path.join(dataDir, 'tessera.db'), Buffer.from(fixture.export()));
    fixture.close();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import', 'tsx',
        '--eval',
        `(async () => { const database = await import('./src/lib/db/database.ts'); await (database.initDatabase ?? database.default?.initDatabase)(); })().catch((error) => { console.error(error); process.exitCode = 1; })`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, TESSERA_DATA_DIR: dataDir, TESSERA_PRODUCTION_DB: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error(stderr || `database startup exited ${code}`)));
    });

    const migrated = new SqlJs.Database(await fs.readFile(path.join(dataDir, 'tessera.db')));
    const columns = migrated.exec(`PRAGMA table_info(sessions)`)[0]?.values
      .map((row) => row[1]);
    const version = migrated.exec(`SELECT value FROM _meta WHERE key = 'schema_version'`)[0]
      ?.values[0]?.[0];
    const legacyIdentity = migrated.exec(`
      SELECT origin_provider_home_identity FROM sessions WHERE id = 'legacy-managed'
    `)[0]?.values[0]?.[0];
    migrated.close();

    assert.equal(version, '41');
    assert.ok(columns?.includes('origin_provider_home_identity'));
    assert.equal(legacyIdentity, null);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
