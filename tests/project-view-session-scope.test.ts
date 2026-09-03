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

test('Project View projects root Sessions by folder and filters immutable creation branches', async () => {
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
  assert.equal(sessions.getSession('ownership-only-session')?.worktree_id, null);

  execFileSync('git', ['checkout', '-b', 'feature/session-scope'], {
    cwd: repository,
    stdio: 'ignore',
  });
  assert.deepEqual(
    projection.getProjectViewProjection('project-view').sessions.map((session) => session.id).sort(),
    ['legacy-session', 'main-session'],
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
    ['feature-session', 'legacy-session', 'main-session', 'ownership-only-session'],
  );

  assert.deepEqual(
    projection.getProjectViewProjection('project-view', { creationBranch: 'main' })
      .sessions.map((session) => session.id),
    ['main-session'],
  );
  assert.deepEqual(
    projection.getProjectViewProjection('project-view', { creationBranch: 'feature/session-scope' })
      .sessions.map((session) => session.id),
    ['feature-session'],
  );
  assert.deepEqual(
    projection.getProjectViewCreationBranches('project-view'),
    ['feature/session-scope', 'main'],
  );

  execFileSync('git', ['checkout', 'main'], { cwd: repository, stdio: 'ignore' });
  assert.deepEqual(
    projection.getProjectViewProjection('project-view').sessions.map((session) => session.id).sort(),
    ['feature-session', 'legacy-session', 'main-session', 'ownership-only-session'],
  );
  assert.equal(sessions.getSession('feature-session')?.scope_branch, 'feature/session-scope');
  execFileSync('git', ['branch', '-D', 'feature/session-scope'], { cwd: repository, stdio: 'ignore' });
  assert.deepEqual(
    projection.getProjectViewProjection('project-view', { creationBranch: 'feature/session-scope' })
      .sessions.map((session) => session.id),
    ['feature-session'],
  );
});

test('Project View creation-branch filtering covers Worktree parents without changing child scoping', async () => {
  const { database, projects, projection, sessions } = await modules();
  const repository = createRepository('worktree-filter-repository');
  projects.registerProject('worktree-filter-project', repository, 'Worktree filter');
  const root = projects.getProjectWorktree('worktree-filter-project');
  assert.ok(root);
  const now = new Date().toISOString();
  for (const [id, branch] of [['task-a', 'branch-a'], ['task-b', 'branch-b']] as const) {
    database.getDb().prepare(`
      INSERT INTO tasks (
        id, public_worktree_id, project_id, title, workflow_status,
        creation_scope_worktree_id, creation_scope_branch, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?)
    `).run(id, `wt_${id}`, 'worktree-filter-project', id, root.id, branch, now, now);
  }
  database.getDb().prepare(`
    INSERT INTO sessions (
      id, project_id, title, provider, task_id, worktree_id, scope_branch, created_at, updated_at
    ) VALUES ('task-a-child', 'worktree-filter-project', 'Child A', 'codex', 'task-a', 'wt_task-a', 'other', ?, ?)
  `).run(now, now);
  assert.deepEqual(
    projection.getProjectViewProjection('worktree-filter-project').linkedWorktrees.map((task) => task.id).sort(),
    ['task-a', 'task-b'],
  );
  assert.deepEqual(
    projection.getProjectViewProjection('worktree-filter-project', { creationBranch: 'branch-a' })
      .linkedWorktrees.map((task) => task.id),
    ['task-a'],
  );
  // Child sessions remain scoped to the child Worktree's own current branch.
  assert.deepEqual(
    projection.getProjectViewProjection('worktree-filter-project', { creationBranch: 'branch-a' })
      .linkedWorktrees[0]?.sessions,
    [],
  );
  assert.deepEqual(
    projection.getProjectViewCreationBranches('worktree-filter-project'),
    ['branch-a', 'branch-b'],
  );
  assert.equal(sessions.getSession('task-a-child')?.scope_branch, 'other');
});

