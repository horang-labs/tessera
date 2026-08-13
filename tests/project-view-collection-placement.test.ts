import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-project-collections-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

test('Project projections keep valid Collections local and mask foreign placement', async () => {
  const [collections, database, persistence, projects, projection, sessions, tasks] = await Promise.all([
    import('@/lib/db/collections'),
    import('@/lib/db/database'),
    import('@/lib/session/session-persistence'),
    import('@/lib/db/projects'),
    import('@/lib/projects/project-view-projection'),
    import('@/lib/db/sessions'),
    import('@/lib/db/tasks'),
  ]);
  await database.initDatabase();

  const repository = path.join(testRoot, 'repository');
  fs.mkdirSync(repository, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Tessera Test'], { cwd: repository });
  fs.writeFileSync(path.join(repository, 'README.md'), 'project-local collections\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repository, stdio: 'ignore' });

  projects.registerProject('project-a', repository, 'Project A');
  projects.registerProject('project-c', repository, 'Project C');
  const projectWorktree = projects.getProjectWorktree('project-a');
  assert.ok(projectWorktree);
  collections.createCollection('collection-a', 'project-a', 'A Local', '#111111', 0);
  collections.createCollection('collection-c', 'project-c', 'C Local', '#222222', 0);
  tasks.createTask({
    id: 'linked-worktree',
    projectId: 'project-a',
    title: 'Linked Worktree',
    collectionId: 'collection-a',
    worktreeBranch: 'feature/linked',
    creationScope: { originWorktreeId: projectWorktree.id, branch: 'main' },
  });

  for (const [sessionId, projectId, collectionId] of [
    ['session-a', 'project-a', 'collection-a'],
    ['session-c', 'project-c', 'collection-c'],
  ] as const) {
    persistence.persistCreatedSessionRecord({
      sessionId,
      resolvedWorkDir: repository,
      parentProjectId: projectId,
      title: `Canonical ${sessionId}`,
      providerId: 'codex',
      executionMode: 'gui',
      collectionId,
    });
  }

  const placement = (projectId: string) =>
    projection.getProjectViewProjection(projectId).sessions
      .map((session) => [session.id, session.collection_id])
      .sort();

  assert.deepEqual(placement('project-a'), [
    ['session-a', 'collection-a'],
    ['session-c', null],
  ]);
  assert.deepEqual(placement('project-c'), [
    ['session-a', null],
    ['session-c', 'collection-c'],
  ]);
  assert.equal(
    projection.getProjectViewProjection('project-a').linkedWorktrees[0]?.collectionId,
    'collection-a',
  );
  assert.equal(
    projection.getProjectViewProjection('project-c').linkedWorktrees[0]?.collectionId,
    undefined,
  );
  assert.equal(
    projection.getProjectViewSessions('project-c').sessions
      .find((session) => session.id === 'session-a')?.collection_id,
    null,
  );
  assert.equal(
    projection.getProjectViewSessionsByStatus('project-c', 'chat').sessions
      .find((session) => session.id === 'session-a')?.collection_id,
    null,
  );

  collections.updateCollection('collection-a', { label: 'Renamed only in A', sort_order: 2 });
  assert.deepEqual(collections.getCollections('project-c').map(({ id, label, sort_order }) => ({
    id,
    label,
    sort_order,
  })), [{ id: 'collection-c', label: 'C Local', sort_order: 0 }]);
  assert.deepEqual(placement('project-c'), [
    ['session-a', null],
    ['session-c', 'collection-c'],
  ]);

  sessions.updateSession('session-a', { title: 'One global conversation' });
  assert.equal(
    projection.getProjectViewProjection('project-a').sessions
      .find((session) => session.id === 'session-a')?.title,
    'One global conversation',
  );
  assert.equal(
    projection.getProjectViewProjection('project-c').sessions
      .find((session) => session.id === 'session-a')?.title,
    'One global conversation',
  );

  collections.deleteCollection('collection-a');
  assert.equal(sessions.getSession('session-a')?.collection_id, null);
  assert.equal(sessions.getSession('session-c')?.collection_id, 'collection-c');
  assert.deepEqual(placement('project-c'), [
    ['session-a', null],
    ['session-c', 'collection-c'],
  ]);
});
