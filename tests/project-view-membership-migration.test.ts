import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs, { type Database } from 'sql.js';
import { CREATE_TABLES } from '@/lib/db/schema';

test('a v37 database reaches the merged v39 schema and bootstraps canonical Worktrees once', async () => {
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
    const beforeBootstrap = await readMembership(dataDir);
    assert.equal(beforeBootstrap.schemaVersion, '39');
    assert.equal(beforeBootstrap.bootstrapState, 'pending');
    assert.equal(beforeBootstrap.poisonedWorktreeCount, 0);
    assert.equal(beforeBootstrap.projectWorktreeId, null);
    assert.deepEqual(beforeBootstrap.sessions, [
      { id: 'direct-session', worktree_id: null, scope_branch: null },
      { id: 'legacy-linked-session', worktree_id: null, scope_branch: null },
      { id: 'task-session', worktree_id: null, scope_branch: null },
    ]);
    assert.deepEqual(beforeBootstrap.task, {
      creation_scope_worktree_id: null,
      creation_scope_branch: null,
    });

    const failedBridge = await runFailedBridgeBootstrap(dataDir);
    assert.equal(failedBridge.rejected, true);
    assert.equal(failedBridge.bootstrapState, 'pending');
    assert.equal(failedBridge.projectWorktreeId, null);

    const firstRun = await runAuthenticatedBootstrap(dataDir);
    assert.deepEqual(
      [firstRun.firstStatus, firstRun.concurrentStatus].sort(),
      ['completed', 'not-required'],
    );
    assert.equal(firstRun.secondStatus, 'not-required');
    assert.equal(firstRun.hashUnchanged, true);
    assert.equal(firstRun.mtimeUnchanged, true);
    const bootstrapped = await readMembership(dataDir);
    assert.equal(bootstrapped.bootstrapState, 'complete');
    assert.equal(bootstrapped.poisonedWorktreeCount, 0);
    assert.match(bootstrapped.projectWorktreeId, /^wt_/);
    assert.deepEqual(bootstrapped.sessions, [
      { id: 'direct-session', worktree_id: bootstrapped.projectWorktreeId, scope_branch: null },
      { id: 'legacy-linked-session', worktree_id: 'wt_linked', scope_branch: null },
      { id: 'task-session', worktree_id: 'wt_linked', scope_branch: null },
    ]);
    assert.deepEqual(bootstrapped.task, {
      creation_scope_worktree_id: bootstrapped.projectWorktreeId,
      creation_scope_branch: null,
    });

    await runDatabaseStartup(dataDir);
    const restartedRun = await runAuthenticatedBootstrap(dataDir);
    assert.equal(restartedRun.firstStatus, 'not-required');
    assert.equal(restartedRun.concurrentStatus, 'not-required');
    assert.equal(restartedRun.secondStatus, 'not-required');
    assert.equal(restartedRun.hashUnchanged, true);
    assert.equal(restartedRun.mtimeUnchanged, true);
    assert.deepEqual(await readMembership(dataDir), bootstrapped);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a feature v38 database gains dev PR columns without resetting completed Worktree bootstrap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-feature-v38-migration-'));
  const dataDir = path.join(root, 'data');
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await writeFeatureV38Fixture(dataDir);
    await runDatabaseStartup(dataDir);

    const SqlJs = await initSqlJs();
    const db = new SqlJs.Database(await fs.readFile(path.join(dataDir, 'tessera.db')));
    const columns = rows(db, 'PRAGMA table_info(tasks)').map((row) => row.name);
    const task = rows(db, `
      SELECT pr_relation, pr_status_known FROM tasks WHERE id = 'feature-v38-task'
    `)[0];
    assert.equal(
      rows(db, `SELECT value FROM _meta WHERE key = 'schema_version'`)[0]?.value,
      '39',
    );
    assert.equal(
      rows(db, `SELECT value FROM _meta WHERE key = 'canonical_worktree_bootstrap_v38'`)[0]?.value,
      'complete',
    );
    assert.ok(columns.includes('pr_relation'));
    assert.ok(columns.includes('pr_status_known'));
    assert.deepEqual(task, { pr_relation: 'historical', pr_status_known: 1 });
    db.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an ahead-version database uses the exact Project-root read fallback without rewriting membership', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-ahead-project-membership-'));
  const dataDir = path.join(root, 'data');
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await writeProjectRootMembershipFixture(dataDir, '41');

    const projected = await runAheadVersionProjection(dataDir);
    assert.equal(projected.schemaVersion, '41');
    assert.equal(projected.storedWorktreeId, null);
    assert.deepEqual(projected.sessions, [
      { id: 'exact-root-session', worktreeId: 'wt_project_root' },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function runFailedBridgeBootstrap(dataDir: string): Promise<{
  rejected: boolean;
  bootstrapState: string;
  projectWorktreeId: string | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--eval',
      `(async () => {
        const database = await import('./src/lib/db/database.ts');
        const bootstrap = await import('./src/lib/db/worktree-bootstrap.ts');
        await (database.initDatabase ?? database.default?.initDatabase)();
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        let rejected = false;
        try {
          Object.defineProperty(process, 'platform', { value: 'win32' });
          await (bootstrap.bootstrapCanonicalWorktreeRegistry
            ?? bootstrap.default?.bootstrapCanonicalWorktreeRegistry)(
              'wsl',
              async (reportedPath) => reportedPath,
            );
        } catch {
          rejected = true;
        } finally {
          if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
        }
        const db = (database.getDb ?? database.default?.getDb)();
        const bootstrapState = db.prepare(
          "SELECT value FROM _meta WHERE key = 'canonical_worktree_bootstrap_v38'",
        ).get()?.value;
        const projectWorktreeId = db.prepare(
          "SELECT project_worktree_id FROM projects WHERE id = 'project-a'",
        ).get()?.project_worktree_id ?? null;
        process.stdout.write('__FAILED_BRIDGE_RESULT__' + JSON.stringify({
          rejected,
          bootstrapState,
          projectWorktreeId,
        }) + '\\n');
      })().catch((error) => { console.error(error); process.exitCode = 1; })`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, TESSERA_DATA_DIR: dataDir, TESSERA_PRODUCTION_DB: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr));
        return;
      }
      const resultLine = stdout.split('\n')
        .find((line) => line.startsWith('__FAILED_BRIDGE_RESULT__'));
      if (!resultLine) {
        reject(new Error(`Missing failed-bridge result: ${stdout}`));
        return;
      }
      resolve(JSON.parse(resultLine.slice('__FAILED_BRIDGE_RESULT__'.length)));
    });
  });
}

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

