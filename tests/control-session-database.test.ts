import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  const [database, projects, tasks, sessions, controlSessions, webSocket, launcher] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/tasks'),
    import('@/lib/db/sessions'),
    import('@/lib/control/database-session-source'),
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
  const source = controlSessions.createDatabaseControlSessionSource();
  const mutator = controlSessions.createDatabaseControlSessionMutator({
    userId: 'control-session-user',
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
    });
    assert.equal(created.worktreeId, worktreeId);
    assert.equal(created.providerState, JSON.stringify({ kind: 'terminal' }));
    assert.equal(JSON.stringify(created).includes('internal-task-id'), false);

    const row = sessions.getSession(created.sessionId);
    assert.equal(row?.task_id, 'internal-task-id');
    assert.equal(row?.work_dir, worktreePath);
    assert.equal(row?.worktree_branch, 'feature/session-control');
    assert.equal(sessions.extractSessionKind(row?.provider_state ?? null), 'terminal');
    assert.deepEqual(source.list(worktreeId).map((item) => item.sessionId), [created.sessionId]);
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
