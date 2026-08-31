import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(path.join(tmpdir(), 'tessera-pr-revision-'));
process.env.TESSERA_DATA_DIR = dataDir;

test('task PR relation and knownness survive the database boundary', async () => {
  const database = await import('@/lib/db/database');
  const tasks = await import('@/lib/db/tasks');
  await database.initDatabase();

  tasks.createTask({
    id: 'task_pr_revision',
    projectId: 'project_pr_revision',
    title: 'PR revision',
    worktreeBranch: 'feature/pr-revision',
  });
  tasks.setTaskPrStatus('task_pr_revision', {
    unsupported: false,
    remoteBranchExists: true,
    prStatus: {
      number: 236,
      url: 'https://github.com/horang-labs/tessera/pull/236',
      state: 'merged',
      relation: 'historical',
      headRefOid: 'a'.repeat(40),
      lastSynced: '2026-08-09T00:00:00.000Z',
    },
  });

  const known = tasks.getTaskPrSyncContext('task_pr_revision');
  assert.equal(known?.prStatusKnown, true);
  assert.equal(known?.prStatus?.relation, 'historical');
  assert.equal(known?.prStatus?.headRefOid, 'a'.repeat(40));

  tasks.markTaskPrStatusUnknown('task_pr_revision');
  const unknown = tasks.getTaskPrSyncContext('task_pr_revision');
  assert.equal(unknown?.prStatusKnown, false);
  assert.equal(unknown?.prStatus?.number, 236, 'transient probes preserve display history');
  assert.equal(unknown?.prStatus?.relation, 'historical');
});
