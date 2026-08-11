import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlAuthorityRegistry } from '../src/lib/control/authority';
import { createInMemoryControlAuditHistory } from '../src/lib/control/audit';
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

const AUTHORITY = createControlAuthorityRegistry();
const AUTHORITY_GRANT = AUTHORITY.grant({
  agentEnvironment: 'wsl',
  projectId: 'project-exact-id',
  sessionId: 'session-caller',
  worktreeId: 'wt_public_one',
});
const CONTEXT = {
  agentEnvironment: 'wsl' as const,
  authorityToken: AUTHORITY_GRANT.token,
};

function makeService() {
  return createControlService({
    appVersion: '1.2.3',
    runtimeId: 'runtime-one',
    authority: AUTHORITY,
    auditHistory: createInMemoryControlAuditHistory(),
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
  const status = await makeService().status(CONTEXT);

  assert.deepEqual(status, {
    appVersion: '1.2.3',
    controlVersion: 1,
    instanceId: 'runtime-one',
    connectionState: 'connected',
    callerContext: {
      projectId: 'project-exact-id',
      sessionId: 'session-caller',
      worktreeId: 'wt_public_one',
    },
  });
});

test('project reads return public DTOs with caller-readable paths and compatibility', async () => {
  const service = makeService();
  const context = CONTEXT;

  assert.deepEqual(await service.listProjects(context), {
    projects: [{
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

test('project show denies selectors outside the caller Project scope', async () => {
  await assert.rejects(
    makeService().showProject('missing-project', CONTEXT),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'CONTROL_AUTHORITY_DENIED'
      && error.httpStatus === 403,
  );
});

test('Worktree reads use exact public IDs and expose caller-readable public DTOs', async () => {
  const service = makeService();
  const context = CONTEXT;

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
      && error.code === 'CONTROL_AUTHORITY_DENIED',
  );
});

test('Worktree current selection fails without active managed authority', async () => {
  await assert.rejects(
    makeService().listWorktrees({ kind: 'current' }, { agentEnvironment: 'native' }),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'CONTROL_AUTHORITY_DENIED',
  );
});

test('Worktree creation rejects an incompatible Project before the mutation boundary', async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  let mutationCalls = 0;
  try {
    const authority = createControlAuthorityRegistry();
    const grant = authority.grant({
      agentEnvironment: 'wsl',
      projectId: 'windows-project',
      sessionId: 'session-windows-project',
    });
    const service = createControlService({
      appVersion: '1.2.3',
      runtimeId: 'runtime-one',
      authority,
      auditHistory: createInMemoryControlAuditHistory(),
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
      }, { agentEnvironment: 'wsl', authorityToken: grant.token }),
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