async function writeFeatureV38Fixture(dataDir: string): Promise<void> {
  const SqlJs = await initSqlJs();
  const db = new SqlJs.Database();
  db.exec(CREATE_TABLES);
  const timestamp = '2026-08-10T00:00:00.000Z';
  db.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', '38')`);
  db.run(`
    INSERT INTO _meta (key, value)
    VALUES ('canonical_worktree_bootstrap_v38', 'complete')
  `);
  db.run(`
    INSERT INTO projects (
      id, decoded_path, display_name, visible, sort_order, registered_at, updated_at
    ) VALUES ('feature-v38-project', '/feature-v38', 'Feature v38', 1, 0, ?, ?)
  `, [timestamp, timestamp]);
  db.run(`
    INSERT INTO tasks (
      id, public_worktree_id, project_id, title, workflow_status,
      pr_number, pr_url, pr_state, pr_last_synced, pr_unsupported,
      created_at, updated_at
    ) VALUES (
      'feature-v38-task', 'wt_feature_v38', 'feature-v38-project', 'Feature v38 task', 'todo',
      38, 'https://example.test/pr/38', 'closed', ?, 0,
      ?, ?
    )
  `, [timestamp, timestamp, timestamp]);
  db.exec(`
    ALTER TABLE tasks DROP COLUMN pr_relation;
    ALTER TABLE tasks DROP COLUMN pr_status_known;
  `);
  await fs.writeFile(path.join(dataDir, 'tessera.db'), Buffer.from(db.export()));
  db.close();
}