test('direct Sessions reuse canonical Project membership when the stored root uses agent path spelling', async () => {
  const { database, persistence, projects, projection, sessions } = await modules();
  const repository = createRepository('bridged-root-repository');
  projects.registerProject('host-canonical-project', repository, 'Host canonical project');
  const projectWorktree = projects.getProjectWorktree('host-canonical-project');
  assert.ok(projectWorktree);

  const reportedProjectId = '/home/work/bridged-root-that-does-not-exist';
  const now = new Date().toISOString();
  database.getDb().prepare(`
    INSERT INTO projects (
      id, decoded_path, display_name, provider, visible, sort_order,
      project_worktree_id, registered_at, updated_at
    ) VALUES (?, ?, ?, NULL, 1, 0, ?, ?, ?)
  `).run(
    reportedProjectId,
    reportedProjectId,
    'Bridged root project',
    projectWorktree.id,
    now,
    now,
  );

  database.getDb().prepare(`
    INSERT INTO sessions (
      id, project_id, title, provider, work_dir, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-bridged-root-session',
    reportedProjectId,
    'Legacy bridged root conversation',
    'codex',
    reportedProjectId,
    now,
    now,
  );
  database.getDb().prepare(`
    INSERT INTO sessions (
      id, project_id, title, provider, work_dir, scope_branch, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-bridged-historical-session',
    reportedProjectId,
    'Historical bridged root conversation',
    'codex',
    reportedProjectId,
    'deleted/historical',
    now,
    now,
  );

  assert.equal(sessions.getSession('legacy-bridged-root-session')?.worktree_id, null);
  const fallbackWhere = sessions.buildProjectViewWhere({
    kind: 'canonical-worktree',
    worktreeId: projectWorktree.id,
    currentBranch: 'main',
    projectRootFallback: {
      projectId: reportedProjectId,
      workDir: reportedProjectId,
    },
  });
  const queryPlan = database.getDb().prepare(`
    EXPLAIN QUERY PLAN
    SELECT s.id FROM sessions s WHERE ${fallbackWhere.sql}
  `).all(...fallbackWhere.params) as Array<{ detail: string }>;
  const queryPlanDetails = queryPlan.map((row) => row.detail).join('\n');
  assert.match(queryPlanDetails, /idx_sessions_worktree_scope/);
  assert.match(queryPlanDetails, /idx_sessions_project_updated/);
  assert.doesNotMatch(queryPlanDetails, /SCAN (canonical|project_root)/);
  assert.deepEqual(
    projection.getProjectViewProjection(reportedProjectId).sessions.map((session) => session.id),
    ['legacy-bridged-historical-session', 'legacy-bridged-root-session'],
  );
  assert.deepEqual(
    projection.getProjectViewCreationBranches(reportedProjectId),
    ['deleted/historical'],
  );
  assert.deepEqual(
    projection.getProjectViewProjection(reportedProjectId, { creationBranch: 'deleted/historical' })
      .sessions.map((session) => session.id),
    ['legacy-bridged-historical-session'],
  );

  persistence.persistCreatedSessionRecord({
    sessionId: 'bridged-root-session',
    resolvedWorkDir: reportedProjectId,
    parentProjectId: reportedProjectId,
    title: 'Bridged root conversation',
    providerId: 'codex',
    executionMode: 'gui',
  });

  const stored = sessions.getSession('bridged-root-session');
  assert.equal(stored?.worktree_id, projectWorktree.id);
  assert.equal(stored?.scope_branch, 'main');
  assert.deepEqual(
    projection.getProjectViewProjection(reportedProjectId).sessions.map((session) => session.id).sort(),
    ['bridged-root-session', 'legacy-bridged-historical-session', 'legacy-bridged-root-session'],
  );

  persistence.persistCreatedSessionRecord({
    sessionId: 'taskless-linked-session',
    resolvedWorkDir: '/home/work/different-linked-checkout',
    parentProjectId: reportedProjectId,
    title: 'Taskless linked conversation',
    providerId: 'codex',
    executionMode: 'gui',
  });

  assert.equal(sessions.getSession('taskless-linked-session')?.worktree_id, null);
  assert.deepEqual(
    projection.getProjectViewProjection(reportedProjectId).sessions.map((session) => session.id).sort(),
    ['bridged-root-session', 'legacy-bridged-historical-session', 'legacy-bridged-root-session'],
  );
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

test('creation-branch filtering applies before status counts and cursor pagination', async () => {
  const { database, projects, projection, sessions } = await modules();
  const repository = createRepository('filtered-pagination-repository');
  projects.registerProject('filtered-pagination-project', repository, 'Filtered pagination');
  const root = projects.getProjectWorktree('filtered-pagination-project');
  assert.ok(root);
  for (const id of ['branch-a-one', 'branch-a-two', 'branch-b-one']) {
    sessions.createSession(id, 'filtered-pagination-project', id, 'codex', {
      workDir: repository,
      worktreeId: root.id,
      scopeBranch: id.startsWith('branch-a') ? 'branch-a' : 'branch-b',
    });
  }
  database.getDb().prepare(`
    UPDATE sessions SET chat_workflow_status = 'doing' WHERE id = 'branch-a-two'
  `).run();

  const grouped = projection.getProjectViewProjection('filtered-pagination-project', {
    creationBranch: 'branch-a',
    limitPerStatus: 1,
  });
  assert.equal(grouped.totalCount, 2);
  assert.deepEqual(grouped.countByStatus, { chat: 1, doing: 1 });
  const firstPage = projection.getProjectViewSessions('filtered-pagination-project', {
    creationBranch: 'branch-a',
    limit: 1,
  });
  assert.equal(firstPage.totalCount, 2);
  assert.ok(firstPage.nextCursor);
  const secondPage = projection.getProjectViewSessions('filtered-pagination-project', {
    creationBranch: 'branch-a',
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.totalCount, 2);
  assert.equal(secondPage.sessions[0]?.scope_branch, 'branch-a');
  assert.notEqual(secondPage.sessions[0]?.id, firstPage.sessions[0]?.id);
});
