import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlAuthorityRegistry } from '../src/lib/control/authority';
import {
  createControlService,
  type ControlProjectRecord,
  type ControlSessionRecord,
  type ControlWorktreeRecord,
} from '../src/lib/control/service';

const PROJECT_ONE: ControlProjectRecord = {
  id: 'project-one',
  decodedPath: '/projects/one',
  displayName: 'Project one',
  visible: true,
};

const PROJECT_TWO: ControlProjectRecord = {
  id: 'project-two',
  decodedPath: '/projects/two',
  displayName: 'Project two',
  visible: true,
};

const WORKTREE_ONE: ControlWorktreeRecord = {
  worktreeId: 'worktree-one',
  projectId: PROJECT_ONE.id,
  title: 'Worktree one',
  branch: 'feature/one',
  filesystemPath: '/worktrees/one',
  preparationStatus: 'succeeded',
  preparationPhase: 'before',
  sessions: [],
};

const WORKTREE_TWO: ControlWorktreeRecord = {
  ...WORKTREE_ONE,
  worktreeId: 'worktree-two',
  projectId: PROJECT_TWO.id,
  title: 'Worktree two',
  branch: 'feature/two',
  filesystemPath: '/worktrees/two',
};

const SESSION_ONE: ControlSessionRecord = {
  sessionId: 'session-one',
  worktreeId: WORKTREE_ONE.worktreeId,
  projectId: PROJECT_ONE.id,
  title: 'Session one',
  provider: 'codex',
  providerState: null,
  updatedAt: '2026-08-12T00:00:00.000Z',
};

const SESSION_TWO: ControlSessionRecord = {
  ...SESSION_ONE,
  sessionId: 'session-two',
  worktreeId: WORKTREE_TWO.worktreeId,
  projectId: PROJECT_TWO.id,
  title: 'Session two',
};

test('a Managed Session reads only its current Project through the Control Service', async () => {
  const authority = createControlAuthorityRegistry();
  const grant = authority.grant({
    agentEnvironment: 'native',
    projectId: PROJECT_ONE.id,
    sessionId: 'caller-session',
    worktreeId: WORKTREE_ONE.worktreeId,
  });
  const service = createControlService({
    appVersion: '1.0.0',
    runtimeId: 'runtime-one',
    authority,
    projects: {
      list: () => [PROJECT_ONE, PROJECT_TWO],
      get: (projectId) => [PROJECT_ONE, PROJECT_TWO].find((project) => project.id === projectId),
    },
    worktrees: {
      list: (projectId) => [WORKTREE_ONE, WORKTREE_TWO].filter(
        (worktree) => worktree.projectId === projectId,
      ),
      get: (worktreeId) => [WORKTREE_ONE, WORKTREE_TWO].find(
        (worktree) => worktree.worktreeId === worktreeId,
      ),
    },
  });
  const requestContext = {
    authorityToken: grant.token,
    agentEnvironment: 'wsl' as const,
    projectId: PROJECT_TWO.id,
    sessionId: 'forged-session',
    worktreeId: WORKTREE_TWO.worktreeId,
  };

  const listed = await service.listProjects(requestContext);
  const shown = await service.showProject(PROJECT_ONE.id, requestContext);

  assert.deepEqual(listed.projects.map((project) => project.id), [PROJECT_ONE.id]);
  assert.equal(shown.id, PROJECT_ONE.id);
  assert.equal(shown.agentEnvironmentCompatibility.agentEnvironment, 'native');
});

test('an already-running degraded Session retains authority until its runtime grant ends', async () => {
  const authority = createControlAuthorityRegistry();
  const service = createControlService({
    appVersion: '1.0.0',
    runtimeId: 'runtime-one',
    authority,
    projects: { list: () => [PROJECT_ONE], get: () => PROJECT_ONE },
    worktrees: { list: () => [WORKTREE_ONE], get: () => WORKTREE_ONE },
  });
  const outsideContext = { agentEnvironment: 'native' as const };

  await assert.rejects(
    service.status(outsideContext),
    isAuthorityDenied,
  );

  const grant = authority.grant({
    agentEnvironment: 'native',
    projectId: PROJECT_ONE.id,
    sessionId: 'managed-session',
  });
  const managedContext = {
    agentEnvironment: 'native' as const,
    authorityToken: grant.token,
  };
  // Hook health is deliberately not an authority-registry input: an existing
  // degraded runtime keeps this grant, while an external runtime has none.
  assert.equal((await service.status(managedContext)).callerContext?.sessionId, 'managed-session');

  grant.revoke();
  await assert.rejects(
    service.status(managedContext),
    isAuthorityDenied,
  );
});

