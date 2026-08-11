import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlAuthorityRegistry } from '../src/lib/control/authority';
import {
  ControlOperationError,
  createControlService,
  type ControlProjectRecord,
  type ControlSessionRecord,
  type ControlWorktreeRecord,
} from '../src/lib/control/service';
import {
  createInMemoryControlAuditHistory,
  type ControlAuditHistory,
  type PublicControlAuditRecord,
} from '../src/lib/control/audit';

const PROJECT: ControlProjectRecord = {
  id: 'project-audit',
  decodedPath: '/projects/audit',
  displayName: 'Audit Project',
  visible: true,
};

const WORKTREE: ControlWorktreeRecord = {
  worktreeId: 'wt_audit',
  projectId: PROJECT.id,
  title: 'Audit Worktree',
  branch: 'feature/audit',
  filesystemPath: '/worktrees/audit',
  preparationStatus: 'succeeded',
  preparationPhase: 'before',
  sessions: [],
};

function fixture() {
  const authority = createControlAuthorityRegistry();
  const grant = authority.grant({
    agentEnvironment: 'wsl',
    projectId: PROJECT.id,
    sessionId: 'calling-session',
    worktreeId: WORKTREE.worktreeId,
  });
  const context = {
    agentEnvironment: 'wsl' as const,
    authorityToken: grant.token,
  };
  const sessions: ControlSessionRecord[] = [];
  let createFailure: ControlOperationError | null = null;
  let startFailure: ControlOperationError | null = null;
  const auditHistory = createInMemoryControlAuditHistory({
    now: () => '2026-08-12T01:02:03.000Z',
  });
  const service = createControlService({
    appVersion: '1.0.0',
    runtimeId: 'runtime-audit',
    authority,
    projects: { list: () => [PROJECT], get: (id) => id === PROJECT.id ? PROJECT : undefined },
    worktrees: {
      list: () => [WORKTREE],
      get: (id) => id === WORKTREE.worktreeId ? WORKTREE : undefined,
    },
    worktreeCreator: {
      create: async (request) => ({
        worktree: {
          ...WORKTREE,
          worktreeId: 'wt_created_audit',
          branch: request.branch,
          title: request.title ?? request.branch,
        },
        startPoint: request.startPoint,
      }),
    },
    sessions: {
      list: () => sessions,
      get: (id) => sessions.find((session) => session.sessionId === id),
    },
    sessionMutator: {
      create: async (request) => {
        if (createFailure) throw createFailure;
        const session: ControlSessionRecord = {
          sessionId: 'created-session',
          worktreeId: request.worktreeId,
          projectId: PROJECT.id,
          title: request.title ?? 'Created Session',
          provider: request.provider,
          providerState: null,
          updatedAt: '2026-08-12T01:02:03.000Z',
        };
        sessions.push(session);
        return session;
      },
      start: async () => {
        if (startFailure) throw startFailure;
        return { terminalId: 'terminal-one' };
      },
      removeCreated: async () => undefined,
    },
    sessionController: {
      prompt: async () => snapshot('running'),
      sendKeys: async () => snapshot('input-required'),
      stop: async () => snapshot('exited'),
    },
    auditHistory,
  });

  return {
    context,
    service,
    failCreate(error: ControlOperationError) { createFailure = error; },
    failStart(error: ControlOperationError) { startFailure = error; },
  };
}

test('Project audit history records successful and failed Control mutations', async () => {
  const subject = fixture();

  await subject.service.createSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'codex',
  }, subject.context);
  subject.failCreate(new ControlOperationError(
    'PROVIDER_NOT_SUPPORTED',
    'The selected provider is unavailable.',
    400,
    { diagnostic: 'must not be retained' },
  ));
  await assert.rejects(
    subject.service.createSession({
      worktreeId: WORKTREE.worktreeId,
      provider: 'codex',
    }, subject.context),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'PROVIDER_NOT_SUPPORTED',
  );

  const { records } = await subject.service.listProjectAudit(
    { kind: 'current' },
    subject.context,
  );
  assert.deepEqual(records.map(withoutId), [
    {
      projectId: PROJECT.id,
      sourceSessionId: 'calling-session',
      operation: 'session.create',
      target: { kind: 'session', id: 'created-session' },
      occurredAt: '2026-08-12T01:02:03.000Z',
      outcome: 'succeeded',
    },
    {
      projectId: PROJECT.id,
      sourceSessionId: 'calling-session',
      operation: 'session.create',
      target: { kind: 'worktree', id: WORKTREE.worktreeId },
      occurredAt: '2026-08-12T01:02:03.000Z',
      outcome: 'failed',
      failureCode: 'PROVIDER_NOT_SUPPORTED',
    },
  ]);
  assert.equal(JSON.stringify(records).includes('must not be retained'), false);
  assert.equal(JSON.stringify(records).includes('diagnostic'), false);
});

