import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-immediate-title-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

let applyImmediateSessionTitle:
  typeof import('../src/lib/session/immediate-session-title')['applyImmediateSessionTitle'];
let database: typeof import('../src/lib/db/database');
let dbProjects: typeof import('../src/lib/db/projects');
let dbSessions: typeof import('../src/lib/db/sessions');
let dbTasks: typeof import('../src/lib/db/tasks');

test.before(async () => {
  database = await import('../src/lib/db/database');
  dbProjects = await import('../src/lib/db/projects');
  dbSessions = await import('../src/lib/db/sessions');
  dbTasks = await import('../src/lib/db/tasks');
  ({ applyImmediateSessionTitle } = await import('../src/lib/session/immediate-session-title'));

  await database.initDatabase();
  dbProjects.registerProject('project-title', dataDir, 'Title Project', 'codex');
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('replaces a placeholder and synchronizes its single linked task', () => {
  dbTasks.createTask({ id: 'task-title', projectId: 'project-title', title: 'New Task' });
  dbSessions.createSession('session-title', 'project-title', 'Session 1', 'codex', {
    taskId: 'task-title',
    workDir: dataDir,
  });

  const update = applyImmediateSessionTitle(
    'session-title',
    'Can you please fix the terminal title timing?',
  );

  assert.deepEqual(update, { previousTitle: 'Session 1', title: 'Fix the terminal title timing' });
  assert.equal(dbSessions.getSession('session-title')?.title, 'Fix the terminal title timing');
  assert.equal(dbSessions.getSession('session-title')?.has_custom_title, 0);
  assert.equal(dbTasks.getTask('task-title')?.title, 'Fix the terminal title timing');
});

test('replaces the default New Worktree title from the first prompt', () => {
  dbTasks.createTask({ id: 'worktree-task-title', projectId: 'project-title', title: 'New Worktree' });
  dbSessions.createSession('worktree-session-title', 'project-title', 'New Worktree', 'codex', {
    taskId: 'worktree-task-title',
    workDir: dataDir,
  });

  const update = applyImmediateSessionTitle(
    'worktree-session-title',
    'Can you please fix the title regression?',
  );

  assert.deepEqual(update, { previousTitle: 'New Worktree', title: 'Fix the title regression' });
  assert.equal(dbSessions.getSession('worktree-session-title')?.title, 'Fix the title regression');
  assert.equal(dbTasks.getTask('worktree-task-title')?.title, 'Fix the title regression');
});

test('replaces localized default worktree titles from the first prompt', () => {
  const placeholders = [
    ['ko', '새 워크트리'],
    ['ja', '新しいワークツリー'],
    ['zh', '新建工作树'],
  ] as const;

  for (const [locale, placeholder] of placeholders) {
    const taskId = `localized-worktree-task-${locale}`;
    const sessionId = `localized-worktree-session-${locale}`;
    dbTasks.createTask({ id: taskId, projectId: 'project-title', title: placeholder });
    dbSessions.createSession(sessionId, 'project-title', placeholder, 'codex', {
      taskId,
      workDir: dataDir,
    });

    const update = applyImmediateSessionTitle(sessionId, 'Can you please fix the title regression?');

    assert.deepEqual(update, { previousTitle: placeholder, title: 'Fix the title regression' });
    assert.equal(dbSessions.getSession(sessionId)?.title, 'Fix the title regression');
    assert.equal(dbTasks.getTask(taskId)?.title, 'Fix the title regression');
  }
});

test('never replaces a manually chosen title', () => {
  dbSessions.createSession('manual-title', 'project-title', 'Keep this title', 'codex');
  dbSessions.updateSession('manual-title', { has_custom_title: 1 });

  assert.equal(applyImmediateSessionTitle('manual-title', 'Please replace this'), null);
  assert.equal(dbSessions.getSession('manual-title')?.title, 'Keep this title');
});

test('does not mistake a generated title beginning with Session for a placeholder', () => {
  dbSessions.createSession('generated-title', 'project-title', 'Session architecture', 'codex');

  assert.equal(applyImmediateSessionTitle('generated-title', 'Please replace this'), null);
  assert.equal(dbSessions.getSession('generated-title')?.title, 'Session architecture');
});