async function writeProjectRootMembershipFixture(
  dataDir: string,
  schemaVersion: string,
): Promise<void> {
  const SqlJs = await initSqlJs();
  const db = new SqlJs.Database();
  db.exec(CREATE_TABLES);
  const timestamp = '2026-08-14T00:00:00.000Z';
  const reportedRoot = '/home/work/legacy-project-root';
  db.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', ?)`, [schemaVersion]);
  db.run(`
    INSERT INTO _meta (key, value)
    VALUES ('canonical_worktree_bootstrap_v38', 'complete')
  `);
  db.run(`
    INSERT INTO worktrees (
      id, filesystem_path, canonical_path_key, created_at, updated_at
    ) VALUES ('wt_project_root', ?, ?, ?, ?)
  `, [
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\legacy-project-root',
    '\\\\wsl.localhost\\ubuntu-24.04\\home\\work\\legacy-project-root',
    timestamp,
    timestamp,
  ]);
  db.run(`
    INSERT INTO projects (
      id, decoded_path, display_name, visible, sort_order,
      project_worktree_id, registered_at, updated_at
    ) VALUES ('legacy-project', ?, 'Legacy Project', 1, 0, 'wt_project_root', ?, ?)
  `, [reportedRoot, timestamp, timestamp]);
  db.run(`
    INSERT INTO projects (
      id, decoded_path, display_name, visible, sort_order,
      project_worktree_id, registered_at, updated_at
    ) VALUES ('non-git-project', '/home/work/non-git', 'Non-Git', 1, 1, NULL, ?, ?)
  `, [timestamp, timestamp]);

  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, project_id, title, provider, work_dir, created_at, updated_at
    ) VALUES (?, ?, ?, 'codex', ?, ?, ?)
  `);
  insertSession.run([
    'exact-root-session',
    'legacy-project',
    'Exact root',
    reportedRoot,
    timestamp,
    timestamp,
  ]);
  insertSession.run([
    'different-linked-session',
    'legacy-project',
    'Different linked checkout',
    '/home/work/different-linked-checkout',
    timestamp,
    timestamp,
  ]);
  insertSession.run([
    'non-git-session',
    'non-git-project',
    'Non-Git session',
    '/home/work/non-git',
    timestamp,
    timestamp,
  ]);
  insertSession.free();
  await fs.writeFile(path.join(dataDir, 'tessera.db'), Buffer.from(db.export()));
  db.close();
}

function runAheadVersionProjection(dataDir: string): Promise<{
  schemaVersion: string;
  storedWorktreeId: string | null;
  sessions: Array<{ id: string; worktreeId: string | null }>;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--eval',
      `(async () => {
        const database = await import('./src/lib/db/database.ts');
        const projection = await import('./src/lib/projects/project-view-projection.ts');
        await (database.initDatabase ?? database.default?.initDatabase)();
        const db = (database.getDb ?? database.default?.getDb)();
        const result = {
          schemaVersion: db.prepare(
            "SELECT value FROM _meta WHERE key = 'schema_version'",
          ).get()?.value,
          storedWorktreeId: db.prepare(
            "SELECT worktree_id FROM sessions WHERE id = 'exact-root-session'",
          ).get()?.worktree_id ?? null,
          sessions: (projection.getProjectViewProjection
            ?? projection.default?.getProjectViewProjection)('legacy-project').sessions
              .map((session) => ({ id: session.id, worktreeId: session.worktree_id })),
        };
        process.stdout.write('__AHEAD_PROJECTION_RESULT__' + JSON.stringify(result) + '\\n');
      })().catch((error) => { console.error(error); process.exitCode = 1; })`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, TESSERA_DATA_DIR: dataDir, TESSERA_PRODUCTION_DB: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr));
        return;
      }
      const resultLine = stdout.split('\n')
        .find((line) => line.startsWith('__AHEAD_PROJECTION_RESULT__'));
      if (!resultLine) {
        reject(new Error(`Missing ahead-version projection result: ${stdout}`));
        return;
      }
      resolve(JSON.parse(resultLine.slice('__AHEAD_PROJECTION_RESULT__'.length)));
    });
  });
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

function runAuthenticatedBootstrap(dataDir: string): Promise<{
  firstStatus: string;
  concurrentStatus: string;
  secondStatus: string;
  hashUnchanged: boolean;
  mtimeUnchanged: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--eval',
      `(async () => {
        const database = await import('./src/lib/db/database.ts');
        const bootstrap = await import('./src/lib/db/worktree-bootstrap.ts');
        const fs = await import('node:fs');
        const path = await import('node:path');
        const crypto = await import('node:crypto');
        await (database.initDatabase ?? database.default?.initDatabase)();
        const run = bootstrap.bootstrapCanonicalWorktreeRegistry
          ?? bootstrap.default?.bootstrapCanonicalWorktreeRegistry;
        const [first, concurrent] = await Promise.all([run('native'), run('native')]);
        const dbPath = path.join(process.env.TESSERA_DATA_DIR, 'tessera.db');
        const hash = () => crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
        const beforeHash = hash();
        const sentinel = new Date('2000-01-01T00:00:00.000Z');
        fs.utimesSync(dbPath, sentinel, sentinel);
        const beforeMtime = fs.statSync(dbPath).mtimeMs;
        const second = await (bootstrap.bootstrapCanonicalWorktreeRegistry
          ?? bootstrap.default?.bootstrapCanonicalWorktreeRegistry)('native');
        const result = {
          firstStatus: first.status,
          concurrentStatus: concurrent.status,
          secondStatus: second.status,
          hashUnchanged: beforeHash === hash(),
          mtimeUnchanged: beforeMtime === fs.statSync(dbPath).mtimeMs,
        };
        process.stdout.write('__BOOTSTRAP_RESULT__' + JSON.stringify(result) + '\\n');
      })().catch((error) => { console.error(error); process.exitCode = 1; })`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, TESSERA_DATA_DIR: dataDir, TESSERA_PRODUCTION_DB: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr));
        return;
      }
      const resultLine = stdout.split('\n')
        .find((line) => line.startsWith('__BOOTSTRAP_RESULT__'));
      if (!resultLine) {
        reject(new Error(`Missing bootstrap result: ${stdout}`));
        return;
      }
      resolve(JSON.parse(resultLine.slice('__BOOTSTRAP_RESULT__'.length)));
    });
  });
}

async function readMembership(dataDir: string) {
  const SqlJs = await initSqlJs();
  const db = new SqlJs.Database(await fs.readFile(path.join(dataDir, 'tessera.db')));
  const projectWorktreeId = rows(db, `
    SELECT project_worktree_id FROM projects WHERE id = 'project-a'
  `)[0]?.project_worktree_id as string | null;
  const schemaVersion = rows(db, `
    SELECT value FROM _meta WHERE key = 'schema_version'
  `)[0]?.value as string;
  const bootstrapState = rows(db, `
    SELECT value FROM _meta WHERE key = 'canonical_worktree_bootstrap_v38'
  `)[0]?.value as string;
  const poisonedWorktreeCount = rows(db, `
    SELECT COUNT(*) AS count
    FROM worktrees
    WHERE LOWER(filesystem_path) LIKE 'c:\\home\\%'
  `)[0]?.count as number;
  const sessions = rows(db, `
    SELECT id, worktree_id, scope_branch FROM sessions ORDER BY id
  `);
  const task = rows(db, `
    SELECT creation_scope_worktree_id, creation_scope_branch
    FROM tasks WHERE id = 'linked-task'
  `)[0];
  db.close();
  return {
    schemaVersion,
    bootstrapState,
    poisonedWorktreeCount,
    projectWorktreeId,
    sessions,
    task,
  };
}

function rows(db: Database, sql: string): Array<Record<string, unknown>> {
  const result = db.exec(sql)[0];
  return result.values.map((values) => Object.fromEntries(
    result.columns.map((column, index) => [column, values[index]]),
  ));
}
