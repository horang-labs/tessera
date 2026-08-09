import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-parent-worktree-authority-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

type Modules = {
  database: typeof import('@/lib/db/database');
  projects: typeof import('@/lib/db/projects');
  sessions: typeof import('@/lib/db/sessions');
  taskPreparation: typeof import('@/lib/db/task-preparation');
  tasks: typeof import('@/lib/db/tasks');
};

let loaded: Promise<Modules> | null = null;
function modules(): Promise<Modules> {
  loaded ??= (async () => {
    const [database, projects, sessions, taskPreparation, tasks] = await Promise.all([
      import('@/lib/db/database'),
      import('@/lib/db/projects'),
      import('@/lib/db/sessions'),
      import('@/lib/db/task-preparation'),
      import('@/lib/db/tasks'),
    ]);
    await database.initDatabase();
    return { database, projects, sessions, taskPreparation, tasks };
  })();
  return loaded;
}

test.after(async () => {
  const { processManager } = await import('@/lib/cli/process-manager');
  await processManager.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('preparation and reverse lookup use the parent path before the legacy child fallback', async () => {
  const { sessions, taskPreparation, tasks } = await modules();
  const parentPath = path.join(dataDir, 'parent-owned');
  const staleChildPath = path.join(dataDir, 'stale-child');

  tasks.createTask({ id: 'parent-task', projectId: dataDir, title: 'Parent task' });
  sessions.createSession('stale-child', dataDir, 'Stale child', 'codex', {
    taskId: 'parent-task',
    workDir: staleChildPath,
  });
  tasks.setTaskWorktreeCheckout('parent-task', {
    branch: 'feature/parent',
    path: parentPath,
  });

  assert.equal(taskPreparation.getTaskPreparationContext('parent-task')?.worktreePath, parentPath);
  assert.equal(tasks.findTaskIdForWorktree(parentPath), 'parent-task');
  assert.equal(tasks.findTaskIdForWorktree(staleChildPath), null);
  assert.deepEqual(sessions.getSessionWorktreeContext('stale-child'), {
    taskId: 'parent-task',
    workDir: parentPath,
    worktreeBranch: 'feature/parent',
    worktreeManaged: true,
  });
  const { resolveSessionWorkspaceRoot } = await import('@/lib/session/session-workspace-root');
  assert.equal(resolveSessionWorkspaceRoot('stale-child'), parentPath);

  const legacyPath = path.join(dataDir, 'legacy-child');
  tasks.createTask({ id: 'legacy-task', projectId: dataDir, title: 'Legacy task' });
  sessions.createSession('legacy-child', dataDir, 'Legacy child', 'claude-code', {
    taskId: 'legacy-task',
    workDir: legacyPath,
  });

  assert.equal(taskPreparation.getTaskPreparationContext('legacy-task')?.worktreePath, legacyPath);
  assert.equal(tasks.findTaskIdForWorktree(legacyPath), 'legacy-task');
  assert.deepEqual(sessions.getSessionWorktreeContext('legacy-child'), {
    taskId: 'legacy-task',
    workDir: legacyPath,
    worktreeBranch: null,
    worktreeManaged: false,
  });
  assert.equal(resolveSessionWorkspaceRoot('legacy-child'), legacyPath);

  const legacyNewerPath = path.join(dataDir, 'legacy-newer-child');
  sessions.createSession('legacy-newer-child', dataDir, 'Legacy newer child', 'codex', {
    taskId: 'legacy-task',
    workDir: legacyNewerPath,
  });
  const db = (await modules()).database.getDb();
  db.prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?')
    .run('2026-08-03T00:00:00.000Z', '2026-08-03T02:00:00.000Z', 'legacy-child');
  db.prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?')
    .run('2026-08-03T01:00:00.000Z', '2026-08-03T03:00:00.000Z', 'legacy-newer-child');
  sessions.createSession('legacy-blank-child', dataDir, 'Legacy blank child', 'codex', {
    taskId: 'legacy-task',
    workDir: '   ',
  });
  db.prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?')
    .run('2026-08-02T00:00:00.000Z', '2026-08-04T00:00:00.000Z', 'legacy-blank-child');
  assert.equal(tasks.getTask('legacy-task')?.workDir, legacyPath);

  const spacedPath = path.join(dataDir, 'checkout-with-trailing-space ');
  tasks.createTask({ id: 'spaced-path-task', projectId: dataDir, title: 'Spaced path' });
  tasks.setTaskWorktreeCheckout('spaced-path-task', {
    branch: 'feature/spaced-path',
    path: spacedPath,
  });
  assert.equal(taskPreparation.getTaskPreparationContext('spaced-path-task')?.worktreePath, spacedPath);
  assert.equal(tasks.findTaskIdForWorktree(spacedPath), 'spaced-path-task');
});

test('PR observation uses parent paths for zero-session Worktrees and legacy fallback only when needed', async () => {
  const { sessions, tasks } = await modules();
  const parentPath = path.join(dataDir, 'pr-parent-owned');
  const staleChildPath = path.join(dataDir, 'pr-stale-child');

  tasks.createTask({
    id: 'pr-parent-task',
    projectId: dataDir,
    title: 'PR parent task',
    worktreeBranch: 'feature/pr-parent',
  });
  sessions.createSession('pr-stale-child', dataDir, 'PR stale child', 'codex', {
    taskId: 'pr-parent-task',
    workDir: staleChildPath,
  });
  tasks.setTaskWorktreeCheckout('pr-parent-task', {
    branch: 'feature/pr-parent',
    path: parentPath,
  });

  assert.equal(tasks.getTaskPrSyncContext('pr-parent-task')?.workDir, parentPath);
  assert.equal(
    tasks.getTasksEligibleForPrSync().find((task) => task.id === 'pr-parent-task')?.work_dir,
    parentPath,
  );

  const zeroSessionPath = path.join(dataDir, 'pr-zero-session');
  tasks.createTask({
    id: 'pr-zero-session',
    projectId: dataDir,
    title: 'PR zero session',
    worktreeBranch: 'feature/pr-zero',
  });
  tasks.setTaskWorktreeCheckout('pr-zero-session', {
    branch: 'feature/pr-zero',
    path: zeroSessionPath,
  });

  assert.equal(tasks.getTaskPrSyncContext('pr-zero-session')?.workDir, zeroSessionPath);
  assert.equal(
    tasks.getTasksEligibleForPrSync().find((task) => task.id === 'pr-zero-session')?.work_dir,
    zeroSessionPath,
  );

  const legacyPath = path.join(dataDir, 'pr-legacy-child');
  tasks.createTask({
    id: 'pr-legacy-task',
    projectId: dataDir,
    title: 'PR legacy task',
    worktreeBranch: 'feature/pr-legacy',
  });
  sessions.createSession('pr-legacy-child', dataDir, 'PR legacy child', 'claude-code', {
    taskId: 'pr-legacy-task',
    workDir: legacyPath,
  });

  assert.equal(tasks.getTaskPrSyncContext('pr-legacy-task')?.workDir, legacyPath);
});

test('creating a child Session copies the parent checkout compatibility fields', async () => {
  const { sessions, tasks } = await modules();
  const parentPath = path.join(dataDir, 'child-parent-owned ');

  tasks.createTask({ id: 'child-parent', projectId: dataDir, title: 'Child parent' });
  tasks.setTaskWorktreeCheckout('child-parent', {
    branch: 'feature/child-parent',
    path: parentPath,
  });

  sessions.createSession('created-child', dataDir, 'Created child', 'codex', {
    taskId: 'child-parent',
    workDir: path.join(dataDir, 'caller-stale-path'),
    worktreeManaged: false,
  });
  assert.deepEqual(
    {
      workDir: sessions.getSession('created-child')?.work_dir,
      branch: sessions.getSession('created-child')?.worktree_branch,
      managed: sessions.getSession('created-child')?.worktree_managed,
    },
    {
      workDir: parentPath,
      branch: 'feature/child-parent',
      managed: 1,
    },
  );
});

test('archive status and retention metadata use a zero-session parent checkout', async () => {
  const { sessions, tasks } = await modules();
  const archiveService = await import('@/lib/archive/archive-service');
  const worktreePath = path.join(dataDir, 'archived-zero-session');
  fs.mkdirSync(worktreePath, { recursive: true });

  tasks.createTask({ id: 'archived-zero-session', projectId: dataDir, title: 'Archived zero' });
  tasks.setTaskWorktreeCheckout('archived-zero-session', {
    branch: 'feature/archived-zero',
    path: worktreePath,
  });
  tasks.setTaskArchived('archived-zero-session', true);

  const { items } = await archiveService.listArchiveItems({ projectId: dataDir, kind: 'task' });
  const item = items.find((entry) => entry.id === 'archived-zero-session');
  assert.ok(item);
  assert.equal(item.workDir, worktreePath);
  assert.equal(item.worktreeStatus, 'present');
  assert.equal(item.worktreeManaged, true);
  assert.equal(item.canRestore, true);
  assert.deepEqual(item.sessions, []);

  const legacyPath = path.join(dataDir, 'archived-legacy-child');
  fs.mkdirSync(legacyPath, { recursive: true });
  tasks.createTask({ id: 'archived-legacy-task', projectId: dataDir, title: 'Archived legacy' });
  sessions.createSession('archived-legacy-child', dataDir, 'Archived legacy child', 'codex', {
    taskId: 'archived-legacy-task',
    workDir: legacyPath,
    worktreeManaged: true,
  });
  tasks.setTaskArchived('archived-legacy-task', true);
  const legacyItems = await archiveService.listArchiveItems({ projectId: dataDir, kind: 'task' });
  const legacyItem = legacyItems.items.find((entry) => entry.id === 'archived-legacy-task');
  assert.ok(legacyItem);
  assert.equal(legacyItem.workDir, legacyPath);
  assert.equal(legacyItem.worktreeStatus, 'present');
});

test('deleting the last child Session leaves its parent Worktree checkout intact', async () => {
  const { projects, sessions, tasks } = await modules();
  const { sessionOrchestrator } = await import('@/lib/session/session-orchestrator');
  const sourcePath = path.join(dataDir, 'delete-source');
  const worktreePath = path.join(dataDir, 'delete-parent-worktree');
  fs.mkdirSync(sourcePath, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: sourcePath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourcePath });
  execFileSync('git', ['config', 'user.name', 'Tessera Test'], { cwd: sourcePath });
  fs.writeFileSync(path.join(sourcePath, 'base.txt'), 'base\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: sourcePath });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: sourcePath, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '-b', 'feature/delete-parent', worktreePath], {
    cwd: sourcePath,
    stdio: 'ignore',
  });

  projects.registerProject(sourcePath, sourcePath, 'delete-source');
  tasks.createTask({ id: 'delete-parent-task', projectId: sourcePath, title: 'Delete parent' });
  tasks.setTaskWorktreeCheckout('delete-parent-task', {
    branch: 'feature/delete-parent',
    path: worktreePath,
  });
  sessions.createSession('delete-last-child', sourcePath, 'Delete last child', 'claude-code', {
    taskId: 'delete-parent-task',
    workDir: worktreePath,
    worktreeManaged: true,
  });

  const { archiveSession } = await import('@/lib/session/session-archive');
  const { restoreArchivedChat } = await import('@/lib/archive/archive-service');
  await archiveSession('delete-last-child', true);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.deepEqual(tasks.getTask('delete-parent-task')?.sessions, []);
  assert.equal(tasks.getTask('delete-parent-task')?.workDir, worktreePath);
  await restoreArchivedChat('delete-last-child');

  await sessionOrchestrator.deleteSession('delete-user', 'delete-last-child');

  assert.equal(fs.existsSync(worktreePath), true);
  assert.deepEqual(tasks.getTask('delete-parent-task')?.sessions, []);
  assert.equal(tasks.getTask('delete-parent-task')?.workDir, worktreePath);
});

