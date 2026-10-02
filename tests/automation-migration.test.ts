import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CREATE_TABLES, CREATE_INDEXES } from '../src/lib/db/schema';
const SQLite = require('better-sqlite3');

test('a v39 profile upgrades idempotently to the automation schema with FULL durability and no seeded rules', () => {
  fs.mkdirSync('tmp', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('tmp/automation-migration-'));
  const old = new SQLite(path.join(dir, 'tessera.db'));
  old.exec(CREATE_TABLES); old.exec(CREATE_INDEXES);
  old.prepare("INSERT INTO _meta VALUES ('schema_version','39')").run();
  old.prepare(`INSERT INTO projects (id,decoded_path,display_name,registered_at,updated_at) VALUES ('sentinel','fixture','Keep me','test','test')`).run();
  old.pragma('application_id=0x54455353'); old.close();
  try {
    for (let restart=0;restart<2;restart++) {
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--eval', `(async()=>{
        const m=await import('./src/lib/db/database.ts'); const api=m.default??m;
        await api.initDatabase(); const db=api.getDb();
        console.log(JSON.stringify({version:db.prepare("SELECT value FROM _meta WHERE key='schema_version'").get().value,
          projects:db.prepare("SELECT display_name FROM projects WHERE id='sentinel'").get().display_name,
          count:db.prepare('SELECT count(*) AS n FROM session_automations').get().n,
          tables:db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'session_automation%' ORDER BY name").all().map(r=>r.name),
          synchronous:db.pragma('synchronous')}));
      })().catch(e=>{console.error(e);process.exitCode=1})`], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'fatal', TESSERA_DATA_DIR: dir, TESSERA_PRODUCTION_DB: '1' } });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout.trim()), { version: '40', projects: 'Keep me', count: 0,
        tables: ['session_automation_idempotency', 'session_automation_runs', 'session_automation_scheduler', 'session_automations'], synchronous: 2 });
    }
  } finally { fs.rmSync(dir, { recursive: true }); }
});