test('Project audit history excludes prompt text and key-input contents', async () => {
  const subject = fixture();
  const sensitivePrompt = 'secret prompt body 348';
  const sensitiveKeys = ['escape', 'ctrl-c', 'enter'] as const;
  const created = await subject.service.createSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'codex',
  }, subject.context);

  await subject.service.promptSession({
    sessionId: created.sessionId,
    text: sensitivePrompt,
  }, subject.context);
  await subject.service.sendSessionKeys({
    sessionId: created.sessionId,
    keys: [...sensitiveKeys],
  }, subject.context);

  const { records } = await subject.service.listProjectAudit(
    { kind: 'current' },
    subject.context,
  );
  assert.deepEqual(records.slice(1).map((record) => ({
    operation: record.operation,
    target: record.target,
    outcome: record.outcome,
  })), [
    {
      operation: 'session.prompt',
      target: { kind: 'session', id: created.sessionId },
      outcome: 'succeeded',
    },
    {
      operation: 'session.send-keys',
      target: { kind: 'session', id: created.sessionId },
      outcome: 'succeeded',
    },
  ]);
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes(sensitivePrompt), false);
  for (const key of sensitiveKeys) assert.equal(serialized.includes(key), false);
});

test('every Project-changing Worktree and Session Control operation is audited once', async () => {
  const subject = fixture();

  await subject.service.createWorktree({
    selector: { kind: 'current' },
    branch: 'feature/audited-worktree',
    startPoint: 'main',
  }, subject.context);
  const created = await subject.service.createSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'codex',
  }, subject.context);
  await subject.service.startSession({ sessionId: created.sessionId }, subject.context);
  await subject.service.launchSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'codex',
  }, subject.context);
  await subject.service.promptSession({
    sessionId: created.sessionId,
    text: 'audited without retaining this',
  }, subject.context);
  await subject.service.sendSessionKeys({
    sessionId: created.sessionId,
    keys: ['enter'],
  }, subject.context);
  await subject.service.stopSession(created.sessionId, subject.context);

  const { records } = await subject.service.listProjectAudit(
    { kind: 'current' },
    subject.context,
  );
  assert.deepEqual(records.map((record) => record.operation), [
    'worktree.create',
    'session.create',
    'session.start',
    'session.launch',
    'session.prompt',
    'session.send-keys',
    'session.stop',
  ]);
  assert.equal(records.every((record) => record.sourceSessionId === 'calling-session'), true);
  assert.equal(records.every((record) => record.outcome === 'succeeded'), true);
});

test('Project audit history rejects cross-Project visibility', async () => {
  const subject = fixture();

  await assert.rejects(
    subject.service.listProjectAudit(
      { kind: 'project', projectId: 'another-project' },
      subject.context,
    ),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'CONTROL_AUTHORITY_DENIED',
  );
});