test('deleting the final standalone Session leaves its managed Worktree checkout intact', async () => {
  const { projects, sessions } = await modules();
  const { sessionOrchestrator } = await import('@/lib/session/session-orchestrator');
  const sourcePath = path.join(dataDir, 'delete-standalone-source');
  const worktreePath = path.join(dataDir, 'delete-standalone-worktree');
  fs.mkdirSync(sourcePath, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: sourcePath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourcePath });
  execFileSync('git', ['config', 'user.name', 'Tessera Test'], { cwd: sourcePath });
  fs.writeFileSync(path.join(sourcePath, 'base.txt'), 'base\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: sourcePath });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: sourcePath, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '-b', 'feature/delete-standalone', worktreePath], {
    cwd: sourcePath,
    stdio: 'ignore',
  });

  projects.registerProject(sourcePath, sourcePath, 'delete-standalone-source');
  sessions.createSession('delete-standalone', sourcePath, 'Delete standalone', 'claude-code', {
    workDir: worktreePath,
    worktreeBranch: 'feature/delete-standalone',
    worktreeManaged: true,
  });

  await sessionOrchestrator.deleteSession('delete-user', 'delete-standalone');

  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(sessions.getSession('delete-standalone'), undefined);
});

test('an archived child Session uses its parent checkout for status and restore', async () => {
  const { sessions, tasks } = await modules();
  const archiveService = await import('@/lib/archive/archive-service');
  const parentPath = path.join(dataDir, 'archived-child-parent');
  const staleChildPath = path.join(dataDir, 'archived-child-stale');
  fs.mkdirSync(parentPath, { recursive: true });

  tasks.createTask({ id: 'archived-child-parent', projectId: dataDir, title: 'Archive parent' });
  sessions.createSession('archived-stale-child', dataDir, 'Archive child', 'claude-code', {
    taskId: 'archived-child-parent',
    workDir: staleChildPath,
  });
  tasks.setTaskWorktreeCheckout('archived-child-parent', {
    branch: 'feature/archive-child',
    path: parentPath,
  });
  sessions.updateSession('archived-stale-child', {
    archived: 1,
    archived_at: '2026-08-03T00:00:00.000Z',
  });

  const { items } = await archiveService.listArchiveItems({ projectId: dataDir, kind: 'chat' });
  const item = items.find((entry) => entry.id === 'archived-stale-child');
  assert.ok(item);
  assert.equal(item.workDir, parentPath);
  assert.equal(item.worktreeStatus, 'present');
  assert.equal(item.canRestore, true);

  await archiveService.restoreArchivedChat('archived-stale-child');
  assert.equal(sessions.getSession('archived-stale-child')?.archived, 0);
});