test('a child Session launched through Control receives independent Project-scoped authority', async () => {
  const authority = createControlAuthorityRegistry();
  const parentGrant = authority.grant({
    agentEnvironment: 'native',
    projectId: PROJECT_ONE.id,
    sessionId: 'parent-session',
    worktreeId: WORKTREE_ONE.worktreeId,
  });
  const sessions: ControlSessionRecord[] = [];
  let childGrant: ReturnType<typeof authority.grant> | undefined;
  const service = createControlService({
    appVersion: '1.0.0',
    runtimeId: 'runtime-one',
    authority,
    projects: {
      list: () => [PROJECT_ONE, PROJECT_TWO],
      get: (projectId) => [PROJECT_ONE, PROJECT_TWO].find((project) => project.id === projectId),
    },
    worktrees: {
      list: () => [WORKTREE_ONE],
      get: (worktreeId) => worktreeId === WORKTREE_ONE.worktreeId ? WORKTREE_ONE : undefined,
    },
    sessions: {
      list: () => sessions,
      get: (sessionId) => sessions.find((session) => session.sessionId === sessionId),
    },
    sessionMutator: {
      create: async () => {
        const child = { ...SESSION_ONE, sessionId: 'child-session' };
        sessions.push(child);
        return child;
      },
      start: async ({ sessionId }) => {
        childGrant = authority.grant({
          agentEnvironment: 'native',
          projectId: PROJECT_ONE.id,
          sessionId,
          worktreeId: WORKTREE_ONE.worktreeId,
        });
        return { terminalId: 'terminal-child' };
      },
      removeCreated: async () => {},
    },
  });
  const parentContext = {
    agentEnvironment: 'native' as const,
    authorityToken: parentGrant.token,
  };

  await service.launchSession({
    worktreeId: WORKTREE_ONE.worktreeId,
    provider: 'codex',
  }, parentContext);
  assert.ok(childGrant);
  parentGrant.revoke();

  const childContext = {
    agentEnvironment: 'native' as const,
    authorityToken: childGrant.token,
  };
  assert.equal((await service.status(childContext)).callerContext?.sessionId, 'child-session');
  await assert.rejects(service.showProject(PROJECT_TWO.id, childContext), isAuthorityDenied);
});

test('every cross-Project Control read and mutation returns one stable denial', async () => {
  const authority = createControlAuthorityRegistry();
  const grant = authority.grant({
    agentEnvironment: 'native',
    projectId: PROJECT_ONE.id,
    sessionId: 'caller-session',
    worktreeId: WORKTREE_ONE.worktreeId,
  });
  let mutationCalls = 0;
  const service = createControlService({
    appVersion: '1.0.0',
    runtimeId: 'runtime-one',
    authority,
    projects: {
      list: () => [PROJECT_ONE, PROJECT_TWO],
      get: (projectId) => [PROJECT_ONE, PROJECT_TWO].find((project) => project.id === projectId),
    },
    worktrees: {
      list: (projectId) => [WORKTREE_ONE, WORKTREE_TWO].filter(
        (worktree) => worktree.projectId === projectId,
      ),
      get: (worktreeId) => [WORKTREE_ONE, WORKTREE_TWO].find(
        (worktree) => worktree.worktreeId === worktreeId,
      ),
    },
    worktreeCreator: {
      create: async () => {
        mutationCalls += 1;
        return { worktree: WORKTREE_TWO, startPoint: 'main' };
      },
    },
    sessions: {
      list: (worktreeId) => [SESSION_ONE, SESSION_TWO].filter(
        (session) => session.worktreeId === worktreeId,
      ),
      get: (sessionId) => [SESSION_ONE, SESSION_TWO].find(
        (session) => session.sessionId === sessionId,
      ),
    },
    sessionMutator: {
      create: async () => {
        mutationCalls += 1;
        return SESSION_TWO;
      },
      start: async () => {
        mutationCalls += 1;
        return { terminalId: 'terminal-two' };
      },
      removeCreated: async () => {},
    },
    sessionObserver: {
      read: async () => {
        mutationCalls += 1;
        return terminalSnapshot();
      },
      wait: async () => {
        mutationCalls += 1;
        return terminalSnapshot();
      },
    },
    sessionController: {
      prompt: async () => {
        mutationCalls += 1;
        return terminalSnapshot();
      },
      sendKeys: async () => {
        mutationCalls += 1;
        return terminalSnapshot();
      },
      stop: async () => {
        mutationCalls += 1;
        return terminalSnapshot();
      },
    },
  });
  const context = { agentEnvironment: 'native' as const, authorityToken: grant.token };
  const attempts: Array<() => Promise<unknown>> = [
    () => service.showProject(PROJECT_TWO.id, context),
    () => service.listWorktrees({ kind: 'project', projectId: PROJECT_TWO.id }, context),
    () => service.showWorktree(WORKTREE_TWO.worktreeId, context),
    () => service.createWorktree({
      selector: { kind: 'project', projectId: PROJECT_TWO.id },
      branch: 'feature/forbidden',
      startPoint: 'main',
    }, context),
    () => service.listSessions(WORKTREE_TWO.worktreeId, context),
    () => service.showSession(SESSION_TWO.sessionId, context),
    () => service.createSession({
      worktreeId: WORKTREE_TWO.worktreeId,
      provider: 'codex',
    }, context),
    () => service.startSession({ sessionId: SESSION_TWO.sessionId }, context),
    () => service.launchSession({
      worktreeId: WORKTREE_TWO.worktreeId,
      provider: 'codex',
    }, context),
    () => service.readSession(SESSION_TWO.sessionId, context),
    () => service.waitForSession({
      sessionId: SESSION_TWO.sessionId,
      condition: 'runtime-exit',
    }, context),
    () => service.promptSession({ sessionId: SESSION_TWO.sessionId, text: 'continue' }, context),
    () => service.sendSessionKeys({ sessionId: SESSION_TWO.sessionId, keys: ['ENTER'] }, context),
    () => service.stopSession(SESSION_TWO.sessionId, context),
  ];

  for (const attempt of attempts) await assert.rejects(attempt(), isAuthorityDenied);
  assert.equal(mutationCalls, 0);
});

function terminalSnapshot() {
  return {
    screen: '',
    cols: 80,
    rows: 24,
    alternateScreen: false,
    outputSequence: 1,
    terminalId: 'terminal-two',
    runtimeState: 'running' as const,
    stateAt: 1,
  };
}

function isAuthorityDenied(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'CONTROL_AUTHORITY_DENIED'
    && 'httpStatus' in error
    && error.httpStatus === 403;
}
