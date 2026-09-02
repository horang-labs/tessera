import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = process.cwd();
const RESULT_MARKER = 'TESSERA_DB_WRITE_RESULT=';
const WRITE_COUNT = 250;
const MAX_WRITE_DURATION_MS = 2_000;
const MAX_EXTERNAL_GROWTH_BYTES = 64 * 1024 * 1024;

test('repeated durable writes keep native memory bounded and remain readable', { timeout: 60_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-db-write-'));
  try {
    const result = await runWriteProbe(dataDir);

    assert.equal(result.value, WRITE_COUNT - 1);
    assert.deepEqual(result.pragmas, {
      applicationId: 0x54455353,
      busyTimeout: 5000,
      foreignKeys: 1,
      journalMode: 'wal',
      synchronous: 1,
    });
    assert.ok(
      result.writeDurationMs < MAX_WRITE_DURATION_MS,
      `${WRITE_COUNT} durable writes took ${Math.round(result.writeDurationMs)} ms`,
    );
    assert.ok(
      result.externalGrowthBytes < MAX_EXTERNAL_GROWTH_BYTES,
      `external memory grew by ${Math.round(result.externalGrowthBytes / 1024 / 1024)} MiB`,
    );

    const databaseStat = await fs.stat(path.join(dataDir, 'tessera.db'));
    assert.ok(databaseStat.size >= 3 * 1024 * 1024, 'probe must exercise a production-sized database');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

function runWriteProbe(dataDir: string): Promise<{
  value: number;
  writeDurationMs: number;
  externalGrowthBytes: number;
  pragmas: {
    applicationId: number;
    busyTimeout: number;
    foreignKeys: number;
    journalMode: string;
    synchronous: number;
  };
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--expose-gc',
      '--import', 'tsx',
      '--eval',
      `(async () => {
        const database = await import('./src/lib/db/database.ts');
        const initDatabase = database.initDatabase ?? database.default?.initDatabase;
        const getDb = database.getDb ?? database.default?.getDb;
        await initDatabase();
        const db = getDb();
        db.exec('CREATE TABLE db_write_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO db_write_probe VALUES (1, 0); CREATE TABLE db_write_padding (payload BLOB NOT NULL); INSERT INTO db_write_padding VALUES (zeroblob(3145728));');
        const update = db.prepare('UPDATE db_write_probe SET value = ? WHERE id = 1');
        const read = db.prepare('SELECT value FROM db_write_probe WHERE id = 1');
        global.gc?.();
        const startExternal = process.memoryUsage().external;
        const startedAt = performance.now();
        let maxExternal = startExternal;
        for (let value = 0; value < ${WRITE_COUNT}; value += 1) {
          update.run(value);
          const row = read.get();
          if (row?.value !== value) throw new Error('write was not immediately readable');
          if (value % 25 === 0) {
            global.gc?.();
            maxExternal = Math.max(maxExternal, process.memoryUsage().external);
          }
        }
        const writeDurationMs = performance.now() - startedAt;
        global.gc?.();
        maxExternal = Math.max(maxExternal, process.memoryUsage().external);
        const row = read.get();
        console.log('${RESULT_MARKER}' + JSON.stringify({
          value: row.value,
          writeDurationMs,
          externalGrowthBytes: maxExternal - startExternal,
          pragmas: {
            applicationId: db.pragma('application_id'),
            busyTimeout: db.pragma('busy_timeout'),
            foreignKeys: db.pragma('foreign_keys'),
            journalMode: db.pragma('journal_mode'),
            synchronous: db.pragma('synchronous'),
          },
        }));
      })().catch((error) => { console.error(error); process.exitCode = 1; })`,
    ], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LOG_LEVEL: 'fatal',
        TESSERA_DATA_DIR: dataDir,
        TESSERA_PRODUCTION_DB: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `database write probe exited ${code}`));
        return;
      }

      const resultLine = stdout.split('\n').find((line) => line.startsWith(RESULT_MARKER));
      if (!resultLine) {
        reject(new Error(`database write probe did not report a result:\n${stdout}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(resultLine.slice(RESULT_MARKER.length)));
    });
  });
}
