import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlOperationError,
  createControlService,
  type ControlProjectRecord,
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

function makeService() {
  return createControlService({
    appVersion: '1.2.3',
    runtimeId: 'runtime-one',
    projects: {
      list: () => PROJECTS,
      get: (projectId) => PROJECTS.find((project) => project.id === projectId),
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

function collectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}
