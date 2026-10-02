import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './automation-fixture';
import { boundary } from './fixtures/autorun-contracts';

test('a Session boundary stays consumed after revision and continuation mode replacement', () => {
  const f = fixture();
  try {
    assert.equal(f.repo.consumeBoundary(boundary, 'heartbeat-rule', 'heartbeat', 1000), true);
    assert.equal(f.repo.boundaryConsumed(boundary.userId, boundary.sessionId, boundary.id), true);
    assert.equal(f.repo.consumeBoundary(boundary, 'autorun-replacement', 'autorun', 2000), false);
    assert.equal(f.repo.consumeBoundary({ ...boundary, id: 'fresh', turnSequence: 3 }, 'autorun-replacement', 'autorun', 3000), true);
  } finally { f.close(); }
});

test('upgrade backfills known heartbeat boundaries without changing legacy config, counters or deleted audit', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { input } = await import('./automation-fixture');
  const f = fixture();
  const a = (await f.service.create('owner', 'legacy', { ...input(), enabled: false })).automation;
  const legacy = { automation: { ...a, state: 'deleted', dispatchCount: 2 }, evidence: null, ownership: null };
  f.repo.save(legacy);
  f.db.prepare(`INSERT INTO session_automation_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-run', a.id, 1, 'owner', 'old', 'delivered', 1000, null, 's', null, 0,
    JSON.stringify({ snapshot: a, boundary: { ...boundary, userId: 'owner', sessionId: 's' } }));
  const original = JSON.stringify(f.repo.get(a.id));
  const filename = f.db.prepare('PRAGMA database_list').all()[0].file as string;
  const dir = path.dirname(filename);
  f.db.close();
  fs.renameSync(filename, path.join(dir, 'tessera.db'));
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--eval', `(async()=>{
      const m=await import('./src/lib/db/database.ts');const a=m.default??m;await a.initDatabase();const db=a.getDb();
      console.log(JSON.stringify({config:db.prepare('SELECT config_json FROM session_automations WHERE id=?').get('${a.id}').config_json,
        consumed:db.prepare('SELECT count(*) n FROM session_automation_boundaries').get().n}));
    })()`], { encoding: 'utf8', env: { ...process.env, TESSERA_DATA_DIR: dir, TESSERA_PRODUCTION_DB: '1', LOG_LEVEL: 'fatal' } });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.config, original);
    assert.equal(result.consumed, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
