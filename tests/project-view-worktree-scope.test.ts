import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-project-worktree-scope-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function createRepository(): string {
  const repository = path.join(testRoot, 'repository');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'test@example.com']);
  git(repository, ['config', 'user.name', 'Tessera Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'main\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'main']);
  git(repository, ['checkout', '-b', 'start-elsewhere']);
  fs.writeFileSync(path.join(repository, 'start.txt'), 'elsewhere\n');
  git(repository, ['add', 'start.txt']);
  git(repository, ['commit', '-m', 'alternate start']);
  git(repository, ['checkout', 'main']);
  git(repository, ['branch', 'existing-worktree']);
  git(repository, ['branch', 'legacy-worktree']);
  return repository;
}

test('Project View projects folder-owned Worktrees independently from Start Point', async () => {
  const [database, projects, projection, worktreeSource, worktrees, tasks, sessions, persistence] =
    await Promise.all([
      import('@/lib/db/database'),
      import('@/lib/db/projects'),
      import('@/lib/projects/project-view-projection'),
      import('@/lib/control/database-worktree-source'),
      import('@/lib/worktrees/create'),
      import('@/lib/db/tasks'),
      import('@/lib/db/sessions'),
      import('@/lib/session/session-persistence'),
    ]);
  await database.initDatabase();
  const { createGitRunner } = await import('@/lib/worktrees/git-runner');
  const runGit = createGitRunner('wsl');
  const repository = createRepository();
  projects.registerProject('project-a', repository, 'Project A');
  const rootA = projects.getProjectWorktree('project-a');
  assert.ok(rootA);

  const createScopedWorktree = async (input: {
    projectId: string;
    projectDir: string;
    path: string;
    branch: string;
    source: Parameters<typeof worktrees.createGitWorktree>[0]['source'];
    originWorktreeId: string;
    originBranch: string;
    startPoint: string;
    title: string;
  }) => {
    await worktrees.createGitWorktree({
      projectDir: input.projectDir,
      worktreePath: input.path,
      branchName: input.branch,
      source: input.source,
      runGit,
    });
    return worktreeSource.persistDatabaseControlWorktree({
      projectId: input.projectId,
      title: input.title,
      branch: input.branch,
      filesystemPath: input.path,
      creationScope: {
        originWorktreeId: input.originWorktreeId,
        branch: input.originBranch,
      },
      startPoint: input.startPoint,
    });
  };

  const linkedPath = path.join(testRoot, 'linked-c');
  const linked = await createScopedWorktree({
    projectId: 'project-a',
    projectDir: repository,
    path: linkedPath,
    branch: 'feature/c',
    source: { mode: 'branch-off', baseRef: 'start-elsewhere' },
    originWorktreeId: rootA.id,
    originBranch: 'main',
    startPoint: 'start-elsewhere',
    title: 'Linked C',
  });
  persistence.persistCreatedSessionRecord({
    sessionId: 'linked-session',
    resolvedWorkDir: linkedPath,
    parentProjectId: 'project-a',
    taskId: linked.taskId,
    title: 'Canonical C session',
    providerId: 'codex',
    executionMode: 'gui',
    worktreeBranch: 'feature/c',
  });

  projects.registerProject('project-c', linkedPath, 'Project C');
  const rootC = projects.getProjectWorktree('project-c');
  assert.equal(rootC?.id, linked.worktree.worktreeId);
  persistence.persistCreatedSessionRecord({
    sessionId: 'direct-c-session',
    resolvedWorkDir: linkedPath,
    parentProjectId: 'project-c',
    title: 'Direct C session',
    providerId: 'codex',
    executionMode: 'gui',
  });
  sessions.createSession('mismatched-linked-session', 'project-a', 'Mismatched C session', 'codex', {
    workDir: linkedPath,
    worktreeId: rootC!.id,
    taskId: linked.taskId,
    scopeBranch: 'not-feature/c',
  });

  await createScopedWorktree({
    projectId: 'project-c',
    projectDir: linkedPath,
    path: path.join(testRoot, 'descendant-d'),
    branch: 'feature/d',
    source: { mode: 'branch-off', baseRef: 'HEAD' },
    originWorktreeId: rootC!.id,
    originBranch: 'feature/c',
    startPoint: 'HEAD',
    title: 'Descendant D',
  });
  await createScopedWorktree({
    projectId: 'project-a',
    projectDir: repository,
    path: path.join(testRoot, 'existing'),
    branch: 'existing-worktree',
    source: { mode: 'checkout-branch', branch: 'existing-worktree' },
    originWorktreeId: rootA.id,
    originBranch: 'main',
    startPoint: 'existing-worktree',
    title: 'Existing branch',
  });
  await worktrees.createGitWorktree({
    projectDir: repository,
    worktreePath: path.join(testRoot, 'legacy'),
    branchName: 'legacy-worktree',
    source: { mode: 'checkout-branch', branch: 'legacy-worktree' },
    runGit,
  });
  tasks.createTask({
    id: 'legacy-task',
    projectId: 'project-a',
    title: 'Legacy Worktree',
    worktreeBranch: 'legacy-worktree',
    worktreePath: path.join(testRoot, 'legacy'),
    creationScope: { originWorktreeId: rootA.id, branch: null },
  });
  const now = new Date().toISOString();
  database.getDb().prepare(`
    INSERT INTO tasks (
      id, public_worktree_id, project_id, title, workflow_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'todo', ?, ?)
  `).run(
    'ownership-only-task',
    'wt_ownership_only',
    'project-a',
    'Obsolete ownership',
    now,
    now,
  );

  const projectA = projection.getProjectViewProjection('project-a');
  assert.deepEqual(projectA.linkedWorktrees.map((item) => item.title), [
    'Legacy Worktree',
    'Existing branch',
    'Linked C',
  ]);
  assert.deepEqual(
    projectA.linkedWorktrees.find((item) => item.title === 'Legacy Worktree')?.creationScope,
    { originWorktreeId: rootA.id, branch: null },
  );
  const projectedC = projectA.linkedWorktrees.find((item) => item.title === 'Linked C');
  assert.deepEqual(projectedC?.creationScope, { originWorktreeId: rootA.id, branch: 'main' });
  assert.equal(projectedC?.startPoint, 'start-elsewhere');
  assert.throws(() => database.getDb().prepare(`
    UPDATE tasks SET start_point = 'changed' WHERE id = ?
  `).run(linked.taskId), /Worktree Start Point is immutable/);
  assert.throws(() => database.getDb().prepare(`
    UPDATE tasks SET creation_scope_branch = 'changed' WHERE id = ?
  `).run(linked.taskId), /Worktree Creation Scope is immutable/);
  assert.deepEqual(projectedC?.sessions.map((session) => session.id).sort(), [
    'direct-c-session',
    'linked-session',
  ]);
  assert.deepEqual(
    projection.getProjectViewProjection('project-c').sessions.map((session) => session.id).sort(),
    ['direct-c-session', 'linked-session'],
  );
  assert.equal(
    projection.getProjectViewProjection('project-c').sessions.some(
      (session) => session.id === 'mismatched-linked-session',
    ),
    false,
  );
  assert.deepEqual(
    projection.getProjectViewProjection('project-c').linkedWorktrees.map((item) => item.title),
    ['Descendant D'],
  );

  git(repository, ['checkout', '-b', 'other']);
  assert.deepEqual(
    projection.getProjectViewProjection('project-a').linkedWorktrees.map((item) => item.title),
    ['Legacy Worktree', 'Existing branch', 'Linked C'],
  );
  assert.deepEqual(
    projection.getProjectViewProjection('project-a', { creationBranch: 'main' })
      .linkedWorktrees.map((item) => item.title),
    ['Existing branch', 'Linked C'],
  );
  assert.ok(sessions.getSession('direct-c-session'));
  git(repository, ['checkout', 'main']);
  assert.deepEqual(
    projection.getProjectViewProjection('project-a').linkedWorktrees.map((item) => item.title),
    ['Legacy Worktree', 'Existing branch', 'Linked C'],
  );
});
