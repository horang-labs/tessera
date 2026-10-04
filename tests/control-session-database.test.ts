import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ControlOperationError,
  createControlService,
  type ControlWorktreeRecord,
} from '../src/lib/control/service';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-control-sessions-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

test.after(async () => {
  const { markServerShuttingDown } = await import('@/lib/server-lifecycle');
  const { terminalManager } = await import('@/lib/terminal/shared-terminal-manager');
  const { processManager } = await import('@/lib/cli/process-manager');
  markServerShuttingDown();
  await terminalManager.shutdownAll();
  await processManager.cleanup();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('the database adapter persists Worktree-owned PTY Sessions and broadcasts rollback', async () => {
  const [
    database,
    projects,
    tasks,
    sessions,
    controlSessions,
    sessionMutator,
    webSocket,
    launcher,
  ] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/tasks'),
    import('@/lib/db/sessions'),
    import('@/lib/control/database-session-source'),
    import('@/lib/control/session-mutator'),
    import('@/lib/ws/server'),
    import('@/lib/terminal/provider-launch-module'),
  ]);
  await database.initDatabase();
  const projectId = path.join(testRoot, 'project');
  const worktreePath = path.join(testRoot, 'worktree');
  fs.mkdirSync(worktreePath, { recursive: true });
  projects.registerProject(projectId, projectId, 'Control session project');
  const worktreeId = tasks.createTask({
    id: 'internal-task-id',
    projectId,
    title: 'Public Worktree',
    worktreeBranch: 'feature/session-control',
    worktreePath,
  });

  const launchRequests: Array<Record<string, unknown>> = [];
  let launchError: Error | null = null;
  let userIdResolutionCount = 0;
  const source = controlSessions.createDatabaseControlSessionSource();
  const mutator = sessionMutator.createDatabaseControlSessionMutator({
    resolveUserId: async () => {
      userIdResolutionCount += 1;
      return userIdResolutionCount === 1 ? 'control-session-user' : undefined;
    },
    launchModule: {
      supportsProvider: (providerId) => ['claude-code', 'codex', 'opencode'].includes(providerId),
      launch: async (request) => {
        launchRequests.push(request);
        if (launchError) throw launchError;
        return {
          terminalId: `session-${request.sessionId}`,
          attachedToExistingRuntime: false,
        };
      },
    },
  });
  const mutations: Array<Record<string, unknown>> = [];
  const originalSendToUser = webSocket.wsServer.sendToUser;
  webSocket.wsServer.sendToUser = function sendToUser(userId, message) {
    mutations.push({ userId, ...message });
  };

  try {
    const created = await mutator.create({
      worktreeId,
      provider: 'codex',
      title: 'Detached Codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      serviceTier: 'fast',
    });
    assert.equal(created.worktreeId, worktreeId);
    assert.equal(created.providerState, JSON.stringify({ kind: 'terminal' }));
    assert.equal(created.model, 'gpt-5.6-sol');
    assert.equal(created.reasoningEffort, 'high');
    assert.equal(created.serviceTier, 'fast');
    assert.equal(JSON.stringify(created).includes('internal-task-id'), false);

    const row = sessions.getSession(created.sessionId);
    assert.equal(row?.task_id, 'internal-task-id');
    assert.equal(row?.work_dir, worktreePath);
    assert.equal(row?.worktree_branch, 'feature/session-control');
    assert.equal(row?.model, 'gpt-5.6-sol');
    assert.equal(row?.reasoning_effort, 'high');
    assert.equal(row?.service_tier, 'fast');
    assert.equal(sessions.extractSessionKind(row?.provider_state ?? null), 'terminal');

    sessions.createSession(
      'chat-child',
      projectId,
      'Chat child',
      'codex',
      {
        taskId: 'internal-task-id',
        providerState: JSON.stringify({ kind: 'chat', threadId: 'chat-thread' }),
      },
    );
    sessions.createSession(
      'invalid-kind-child',
      projectId,
      'Invalid child',
      'codex',
      {
        taskId: 'internal-task-id',
        providerState: '{not-json',
      },
    );
    assert.deepEqual(source.list(worktreeId).map((item) => item.sessionId), [created.sessionId]);
    assert.equal(source.get('chat-child'), undefined);
    assert.equal(source.get('invalid-kind-child'), undefined);

    const worktree: ControlWorktreeRecord = {
      worktreeId,
      projectId,
      title: 'Public Worktree',
      branch: 'feature/session-control',
      filesystemPath: worktreePath,
      preparationStatus: 'succeeded',
      preparationPhase: 'before',
      sessions: [],
    };
    const service = createControlService({
      appVersion: '1.0.0',
      runtimeId: 'runtime-one',
      projects: { list: () => [], get: () => undefined },
      worktrees: { list: () => [worktree], get: (id) => id === worktreeId ? worktree : undefined },
      sessions: source,
      sessionMutator: mutator,
    });
    const launchCountBeforeRejectedStarts = launchRequests.length;
    for (const sessionId of ['chat-child', 'invalid-kind-child']) {
      await assert.rejects(
        service.startSession({ sessionId }, { agentEnvironment: 'native' }),
        (error: unknown) => error instanceof ControlOperationError
          && error.code === 'SESSION_NOT_FOUND',
      );
    }
    assert.equal(launchRequests.length, launchCountBeforeRejectedStarts);
    assert.ok(mutations.some((mutation) => (
      mutation.type === 'session_mutated' && mutation.kind === 'created'
    )));
    assert.ok(mutations.some((mutation) => (
      mutation.type === 'task_mutated' && mutation.kind === 'updated'
    )));

    const started = await mutator.start({
      sessionId: created.sessionId,
      initialPrompt: 'Inspect this checkout',
      allowPreparationFailure: true,
    });
    assert.equal(started.terminalId, `session-${created.sessionId}`);
    assert.deepEqual(launchRequests[0], {
      mode: 'detached',
      sessionId: created.sessionId,
      userId: 'control-session-user',
      initialPrompt: 'Inspect this checkout',
      allowPreparationFailure: true,
    });

    const rollbackCandidate = await mutator.create({
      worktreeId,
      provider: 'opencode',
    });
    launchError = new launcher.ProviderLaunchError(
      'PREPARATION_FAILED',
      'Worktree preparation failed before an agent could start.',
    );
    await assert.rejects(
      mutator.start({ sessionId: rollbackCandidate.sessionId }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'PREPARATION_FAILED',
    );
    await mutator.removeCreated(rollbackCandidate.sessionId);
    assert.equal(sessions.getSession(rollbackCandidate.sessionId), undefined);
    assert.equal(userIdResolutionCount, 1);
    assert.ok(mutations.some((mutation) => (
      mutation.type === 'session_mutated' && mutation.kind === 'deleted'
    )));
    assert.ok(mutations.some((mutation) => (
      mutation.type === 'task_mutated' && mutation.kind === 'updated'
    )));
  } finally {
    webSocket.wsServer.sendToUser = originalSendToUser;
  }
});

test('Control archive preserves history, siblings and the last child Worktree through the real lifecycle', async (t) => {
  const database = await import('@/lib/db/database');
  const projects = await import('@/lib/db/projects');
  const tasks = await import('@/lib/db/tasks');
  const sessions = await import('@/lib/db/sessions');
  const { createDatabaseControlSessionSource } = await import('@/lib/control/database-session-source');
  const { createDatabaseControlSessionMutator } = await import('@/lib/control/session-mutator');
  const { listArchiveItems } = await import('@/lib/archive/archive-service');
  const { wsServer } = await import('@/lib/ws/server');
  const { processManager } = await import('@/lib/cli/process-manager');
  const { terminalManager } = await import('@/lib/terminal/shared-terminal-manager');
  const locks = await import('@/lib/terminal/terminal-handoff-lock');
  const native = await import('@/lib/cli/providers/codex/thread-control-client');
  await database.initDatabase();
  const worktreePath = path.join(testRoot, 'archive-worktree');
  fs.mkdirSync(worktreePath);
  fs.writeFileSync(path.join(worktreePath, 'keep.txt'), 'keep my files');
  const projectId = 'archive-project';
  projects.registerProject(projectId, worktreePath, 'Archive project');
  const taskId = 'archive-task';
  const worktreeId = tasks.createTask({ id: taskId, projectId, title: 'Archive task',
    worktreePath, worktreeBranch: 'feature/archive' });
  for (const id of ['archive-a', 'archive-b']) {
    sessions.createSession(id, projectId, id, 'claude-code', {
      taskId, providerState: JSON.stringify({ kind: 'terminal', sessionId: `native-${id}` }),
    });
  }
  const originalState = sessions.getSession('archive-a')?.provider_state;
  const { sessionHistory } = await import('@/lib/session-history');
  sessionHistory.recordUserMessage('archive-a', 'Preserve this conversation');
  const historyPath = sessionHistory.getHistoryPath('archive-a');
  const originalHistory = fs.readFileSync(historyPath, 'utf8');
  const source = createDatabaseControlSessionSource();
  const service = createControlService({
    appVersion: '1.0.0', runtimeId: 'archive-runtime',
    projects: { list: () => [], get: () => undefined },
    worktrees: { list: () => [], get: () => ({ worktreeId, projectId, title: 'Archive task',
      branch: 'feature/archive', filesystemPath: worktreePath,
      preparationStatus: 'succeeded', preparationPhase: 'before', sessions: [] }) },
    sessions: source, sessionMutator: createDatabaseControlSessionMutator({ userId: 'archive-user' }),
    sessionObserver: {
      read: async () => { throw new Error('Archived Session reached observation'); },
      wait: async () => { throw new Error('Archived Session reached observation'); },
    },
    sessionController: {
      prompt: async () => { throw new Error('Archived Session reached runtime control'); },
      sendKeys: async () => { throw new Error('Archived Session reached runtime control'); },
      stop: async () => { throw new Error('Archived Session reached runtime control'); },
    },
  });
  const context = { agentEnvironment: 'native' as const };
  const mutations: Array<Record<string, unknown>> = [];
  const closes: string[] = [];
  t.mock.method(wsServer, 'sendToUser', (userId, message) => { mutations.push({ userId, ...message }); });
  t.mock.method(processManager, 'closeSession', async (id: string) => { closes.push(`gui:${id}`); });
  t.mock.method(terminalManager, 'closeSession', async (id: string, userId: string) => {
    assert.equal(userId, 'archive-user');
    closes.push(`pty:${id}`);
  });
  assert.deepEqual(await service.archiveSession('archive-a', context), {
    sessionId: 'archive-a', archived: true, worktreeRemoved: false,
  });
  assert.equal(sessions.getSession('archive-a')?.provider_state, originalState);
  assert.equal(fs.readFileSync(historyPath, 'utf8'), originalHistory);
  assert.ok(sessions.getSession('archive-a')?.archived_at);
  assert.equal(sessions.getSession('archive-a')?.deleted, 0);
  assert.equal(sessions.getSession('archive-b')?.archived, 0);
  assert.deepEqual(source.list(worktreeId).map((item) => item.sessionId), ['archive-b']);
  for (const operation of [
    () => service.showSession('archive-a', context),
    () => service.readSession('archive-a', context),
    () => service.waitForSession({ sessionId: 'archive-a', condition: 'running', timeoutSeconds: 1 }, context),
    () => service.startSession({ sessionId: 'archive-a' }, context),
    () => service.promptSession({ sessionId: 'archive-a', text: 'hello' }, context),
    () => service.sendSessionKeys({ sessionId: 'archive-a', keys: ['enter'] }, context),
    () => service.stopSession('archive-a', context),
  ]) await assert.rejects(operation, { code: 'SESSION_NOT_FOUND' });
  assert.ok((await listArchiveItems()).items.some((item) => item.id === 'archive-a'));
  assert.deepEqual(mutations[0], {
    userId: 'archive-user', type: 'session_mutated', kind: 'updated', sessionId: 'archive-a',
    projectId, taskId, archived: true, affectedProjectIds: [projectId],
  });
  await service.archiveSession('archive-a', context);

  const missingUser = createDatabaseControlSessionMutator({ resolveUserId: async () => undefined });
  await assert.rejects(missingUser.archive('archive-b'), { code: 'INSTANCE_UNAVAILABLE', httpStatus: 503 });
  assert.equal(sessions.getSession('archive-b')?.archived, 0);
  const beforeConflict = { mutations: mutations.length, closes: closes.length };
  assert.equal(locks.beginExclusiveTesseraSessionOperation('archive-b'), true);
  try {
    await assert.rejects(service.archiveSession('archive-b', context), {
      code: 'SESSION_ARCHIVE_CONFLICT', httpStatus: 409,
      details: { sessionId: 'archive-b', reason: 'session_busy' },
    });
  } finally { locks.endExclusiveTesseraSessionOperation('archive-b'); }
  assert.equal(locks.acquireTerminalHandoffLock({ sessionId: 'archive-b',
    terminalId: 'archive-handoff', userId: 'archive-user' }), true);
  try {
    await assert.rejects(service.archiveSession('archive-b', context), {
      code: 'SESSION_ARCHIVE_CONFLICT', httpStatus: 409,
      details: { sessionId: 'archive-b', reason: 'session_handed_off_to_terminal' },
    });
  } finally { locks.releaseTerminalHandoffByTerminal('archive-user', 'archive-handoff'); }
  assert.equal(mutations.length, beforeConflict.mutations);
  assert.equal(closes.length, beforeConflict.closes);

  await service.archiveSession('archive-b', context);
  assert.equal(tasks.getTask(taskId)?.archived, false);
  assert.deepEqual(source.list(worktreeId), []);
  assert.equal(fs.readFileSync(path.join(worktreePath, 'keep.txt'), 'utf8'), 'keep my files');
  assert.ok(closes.every((close) => /archive-[ab]$/.test(close)));

  for (const [id, options] of [
    ['archive-chat', { taskId, providerState: JSON.stringify({ kind: 'chat' }) }],
    ['archive-standalone', { providerState: JSON.stringify({ kind: 'terminal' }) }],
    ['archive-deleted', { taskId, providerState: JSON.stringify({ kind: 'terminal' }) }],
  ] as const) sessions.createSession(id, projectId, id, 'claude-code', options);
  sessions.deleteSession('archive-deleted');
  for (const id of ['missing', 'archive-chat', 'archive-standalone', 'archive-deleted']) {
    await assert.rejects(service.archiveSession(id, context), { code: 'SESSION_NOT_FOUND' });
  }

  sessions.createSession('archive-codex', projectId, 'Codex', 'codex', {
    taskId, providerState: JSON.stringify({ kind: 'terminal', threadId: 'thread-control-archive' }),
  });
  const nativeCalls: string[] = [];
  native.setCodexThreadControlRequestExecutorForTests(async (nativeContext, method) => {
    assert.equal(nativeContext.userId, 'archive-user');
    assert.ok(closes.includes('pty:archive-codex'));
    assert.equal(sessions.getSession('archive-codex')?.archived, 0);
    nativeCalls.push(method);
    throw new Error('private provider diagnostic');
  });
  t.after(() => native.setCodexThreadControlRequestExecutorForTests(null));
  const beforeFailure = mutations.length;
  await assert.rejects(service.archiveSession('archive-codex', context), (error: unknown) =>
    error instanceof ControlOperationError && error.code === 'INSTANCE_UNAVAILABLE'
      && !error.message.includes('private'));
  assert.equal(sessions.getSession('archive-codex')?.archived, 0);
  assert.equal(mutations.length, beforeFailure);
  native.setCodexThreadControlRequestExecutorForTests(async () => {
    throw new native.CodexThreadControlError('no rollout found for thread id thread-control-archive', -32000);
  });
  await service.archiveSession('archive-codex', context);
  assert.equal(sessions.getSession('archive-codex')?.archived, 1);
  assert.deepEqual(nativeCalls, ['thread/archive']);
  tasks.setTaskArchived(taskId, true);
  await assert.rejects(service.archiveSession('archive-a', context), { code: 'SESSION_NOT_FOUND' });
  tasks.setTaskArchived(taskId, false);
  tasks.setTaskWorktreeDeletedAt(taskId, new Date().toISOString());
  await assert.rejects(service.archiveSession('archive-a', context), { code: 'SESSION_NOT_FOUND' });
});