test('diff-stat broadcasts include a zero-session Worktree resolved by its parent path', async () => {
  const { sessions, tasks } = await modules();
  const [{ protocolAdapter }, broadcast, diffStats] = await Promise.all([
    import('@/lib/cli/protocol-adapter'),
    import('@/lib/git/worktree-diff-stats-broadcast'),
    import('@/lib/git/worktree-diff-stats-cache'),
  ]);
  const worktreePath = path.join(dataDir, 'diff-zero-session');
  fs.mkdirSync(worktreePath, { recursive: true });
  execFileSync('git', ['init'], { cwd: worktreePath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreePath });
  execFileSync('git', ['config', 'user.name', 'Tessera Test'], { cwd: worktreePath });
  fs.writeFileSync(path.join(worktreePath, 'changed.txt'), 'base\n');
  execFileSync('git', ['add', 'changed.txt'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: worktreePath, stdio: 'ignore' });
  fs.writeFileSync(path.join(worktreePath, 'changed.txt'), 'changed\n');

  tasks.createTask({ id: 'diff-zero-session', projectId: dataDir, title: 'Diff zero' });
  tasks.setTaskWorktreeCheckout('diff-zero-session', {
    branch: 'feature/diff-zero',
    path: worktreePath,
  });

  const messages: Array<{ userId: string; message: unknown }> = [];
  protocolAdapter.setSendToUser((userId, message) => {
    messages.push({ userId, message });
  });
  broadcast.installDiffStatsBroadcast();
  try {
    await diffStats.computeAndCache(worktreePath, 'diff-user');
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.userId, 'diff-user');
    const zeroSessionMessage = messages[0]?.message as {
      type?: string;
      workDir?: string;
      sessionIds?: string[];
      taskIds?: string[];
      stats?: { added?: number; removed?: number; changedFiles?: number } | null;
    };
    assert.equal(zeroSessionMessage.type, 'worktree_diff_stats');
    assert.equal(zeroSessionMessage.workDir, worktreePath);
    assert.deepEqual(zeroSessionMessage.sessionIds, []);
    assert.deepEqual(zeroSessionMessage.taskIds, ['diff-zero-session']);
    assert.deepEqual(
      {
        added: zeroSessionMessage.stats?.added,
        removed: zeroSessionMessage.stats?.removed,
        changedFiles: zeroSessionMessage.stats?.changedFiles,
      },
      { added: 1, removed: 1, changedFiles: 1 },
    );

    sessions.createSession('diff-stale-child', dataDir, 'Diff stale child', 'codex', {
      taskId: 'diff-zero-session',
      workDir: worktreePath,
    });
    (await modules()).database.getDb().prepare(
      'UPDATE sessions SET work_dir = ? WHERE id = ?',
    ).run(path.join(dataDir, 'diff-stale-child-path'), 'diff-stale-child');
    messages.length = 0;
    fs.writeFileSync(path.join(worktreePath, 'changed.txt'), 'changed again\n');
    await diffStats.computeAndCache(worktreePath, 'diff-user');
    const staleChildMessage = messages[0]?.message as { sessionIds?: string[] };
    assert.deepEqual(staleChildMessage.sessionIds, ['diff-stale-child']);
  } finally {
    broadcast.uninstallDiffStatsBroadcast();
    protocolAdapter.setSendToUser(() => undefined);
  }
});

