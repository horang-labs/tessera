import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-control-audit-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('Project-owned audit history survives source Session deletion and Project archive', async () => {
  const [{ initDatabase }, projects, sessions, { createDatabaseControlAuditHistory }] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/control/database-audit-history'),
  ]);
  await initDatabase();
  projects.registerProject('project-audit-one', '/projects/audit-one', 'Audit one');
  sessions.createSession(
    'source-session-one',
    'project-audit-one',
    'Source Session',
    'codex',
  );
  const history = createDatabaseControlAuditHistory({
    now: () => '2026-08-12T02:03:04.000Z',
  });
  const attempt = await history.begin({
    projectId: 'project-audit-one',
    sourceSessionId: 'source-session-one',
    operation: 'session.prompt',
    target: { kind: 'session', id: 'target-session-one' },
  });
  await history.complete(attempt.id, {
    target: { kind: 'session', id: 'target-session-one' },
    outcome: 'succeeded',
  });

  sessions.deleteSession('source-session-one');
  projects.removeProject('project-audit-one');

  assert.deepEqual((await history.list('project-audit-one')).map(withoutId), [{
    projectId: 'project-audit-one',
    sourceSessionId: 'source-session-one',
    operation: 'session.prompt',
    target: { kind: 'session', id: 'target-session-one' },
    occurredAt: '2026-08-12T02:03:04.000Z',
    outcome: 'succeeded',
  }]);
  assert.equal(projects.getProject('project-audit-one')?.visible, 0);
});

test('audit persistence is Project-scoped and cascades only on actual Project deletion', async () => {
  const [{ getDb }, projects, { createDatabaseControlAuditHistory }] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/control/database-audit-history'),
  ]);
  projects.registerProject('project-audit-two', '/projects/audit-two', 'Audit two');
  const history = createDatabaseControlAuditHistory();
  const attempt = await history.begin({
    projectId: 'project-audit-two',
    sourceSessionId: 'source-session-two',
    operation: 'worktree.create',
    target: { kind: 'project', id: 'project-audit-two' },
  });
  await history.complete(attempt.id, {
    target: { kind: 'project', id: 'project-audit-two' },
    outcome: 'failed',
    failureCode: 'WORKTREE_CREATE_FAILED',
  });

  assert.equal((await history.list('project-audit-one')).length, 1);
  assert.equal((await history.list('project-audit-two')).length, 1);

  getDb().prepare('DELETE FROM projects WHERE id = ?').run('project-audit-two');

  assert.deepEqual(await history.list('project-audit-two'), []);
  assert.equal((await history.list('project-audit-one')).length, 1);
});

test('audit persistence schema has no prompt or key-input content fields', async () => {
  const { getDb } = await import('@/lib/db/database');
  const columns = getDb().prepare('PRAGMA table_info(control_audit_history)').all() as Array<{
    name: string;
  }>;

  assert.deepEqual(columns.map((column) => column.name), [
    'id',
    'project_id',
    'source_session_id',
    'operation',
    'target_kind',
    'target_id',
    'occurred_at',
    'outcome',
    'failure_code',
  ]);
});

function withoutId<T extends { id: string }>(record: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = record;
  return rest;
}