test('a failed composite launch cannot be recorded as successful', async () => {
  const subject = fixture();
  const sensitivePrompt = 'launch failure prompt must stay private';
  subject.failStart(new ControlOperationError(
    'PREPARATION_FAILED',
    'Public preparation failure.',
    409,
    { internalOutput: 'private preparation stderr' },
  ));

  await assert.rejects(
    subject.service.launchSession({
      worktreeId: WORKTREE.worktreeId,
      provider: 'codex',
      initialPrompt: sensitivePrompt,
    }, subject.context),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'PREPARATION_FAILED',
  );

  const { records } = await subject.service.listProjectAudit(
    { kind: 'current' },
    subject.context,
  );
  assert.equal(records.length, 1);
  assert.deepEqual(withoutId(records[0]), {
    projectId: PROJECT.id,
    sourceSessionId: 'calling-session',
    operation: 'session.launch',
    target: { kind: 'session', id: 'created-session' },
    occurredAt: '2026-08-12T01:02:03.000Z',
    outcome: 'failed',
    failureCode: 'PREPARATION_FAILED',
  });
  assert.equal(JSON.stringify(records).includes(sensitivePrompt), false);
  assert.equal(JSON.stringify(records).includes('private preparation stderr'), false);
});

test('scope and support failures inside a requested mutation are audited', async () => {
  const subject = fixture();

  await assert.rejects(
    subject.service.createSession({
      worktreeId: 'wt_outside_project',
      provider: 'codex',
    }, subject.context),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'CONTROL_AUTHORITY_DENIED',
  );

  const { records } = await subject.service.listProjectAudit(
    { kind: 'current' },
    subject.context,
  );
  assert.deepEqual(records.map(withoutId), [{
    projectId: PROJECT.id,
    sourceSessionId: 'calling-session',
    operation: 'session.create',
    target: { kind: 'worktree', id: 'wt_outside_project' },
    occurredAt: '2026-08-12T01:02:03.000Z',
    outcome: 'failed',
    failureCode: 'CONTROL_AUTHORITY_DENIED',
  }]);
});

test('audit is reserved before mutation and transient finalization failure is retried', async () => {
  const events: string[] = [];
  const authority = createControlAuthorityRegistry();
  const grant = authority.grant({
    agentEnvironment: 'wsl',
    projectId: PROJECT.id,
    sessionId: 'calling-session',
  });
  const auditHistory = {
    list: async () => [],
    begin: async (attempt: Record<string, unknown>) => {
      events.push('audit:begin');
      return {
        ...attempt,
        id: 'reserved-audit',
        occurredAt: '2026-08-12T01:02:03.000Z',
        outcome: 'pending',
      };
    },
    complete: async (_id: string, completion: { outcome: string }) => {
      events.push(`audit:complete:${completion.outcome}`);
      if (events.filter((event) => event.startsWith('audit:complete:')).length === 1) {
        throw new Error('simulated transient audit finalize failure');
      }
    },
  } as unknown as ControlAuditHistory;
  const service = createControlService({
    appVersion: '1.0.0',
    runtimeId: 'runtime-audit-order',
    authority,
    auditHistory,
    projects: { list: () => [PROJECT], get: () => PROJECT },
    worktrees: { list: () => [WORKTREE], get: () => WORKTREE },
    sessions: { list: () => [], get: () => undefined },
    sessionMutator: {
      create: async (request) => {
        events.push('mutation');
        return {
          sessionId: 'created-after-reservation',
          worktreeId: request.worktreeId,
          projectId: PROJECT.id,
          title: 'Reserved Session',
          provider: request.provider,
          providerState: null,
          updatedAt: '2026-08-12T01:02:03.000Z',
        };
      },
      start: async () => ({ terminalId: 'terminal-one' }),
      removeCreated: async () => undefined,
    },
  });

  const created = await service.createSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'codex',
  }, { agentEnvironment: 'wsl', authorityToken: grant.token });

  assert.equal(created.sessionId, 'created-after-reservation');
  assert.deepEqual(events, [
    'audit:begin',
    'mutation',
    'audit:complete:succeeded',
    'audit:complete:succeeded',
  ]);
});

function withoutId(record: PublicControlAuditRecord): Omit<PublicControlAuditRecord, 'id'> {
  const { id: _id, ...rest } = record;
  return rest;
}

function snapshot(runtimeState: 'running' | 'input-required' | 'exited') {
  return {
    screen: '',
    cols: runtimeState === 'exited' ? null : 80,
    rows: runtimeState === 'exited' ? null : 24,
    alternateScreen: false,
    outputSequence: 1,
    terminalId: 'terminal-audit',
    runtimeState,
    stateAt: 1,
  };
}
