import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-linked-project-view-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

test.after(async () => {
  const { processManager } = await import('@/lib/cli/process-manager');
  await processManager.cleanup();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('a linked Worktree opens as an independent Project without changing canonical origins', async () => {
  const [database, projects, projection, sessions, persistence, tasks] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/projects/project-view-projection'),
    import('@/lib/db/sessions'),
    import('@/lib/session/session-persistence'),
    import('@/lib/db/tasks'),
  ]);
  await database.initDatabase();

  const rootAPath = path.join(testRoot, 'project-a');
  const linkedCPath = path.join(testRoot, 'project-c');
  const descendantDPath = path.join(testRoot, 'worktree-d');
  fs.mkdirSync(rootAPath, { recursive: true });
  git(rootAPath, ['init', '-b', 'main']);
  git(rootAPath, ['config', 'user.email', 'test@example.com']);
  git(rootAPath, ['config', 'user.name', 'Tessera Test']);
  fs.writeFileSync(path.join(rootAPath, 'README.md'), 'canonical project views\n');
  git(rootAPath, ['add', 'README.md']);
  git(rootAPath, ['commit', '-m', 'initial']);

  projects.registerProject('project-a', rootAPath, 'Project A');
  const rootA = projects.getProjectWorktree('project-a');
  assert.ok(rootA);

  git(rootAPath, ['worktree', 'add', '-b', 'feature/c', linkedCPath]);
  const linkedCWorktreeId = tasks.createTask({
    id: 'linked-c',
    projectId: 'project-a',
    title: 'Linked C',
    worktreeBranch: 'feature/c',
    worktreePath: linkedCPath,
    creationScope: { originWorktreeId: rootA.id, branch: 'main' },
    startPoint: 'HEAD',
  });
  persistence.persistCreatedSessionRecord({
    sessionId: 'session-c',
    resolvedWorkDir: linkedCPath,
    parentProjectId: 'project-a',
    taskId: 'linked-c',
    title: 'Canonical C Session',
    providerId: 'codex',
    executionMode: 'gui',
    worktreeBranch: 'feature/c',
  });

  projects.registerProject('project-c', linkedCPath, 'Project C');
  assert.equal(projects.getProjectWorktree('project-c')?.id, linkedCWorktreeId);
  persistence.persistCreatedSessionRecord({
    sessionId: 'direct-c-session',
    resolvedWorkDir: linkedCPath,
    parentProjectId: 'project-c',
    title: 'Created from Project C',
    providerId: 'codex',
    executionMode: 'gui',
  });

  const inA = projection.getProjectViewProjection('project-a');
  const inC = projection.getProjectViewProjection('project-c');
  assert.deepEqual(inA.linkedWorktrees.map((worktree) => worktree.id), ['linked-c']);
  assert.deepEqual(
    inA.linkedWorktrees[0].sessions.map((session) => [session.id, session.originProjectId]),
    [['direct-c-session', 'project-c'], ['session-c', 'project-a']],
  );
  assert.deepEqual(
    inC.sessions.map((session) => [session.id, session.originProjectId]).sort(),
    [['direct-c-session', 'project-c'], ['session-c', 'project-a']],
  );

  sessions.updateSession('session-c', { title: 'Renamed once' });
  const runningIds = new Set(['session-c']);
  const runningInA = projection.getProjectViewProjection('project-a', {
    activeSessionIds: runningIds,
  }).linkedWorktrees[0].sessions.find((session) => session.id === 'session-c');
  assert.deepEqual({ title: runningInA?.title, isRunning: runningInA?.isRunning }, {
    title: 'Renamed once',
    isRunning: true,
  });
  assert.equal(
    projection.getProjectViewProjection('project-c').sessions
      .find((session) => session.id === 'session-c')?.title,
    'Renamed once',
  );
  const { archiveSession } = await import('@/lib/session/session-archive');
  const archiveService = await import('@/lib/archive/archive-service');
  await archiveSession('session-c', true);
  assert.equal(
    projection.getProjectViewProjection('project-a').linkedWorktrees[0].sessions
      .some((session) => session.id === 'session-c'),
    false,
  );
  assert.equal(
    projection.getProjectViewProjection('project-c').sessions
      .some((session) => session.id === 'session-c'),
    false,
  );
  await archiveService.restoreArchivedChat('session-c');
  assert.equal(
    projection.getProjectViewProjection('project-a').linkedWorktrees[0].sessions
      .some((session) => session.id === 'session-c'),
    true,
  );
  assert.equal(
    projection.getProjectViewProjection('project-c').sessions
      .some((session) => session.id === 'session-c'),
    true,
  );

  persistence.persistCreatedSessionRecord({
    sessionId: 'session-c-delete',
    resolvedWorkDir: linkedCPath,
    parentProjectId: 'project-a',
    taskId: 'linked-c',
    title: 'Delete From Either View',
    providerId: 'claude-code',
    executionMode: 'gui',
    worktreeBranch: 'feature/c',
  });
  assert.ok(
    projection.getProjectViewProjection('project-a').linkedWorktrees[0].sessions
      .some((session) => session.id === 'session-c-delete'),
  );
  assert.ok(
    projection.getProjectViewProjection('project-c').sessions
      .some((session) => session.id === 'session-c-delete'),
  );
  const { sessionOrchestrator } = await import('@/lib/session/session-orchestrator');
  await sessionOrchestrator.deleteSession('projection-user', 'session-c-delete');
  assert.equal(
    projection.getProjectViewProjection('project-a').linkedWorktrees[0].sessions
      .some((session) => session.id === 'session-c-delete'),
    false,
  );
  assert.equal(
    projection.getProjectViewProjection('project-c').sessions
      .some((session) => session.id === 'session-c-delete'),
    false,
  );
  assert.equal(fs.existsSync(linkedCPath), true);

  git(rootAPath, ['worktree', 'add', '-b', 'feature/d', descendantDPath]);
  tasks.createTask({
    id: 'descendant-d',
    projectId: 'project-c',
    title: 'Descendant D',
    worktreeBranch: 'feature/d',
    worktreePath: descendantDPath,
    creationScope: { originWorktreeId: linkedCWorktreeId, branch: 'feature/c' },
    startPoint: 'HEAD',
  });
  assert.deepEqual(
    projection.getProjectViewProjection('project-c').linkedWorktrees.map((worktree) => worktree.id),
    ['descendant-d'],
  );
  assert.deepEqual(
    projection.getProjectViewProjection('project-a').linkedWorktrees.map((worktree) => worktree.id),
    ['linked-c'],
  );

  projects.removeProject('project-c');
  assert.equal(sessions.getSession('session-c')?.project_id, 'project-a');
  assert.deepEqual(
    projection.getProjectViewProjection('project-a').linkedWorktrees[0].sessions.map((session) => session.id),
    ['direct-c-session', 'session-c'],
  );
  projects.registerProject('project-c', linkedCPath, 'Project C');
  projects.removeProject('project-a');
  assert.deepEqual(
    projection.getProjectViewProjection('project-c').sessions.map((session) => session.id).sort(),
    ['direct-c-session', 'session-c'],
  );
});