test('migrated checkout consumers cannot reintroduce direct child-first SQL', () => {
  const identitySource = fs.readFileSync(
    new URL('../src/lib/db/worktree-identity.ts', import.meta.url),
    'utf8',
  );
  const consumerSource = [
    fs.readFileSync(new URL('../src/lib/db/task-preparation.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/db/tasks.ts', import.meta.url), 'utf8'),
  ].join('\n');
  const runtimeConsumers = [
    fs.readFileSync(new URL('../src/lib/archive/archive-service.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/git/git-panel.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/git/session-diff-refresh.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/session/session-workspace-root.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/session/codex-thread-lifecycle.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/session/session-fork.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/memory/claude-memory.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/terminal/terminal-launch-intent.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/terminal/terminal-resolver.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/terminal/provider-session-reconciliation.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/ws/server-session-actions.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/lib/ws/server-message-routing.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/app/api/sessions/[id]/skills/route.ts', import.meta.url), 'utf8'),
  ];
  const diffBroadcastSource = fs.readFileSync(
    new URL('../src/lib/git/worktree-diff-stats-broadcast.ts', import.meta.url),
    'utf8',
  );

  assert.match(identitySource, /PARENT_FIRST_WORKTREE_PATH_SQL/);
  assert.match(identitySource, /LEGACY_WORKTREE_PATH_FROM_CHILD_SQL/);
  assert.doesNotMatch(consumerSource, /SELECT\s+s\.work_dir/);
  for (const source of runtimeConsumers) {
    assert.match(source, /getSessionWorktreeContext/);
  }
  assert.match(diffBroadcastSource, /findTaskIdForWorktree\(workDir\)/);
  assert.match(
    fs.readFileSync(new URL('../src/lib/control/database-worktree-source.ts', import.meta.url), 'utf8'),
    /PARENT_FIRST_WORKTREE_PATH_SQL/,
  );
  assert.match(
    fs.readFileSync(new URL('../src/lib/session/session-orchestrator.ts', import.meta.url), 'utf8'),
    /!session\.task_id/,
  );
});
