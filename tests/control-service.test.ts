import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlOperationError,
  createControlService,
  type ControlProjectRecord,
  type ControlWorktreeRecord,
} from '../src/lib/control/service';

const PROJECTS: ControlProjectRecord[] = [
  {
    id: 'project-exact-id',
    decodedPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\alpha',
    displayName: 'Alpha',
    visible: true,
  },
  {
    id: 'closed-project-id',
    decodedPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\closed',
    displayName: 'Closed',
    visible: false,
  },
];

const WORKTREES: ControlWorktreeRecord[] = [
  {
    worktreeId: 'wt_public_one',
    projectId: 'project-exact-id',
    title: 'Public one',
    branch: 'feature/public-one',
    filesystemPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\alpha-worktree',
    preparationStatus: 'running',
    preparationPhase: 'after',
    sessions: [{
      sessionId: 'session-one',
      title: 'Session one',
      provider: 'codex',
      updatedAt: '2026-08-03T00:00:00.000Z',
    }],
  },
  {
    worktreeId: 'wt_zero_session',
    projectId: 'project-exact-id',
    title: 'Zero session',
    branch: null,
    filesystemPath: null,
    preparationStatus: 'never_run',
    preparationPhase: 'before',
    sessions: [],
  },
];

function makeService() {
  return createControlService({
    appVersion: '1.2.3',
    runtimeId: 'runtime-one',
    projects: {
      list: () => PROJECTS,
      get: (projectId) => PROJECTS.find((project) => project.id === projectId),
    },
    worktrees: {
      list: (projectId) => WORKTREES.filter((worktree) => worktree.projectId === projectId),
      get: (worktreeId) => WORKTREES.find((worktree) => worktree.worktreeId === worktreeId),
    },
  });
}

test('status reports one exact runtime and only available caller context', async () => {
  const status = await makeService().status({
    agentEnvironment: 'wsl',
    projectId: 'project-exact-id',
    sessionId: 'session-caller',
  });

  assert.deepEqual(status, {
    appVersion: '1.2.3',
    controlVersion: 1,
    instanceId: 'runtime-one',
    connectionState: 'connected',
    callerContext: {
      projectId: 'project-exact-id',
      sessionId: 'session-caller',
    },
  });
});

test('project reads return public DTOs with caller-readable paths and compatibility', async () => {
  const service = makeService();
  const context = { agentEnvironment: 'wsl' as const };

  assert.deepEqual(await service.listProjects(context), {
    projects: [
      {
        id: 'project-exact-id',
        displayName: 'Alpha',
        path: '/home/work/alpha',
        visible: true,
        agentEnvironmentCompatibility: {
          agentEnvironment: 'wsl',
          filesystemKind: 'wsl',
          compatible: true,
        },
      },
      {
        id: 'closed-project-id',
        displayName: 'Closed',
        path: '/home/work/closed',
        visible: false,
        agentEnvironmentCompatibility: {
          agentEnvironment: 'wsl',
          filesystemKind: 'wsl',
          compatible: true,
        },
      },
    ],
  });

  const shown = await service.showProject('project-exact-id', context);
  assert.equal(shown.id, 'project-exact-id');
  assert.deepEqual(
    collectKeys(shown).filter((key) => (
      /task|ticket|worker|delegate|blocker|scheduler/i.test(key)
    )),
    [],
  );
  assert.equal(collectKeys(shown).includes('decodedPath'), false);
});

test('project show fails with the stable missing-project error', async () => {
  await assert.rejects(
    makeService().showProject('missing-project', { agentEnvironment: 'native' }),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'PROJECT_NOT_FOUND'
      && error.httpStatus === 404,
  );
});

test('Worktree reads use exact public IDs and expose caller-readable public DTOs', async () => {
  const service = makeService();
  const context = { agentEnvironment: 'wsl' as const, projectId: 'project-exact-id' };

  const current = await service.listWorktrees({ kind: 'current' }, context);
  assert.deepEqual(current, {
    worktrees: [
      {
        worktreeId: 'wt_public_one',
        projectId: 'project-exact-id',
        title: 'Public one',
        branch: 'feature/public-one',
        path: '/home/work/alpha-worktree',
        preparation: { status: 'running', phase: 'after', afterRunning: true },
        sessions: [{
          sessionId: 'session-one',
          title: 'Session one',
          provider: 'codex',
          updatedAt: '2026-08-03T00:00:00.000Z',
        }],
      },
      {
        worktreeId: 'wt_zero_session',
        projectId: 'project-exact-id',
        title: 'Zero session',
        branch: null,
        path: null,
        preparation: { status: 'never_run', phase: 'before', afterRunning: false },
        sessions: [],
      },
    ],
  });

  const shown = await service.showWorktree('wt_public_one', context);
  assert.equal(shown.worktreeId, 'wt_public_one');
  assert.deepEqual(
    collectKeys({ current, shown }).filter((key) => (
      /task|ticket|worker|delegate|blocker|scheduler/i.test(key)
    )),
    [],
  );
  assert.equal(collectKeys(shown).includes('filesystemPath'), false);

  await assert.rejects(
    service.showWorktree('legacy-internal-id', context),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'WORKTREE_NOT_FOUND',
  );
});

test('Worktree current selection fails without injected caller context', async () => {
  await assert.rejects(
    makeService().listWorktrees({ kind: 'current' }, { agentEnvironment: 'native' }),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'CALLER_CONTEXT_UNAVAILABLE',
  );
});

test('Worktree creation rejects an incompatible Project before the mutation boundary', async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  let mutationCalls = 0;
  try {
    const service = createControlService({
      appVersion: '1.2.3',
      runtimeId: 'runtime-one',
      projects: {
        list: () => [],
        get: (projectId) => projectId === 'windows-project'
          ? {
              id: projectId,
              decodedPath: 'C:\\src\\windows-project',
              displayName: 'Windows Project',
              visible: true,
            }
          : undefined,
      },
      worktrees: { list: () => [], get: () => undefined },
      worktreeCreator: {
        create: async () => {
          mutationCalls += 1;
          throw new Error('must not be called');
        },
      },
    });

    await assert.rejects(
      service.createWorktree({
        selector: { kind: 'project', projectId: 'windows-project' },
        branch: 'feature/environment-check',
        startPoint: 'main',
      }, { agentEnvironment: 'wsl' }),
      (error: unknown) => error instanceof ControlOperationError
        && error.code === 'PROJECT_ENVIRONMENT_MISMATCH',
    );
    assert.equal(mutationCalls, 0);
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
});

function collectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}
