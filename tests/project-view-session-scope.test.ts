import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-project-session-scope-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

type Modules = {
  database: typeof import('../src/lib/db/database');
  persistence: typeof import('../src/lib/session/session-persistence');
  projects: typeof import('../src/lib/db/projects');
  projection: typeof import('../src/lib/projects/project-view-projection');
  sessions: typeof import('../src/lib/db/sessions');
};

let loaded: Promise<Modules> | null = null;
function modules(): Promise<Modules> {
  loaded ??= (async () => {
    const [database, persistence, projects, projection, sessions] = await Promise.all([
      import('../src/lib/db/database'),
      import('../src/lib/session/session-persistence'),
      import('../src/lib/db/projects'),
      import('../src/lib/projects/project-view-projection'),
      import('../src/lib/db/sessions'),
    ]);
    await database.initDatabase();
    return { database, persistence, projects, projection, sessions };
  })();
  return loaded;
}

function createRepository(name = 'repository'): string {
  const repository = path.join(testRoot, name);
  fs.mkdirSync(repository, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Tessera Test'], { cwd: repository });
  fs.writeFileSync(path.join(repository, 'README.md'), 'session scope\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repository, stdio: 'ignore' });
  return repository;
}

test('Project View Projection scopes direct Sessions without destroying hidden history', async () => {
  const { database, persistence, projects, projection, sessions } = await modules();
  const repository = createRepository();
  projects.registerProject('project-view', repository, 'Project View');
  const projectWorktree = projects.getProjectWorktree('project-view');
  assert.ok(projectWorktree);

  persistence.persistCreatedSessionRecord({
    sessionId: 'main-session',
    resolvedWorkDir: repository,
    parentProjectId: 'project-view',
    title: 'Main conversation',
    providerId: 'codex',
    executionMode: 'gui',
    providerState: JSON.stringify({ threadId: 'canonical-thread' }),
  });
  sessions.createSession('legacy-session', 'project-view', 'Legacy conversation', 'codex', {
    workDir: repository,
    worktreeId: projectWorktree.id,
    scopeBranch: null,
  });
  const now = new Date().toISOString();
  database.getDb().prepare(`
    INSERT INTO sessions (
      id, project_id, title, provider, work_dir, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'ownership-only-session',
    'project-view',
    'Obsolete ownership',
    'codex',
    repository,
    now,
    now,
  );

  const storedMain = sessions.getSession('main-session');
  assert.equal(storedMain?.worktree_id, projectWorktree.id);
  assert.equal(storedMain?.scope_branch, 'main');
  assert.deepEqual(
    projection.getProjectViewProjection('project-view').sessions.map((session) => session.id).sort(),
    ['legacy-session', 'main-session'],
  );

  execFileSync('git', ['checkout', '-b', 'feature/session-scope'], {
    cwd: repository,
    stdio: 'ignore',
  });
  assert.deepEqual(
    projection.getProjectViewProjection('project-view').sessions.map((session) => session.id),
    ['legacy-session'],
  );
  assert.equal(sessions.getSession('main-session')?.provider_state, JSON.stringify({
    threadId: 'canonical-thread',
  }));

  persistence.persistCreatedSessionRecord({
    sessionId: 'feature-session',
    resolvedWorkDir: repository,
    parentProjectId: 'project-view',
    title: 'Feature conversation',
    providerId: 'codex',
    executionMode: 'gui',
  });
  assert.deepEqual(
    projection.getProjectViewProjection('project-view').sessions.map((session) => session.id).sort(),
    ['feature-session', 'legacy-session', 'ownership-only-session'],
  );

  execFileSync('git', ['checkout', 'main'], { cwd: repository, stdio: 'ignore' });
  assert.deepEqual(
    projection.getProjectViewProjection('project-view').sessions.map((session) => session.id).sort(),
    ['legacy-session', 'main-session', 'ownership-only-session'],
  );
  assert.equal(sessions.getSession('feature-session')?.scope_branch, 'feature/session-scope');
});

test('Project View pagination does not skip equal project-local sort orders', async () => {
  const { persistence, projects, projection } = await modules();
  const repository = createRepository('pagination-repository');
  projects.registerProject('pagination-view-a', repository, 'Pagination A');
  projects.registerProject('pagination-view-b', repository, 'Pagination B');

  for (const [sessionId, projectId] of [
    ['pagination-session-a', 'pagination-view-a'],
    ['pagination-session-b', 'pagination-view-b'],
  ] as const) {
    persistence.persistCreatedSessionRecord({
      sessionId,
      resolvedWorkDir: repository,
      parentProjectId: projectId,
      title: sessionId,
      providerId: 'codex',
      executionMode: 'gui',
    });
  }

  const firstPage = projection.getProjectViewSessions('pagination-view-a', { limit: 1 });
  assert.equal(firstPage.sessions.length, 1);
  assert.ok(firstPage.nextCursor);

  const secondPage = projection.getProjectViewSessions('pagination-view-a', {
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.sessions.length, 1);
  assert.notEqual(secondPage.sessions[0].id, firstPage.sessions[0].id);

  const grouped = projection.getProjectViewProjection('pagination-view-a', {
    limitPerStatus: 1,
  });
  assert.ok(grouped.cursorByStatus.chat);
  const secondStatusPage = projection.getProjectViewSessionsByStatus(
    'pagination-view-a',
    'chat',
    { limit: 1, cursor: grouped.cursorByStatus.chat },
  );
  assert.equal(secondStatusPage.sessions.length, 1);
  assert.notEqual(secondStatusPage.sessions[0].id, grouped.sessions[0].id);
});
