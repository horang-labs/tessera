import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runControlCli } from './helpers/control-cli-runner';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-control-worktree-creation-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

const USER_ID = 'control-worktree-test-user';

type Modules = {
  database: typeof import('@/lib/db/database');
  projects: typeof import('@/lib/db/projects');
  settings: typeof import('@/lib/settings/manager');
  defaults: typeof import('@/lib/settings/defaults');
  tasks: typeof import('@/lib/db/tasks');
  projection: typeof import('@/lib/projects/project-view-projection');
  controlProjects: typeof import('@/lib/control/database-project-source');
  controlWorktrees: typeof import('@/lib/control/database-worktree-source');
  service: typeof import('@/lib/control/service');
  creator: typeof import('@/lib/control/worktree-creator');
  httpHandler: typeof import('@/lib/control/http-handler');
  descriptor: typeof import('@/lib/control/runtime-descriptor');
  webSocket: typeof import('@/lib/ws/server');
};

let loaded: Promise<Modules> | null = null;
function modules(): Promise<Modules> {
  loaded ??= (async () => {
    const [
      database,
      projects,
      settings,
      defaults,
      tasks,
      projection,
      controlProjects,
      controlWorktrees,
      service,
      creator,
      httpHandler,
      descriptor,
      webSocket,
    ] = await Promise.all([
      import('@/lib/db/database'),
      import('@/lib/db/projects'),
      import('@/lib/settings/manager'),
      import('@/lib/settings/defaults'),
      import('@/lib/db/tasks'),
      import('@/lib/projects/project-view-projection'),
      import('@/lib/control/database-project-source'),
      import('@/lib/control/database-worktree-source'),
      import('@/lib/control/service'),
      import('@/lib/control/worktree-creator'),
      import('@/lib/control/http-handler'),
      import('@/lib/control/runtime-descriptor'),
      import('@/lib/ws/server'),
    ]);
    await database.initDatabase();
    return {
      database,
      projects,
      settings,
      defaults,
      tasks,
      projection,
      controlProjects,
      controlWorktrees,
      service,
      creator,
      httpHandler,
      descriptor,
      webSocket,
    };
  })();
  return loaded;
}

test.after(async () => {
  const { markServerShuttingDown } = await import('@/lib/server-lifecycle');
  const { terminalManager } = await import('@/lib/terminal/shared-terminal-manager');
  const { processManager } = await import('@/lib/cli/process-manager');
  markServerShuttingDown();
  await terminalManager.shutdownAll();
  await processManager.cleanup();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('Control creates exact local and remote branches through the managed path policy and existing UI data flow', async () => {
  const mods = await modules();
  const repository = createRepository('exact-inputs');
  const managedRoot = path.join(testRoot, 'managed-checkouts');
  mods.projects.registerProject(repository.path, repository.path, 'Exact inputs');
  await mods.settings.SettingsManager.save(USER_ID, {
    ...mods.defaults.DEFAULT_SETTINGS,
    agentEnvironment: 'wsl',
    managedWorktreePathTemplate: path.join(managedRoot, '{branchName}'),
    lastModified: new Date().toISOString(),
  });

  const control = mods.service.createControlService({
    appVersion: '1.0.0',
    runtimeId: 'runtime-create-test',
    projects: mods.controlProjects.createDatabaseControlProjectSource(),
    worktrees: mods.controlWorktrees.createDatabaseControlWorktreeSource(),
    worktreeCreator: mods.creator.createDatabaseControlWorktreeCreator({ userId: USER_ID }),
  });
  const context = { agentEnvironment: 'wsl' as const };

  const local = await control.createWorktree({
    selector: { kind: 'project', projectId: repository.path },
    branch: 'feature/exact-local',
    startPoint: 'main',
  }, context);
  assert.equal(local.branch, 'feature/exact-local');
  assert.equal(local.startPoint, 'main');
  assert.equal(local.title, 'feature/exact-local');
  assert.equal(local.path, path.join(managedRoot, 'feature/exact-local'));
  assert.deepEqual(local.preparation, {
    status: 'never_run',
    phase: 'before',
    afterRunning: false,
  });
  assert.deepEqual(local.sessions, []);
  assert.equal(git(local.path!, ['rev-parse', 'HEAD']), repository.localCommit);

  const remote = await control.createWorktree({
    selector: { kind: 'project', projectId: repository.path },
    branch: 'feature/exact-remote',
    startPoint: 'origin/remote-start',
    title: 'Remote presentation title',
  }, context);
  assert.equal(remote.branch, 'feature/exact-remote');
  assert.equal(remote.startPoint, 'origin/remote-start');
  assert.equal(remote.title, 'Remote presentation title');
  assert.equal(git(remote.path!, ['rev-parse', 'HEAD']), repository.remoteCommit);

  const originWorktree = mods.projects.getProjectWorktree(repository.path);
  assert.ok(originWorktree);
  const uiWorktrees = mods.projection.getProjectViewWorktrees(repository.path);
  assert.deepEqual(
    uiWorktrees.map((worktree) => ({
      title: worktree.title,
      branch: worktree.worktreeBranch,
      path: worktree.workDir,
      creationScope: worktree.creationScope,
      startPoint: worktree.startPoint,
      sessionCount: worktree.sessions.length,
    })),
    [
      {
        title: 'Remote presentation title',
        branch: 'feature/exact-remote',
        path: remote.path,
        creationScope: { originWorktreeId: originWorktree.id, branch: 'main' },
        startPoint: 'origin/remote-start',
        sessionCount: 0,
      },
      {
        title: 'feature/exact-local',
        branch: 'feature/exact-local',
        path: local.path,
        creationScope: { originWorktreeId: originWorktree.id, branch: 'main' },
        startPoint: 'main',
        sessionCount: 0,
      },
    ],
  );

  git(repository.path, ['checkout', '-b', 'view/other']);
  assert.deepEqual(
    (await control.listWorktrees({ kind: 'project', projectId: repository.path }, context))
      .worktrees.map((worktree) => ({ id: worktree.id, branch: worktree.branch })),
    [
      { id: remote.taskId, branch: 'feature/exact-remote' },
      { id: local.taskId, branch: 'feature/exact-local' },
    ],
  );
  git(repository.path, ['checkout', 'main']);
  assert.deepEqual(
    (await control.listWorktrees({ kind: 'project', projectId: repository.path }, context))
      .worktrees.map((worktree) => ({ id: worktree.id, branch: worktree.branch })),
    [
      { id: remote.taskId, branch: 'feature/exact-remote' },
      { id: local.taskId, branch: 'feature/exact-local' },
    ],
  );

  await assert.rejects(
    control.createWorktree({
      selector: { kind: 'project', projectId: repository.path },
      branch: 'feature/exact-local',
      startPoint: 'main',
    }, context),
    (error: unknown) => error instanceof mods.service.ControlOperationError
      && error.code === 'BRANCH_ALREADY_EXISTS',
  );
  assert.equal(hasBranch(repository.path, 'feature/exact-local-2'), false);

  await assert.rejects(
    control.createWorktree({
      selector: { kind: 'project', projectId: repository.path },
      branch: 'feature/invalid-start',
      startPoint: 'missing/start-point',
    }, context),
    (error: unknown) => error instanceof mods.service.ControlOperationError
      && error.code === 'INVALID_START_POINT',
  );
  assert.equal(hasBranch(repository.path, 'feature/invalid-start'), false);

  await assert.rejects(
    control.createWorktree({
      selector: { kind: 'project', projectId: repository.path },
      branch: 'feature/environment-mismatch',
      startPoint: 'main',
    }, { agentEnvironment: 'native' }),
    (error: unknown) => error instanceof mods.service.ControlOperationError
      && error.code === 'PROJECT_ENVIRONMENT_MISMATCH',
  );
  assert.equal(hasBranch(repository.path, 'feature/environment-mismatch'), false);

  git(repository.path, ['checkout', '--detach']);
  await assert.rejects(
    control.createWorktree({
      selector: { kind: 'project', projectId: repository.path },
      branch: 'feature/detached-origin',
      startPoint: 'main',
    }, context),
    (error: unknown) => error instanceof mods.service.ControlOperationError
      && error.code === 'WORKTREE_CREATE_FAILED'
      && error.message === 'The Project Worktree must be on a branch before creating a linked Worktree.',
  );
  assert.equal(hasBranch(repository.path, 'feature/detached-origin'), false);
  const persistedCount = mods.database.getDb().prepare(`
    SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?
  `).get(repository.path) as { count: number };
  assert.equal(persistedCount.count, 2);
});

test('Control opens local and remote-only branches and returns distinct checkout refusals', async () => {
  const mods = await modules();
  const repository = createRepository('checkout-existing');
  const managedRoot = path.join(testRoot, 'checkout-existing-worktrees');
  git(repository.path, ['branch', 'feature/resume', repository.localCommit]);
  git(repository.path, ['config', 'branch.feature/resume.base', 'refs/heads/main']);
  mods.projects.registerProject(repository.path, repository.path, 'Checkout existing');
  await mods.settings.SettingsManager.save(USER_ID, {
    ...mods.defaults.DEFAULT_SETTINGS,
    agentEnvironment: 'wsl',
    managedWorktreePathTemplate: path.join(managedRoot, '{branchName}'),
    lastModified: new Date().toISOString(),
  });
  const control = createControl(mods, 5_000);
  const context = { agentEnvironment: 'wsl' as const };

  const local = await control.createWorktree({
    selector: { kind: 'project', projectId: repository.path },
    branch: 'feature/resume',
    startPoint: 'feature/resume',
    source: { mode: 'checkout-branch', branch: 'feature/resume' },
  }, context);
  assert.equal(local.branch, 'feature/resume');
  assert.equal(git(local.path!, ['rev-parse', 'HEAD']), repository.localCommit);
  assert.equal(
    git(repository.path, ['config', '--get', 'branch.feature/resume.base']),
    'refs/heads/main',
  );

  const remote = await control.createWorktree({
    selector: { kind: 'project', projectId: repository.path },
    branch: 'origin/remote-start',
    startPoint: 'origin/remote-start',
    source: { mode: 'checkout-branch', branch: 'origin/remote-start' },
  }, context);
  assert.equal(remote.branch, 'remote-start');
  assert.equal(git(remote.path!, ['rev-parse', 'HEAD']), repository.remoteCommit);
  assert.equal(
    git(repository.path, ['config', '--get', 'branch.remote-start.remote']),
    'origin',
  );
  assert.equal(
    git(repository.path, ['config', '--get', 'branch.remote-start.merge']),
    'refs/heads/remote-start',
  );

  await assert.rejects(
    control.createWorktree({
      selector: { kind: 'project', projectId: repository.path },
      branch: 'feature/missing',
      startPoint: 'feature/missing',
      source: { mode: 'checkout-branch', branch: 'feature/missing' },
    }, context),
    (error: unknown) => error instanceof mods.service.ControlOperationError
      && error.code === 'BRANCH_NOT_FOUND',
  );
  await assert.rejects(
    control.createWorktree({
      selector: { kind: 'project', projectId: repository.path },
      branch: 'main',
      startPoint: 'main',
      source: { mode: 'checkout-branch', branch: 'main' },
    }, context),
    (error: unknown) => error instanceof mods.service.ControlOperationError
      && error.code === 'BRANCH_ALREADY_CHECKED_OUT'
      && error.message === `Branch 'main' is already checked out in Worktree '${repository.path}'.`
      && error.details.holderWorktreePath === repository.path,
  );
  assert.equal(fs.existsSync(path.join(managedRoot, 'feature/missing')), false);
  assert.equal(fs.existsSync(path.join(managedRoot, 'main')), false);
});

test('the Worktree API ignores naming inputs when opening an existing branch', async () => {
  const mods = await modules();
  const repository = createRepository('api-checkout-existing');
  const managedRoot = path.join(testRoot, 'api-checkout-worktrees');
  git(repository.path, ['branch', 'feature/api-resume', repository.localCommit]);
  git(repository.path, ['config', 'branch.feature/api-resume.base', 'refs/heads/main']);
  mods.projects.registerProject(repository.path, repository.path, 'API checkout existing');
  mods.tasks.createTask({
    id: 'api-creation-scope-task',
    projectId: repository.path,
    title: 'API creation scope',
  });
  await mods.settings.SettingsManager.save('electron-local-user', {
    ...mods.defaults.DEFAULT_SETTINGS,
    agentEnvironment: 'wsl',
    managedWorktreePathTemplate: path.join(managedRoot, '{branchName}'),
    lastModified: new Date().toISOString(),
  });

  const previousElectronRuntime = process.env.TESSERA_ELECTRON_RUNTIME;
  const previousPort = process.env.PORT;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  process.env.PORT = '32123';
  try {
    const [{ NextRequest }, { POST }, { APP_SECRET_HEADER, ensureAppSecret }] = await Promise.all([
      import('next/server'),
      import('../src/app/api/worktrees/route'),
      import('../src/lib/auth/app-secret'),
    ]);
    const secret = await ensureAppSecret();
    const response = await POST(new NextRequest('http://localhost:32123/api/worktrees', {
      method: 'POST',
      headers: {
        [APP_SECRET_HEADER]: secret,
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
      body: JSON.stringify({
        projectDir: repository.path,
        source: { mode: 'checkout-branch', branch: 'feature/api-resume' },
        branchPrefix: 'must-not-apply/',
        branchSlug: 'must-not-apply',
        allowBranchSlugSuffix: false,
        taskId: 'api-creation-scope-task',
      }),
    }));
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const created = JSON.parse(responseText);
    assert.equal(created.branchName, 'feature/api-resume');
    assert.equal(created.worktreePath, path.join(managedRoot, 'feature/api-resume'));
    assert.equal(git(created.worktreePath, ['symbolic-ref', '--short', 'HEAD']), 'feature/api-resume');
    assert.equal(git(created.worktreePath, ['rev-parse', 'HEAD']), repository.localCommit);
    assert.equal(
      git(repository.path, ['config', '--get', 'branch.feature/api-resume.base']),
      'refs/heads/main',
    );
    const persisted = mods.tasks.getTask('api-creation-scope-task');
    assert.deepEqual(persisted?.creationScope, {
      originWorktreeId: mods.projects.getProjectWorktree(repository.path)?.id,
      branch: 'main',
    });
    assert.equal(persisted?.startPoint, 'feature/api-resume');

    const rootRefusal = await POST(new NextRequest('http://localhost:32123/api/worktrees', {
      method: 'POST',
      headers: {
        [APP_SECRET_HEADER]: secret,
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
      body: JSON.stringify({
        projectDir: repository.path,
        source: { mode: 'checkout-branch', branch: 'main' },
      }),
    }));
    assert.equal(rootRefusal.status, 409);
    assert.deepEqual(await rootRefusal.json(), {
      code: 'BRANCH_ALREADY_CHECKED_OUT',
      error: `Branch 'main' is already checked out in Worktree '${repository.path}'.`,
      branchName: 'main',
      holderWorktreePath: repository.path,
    });

    const existingCheckoutPath = path.join(testRoot, 'externally-created-main');
    git(repository.path, ['worktree', 'add', existingCheckoutPath, '-b', 'feature/already-open', 'main']);
    mods.tasks.createTask({
      id: 'api-reuse-existing-checkout-task',
      projectId: repository.path,
      title: 'Reuse external checkout',
    });
    const reuse = await POST(new NextRequest('http://localhost:32123/api/worktrees', {
      method: 'POST',
      headers: {
        [APP_SECRET_HEADER]: secret,
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
      body: JSON.stringify({
        projectDir: repository.path,
        source: { mode: 'checkout-branch', branch: 'feature/already-open' },
        taskId: 'api-reuse-existing-checkout-task',
      }),
    }));
    const reuseText = await reuse.text();
    assert.equal(reuse.status, 200, reuseText);
    assert.deepEqual(JSON.parse(reuseText), {
      branchName: 'feature/already-open',
      worktreePath: existingCheckoutPath,
    });
    const reusedTask = mods.tasks.getTask('api-reuse-existing-checkout-task');
    assert.equal(reusedTask?.worktreeBranch, 'feature/already-open');
    const persistedCheckout = mods.database.getDb().prepare(`
      SELECT worktree_path FROM tasks WHERE id = ?
    `).get('api-reuse-existing-checkout-task') as { worktree_path: string };
    assert.equal(persistedCheckout.worktree_path, existingCheckoutPath);
    assert.equal(fs.existsSync(path.join(managedRoot, 'feature/already-open')), false);

    mods.tasks.createTask({
      id: 'api-detached-origin-task',
      projectId: repository.path,
      title: 'Detached origin refusal',
    });
    git(repository.path, ['checkout', '--detach']);
    const detachedRefusal = await POST(new NextRequest('http://localhost:32123/api/worktrees', {
      method: 'POST',
      headers: {
        [APP_SECRET_HEADER]: secret,
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
      body: JSON.stringify({
        projectDir: repository.path,
        source: { mode: 'branch-off', baseRef: 'main' },
        branchSlug: 'detached-origin',
        taskId: 'api-detached-origin-task',
      }),
    }));
    assert.equal(detachedRefusal.status, 422);
    assert.deepEqual(await detachedRefusal.json(), {
      code: 'PROJECT_BRANCH_UNAVAILABLE',
      error: 'The Project Worktree must be on a branch before creating a linked Worktree.',
    });
    assert.equal(hasBranch(repository.path, 'detached-origin'), false);
    assert.equal(mods.tasks.getTask('api-detached-origin-task')?.creationScope, undefined);
  } finally {
    if (previousElectronRuntime === undefined) delete process.env.TESSERA_ELECTRON_RUNTIME;
    else process.env.TESSERA_ELECTRON_RUNTIME = previousElectronRuntime;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
});

test('the CLI and Control HTTP endpoint create from a dash-prefixed exact Git ref and broadcast UI visibility', async () => {
  const mods = await modules();
  const repository = createRepository('cli-http-exact-input');
  const managedRoot = path.join(testRoot, 'cli-http-checkouts');
  const descriptorRoot = path.join(testRoot, 'cli-http-runtime');
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
  ).version as string;
  git(repository.path, ['update-ref', 'refs/tags/--json', repository.localCommit]);
  git(repository.path, ['branch', 'feature/cli-resume', repository.localCommit]);
  mods.projects.registerProject(repository.path, repository.path, 'CLI HTTP exact input');
  await mods.settings.SettingsManager.save(USER_ID, {
    ...mods.defaults.DEFAULT_SETTINGS,
    agentEnvironment: 'wsl',
    managedWorktreePathTemplate: path.join(managedRoot, '{branchName}'),
    lastModified: new Date().toISOString(),
  });

  let requestHandler: ReturnType<typeof mods.httpHandler.createControlHttpHandler> | undefined;
  const server = http.createServer((request, response) => {
    if (!requestHandler) {
      response.writeHead(503).end();
      return;
    }
    void requestHandler(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runtime = await mods.descriptor.publishRuntimeDescriptor({
    appVersion: packageVersion,
    origin,
    runtimeDirectory: descriptorRoot,
  });
  const control = mods.service.createControlService({
    appVersion: packageVersion,
    runtimeId: runtime.descriptor.runtimeId,
    projects: mods.controlProjects.createDatabaseControlProjectSource(),
    worktrees: mods.controlWorktrees.createDatabaseControlWorktreeSource(),
    worktreeCreator: mods.creator.createDatabaseControlWorktreeCreator({ userId: USER_ID }),
  });
  requestHandler = mods.httpHandler.createControlHttpHandler({
    descriptor: runtime.descriptor,
    service: control,
  });

  const mutations: Array<{ userId: string; type: string; kind?: string; projectId?: string }> = [];
  const originalSendToUser = mods.webSocket.wsServer.sendToUser;
  mods.webSocket.wsServer.sendToUser = function sendToUser(userId, message) {
    mutations.push({
      userId,
      type: message.type,
      ...('kind' in message ? { kind: message.kind } : {}),
      ...('projectId' in message && typeof message.projectId === 'string'
        ? { projectId: message.projectId }
        : {}),
    });
  };

  try {
    const result = await runControlCli([
      'worktree', 'create', '--project', repository.path,
      '-b', 'feature/cli-http', '--json',
      '--control-descriptor', runtime.path,
      '--', '--json',
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    const created = JSON.parse(result.stdout).data as Record<string, unknown>;
    assert.equal(created.branch, 'feature/cli-http');
    assert.equal(created.startPoint, '--json');
    assert.equal(git(created.path as string, ['rev-parse', 'HEAD']), repository.localCommit);

    const checkout = await runControlCli([
      'worktree', 'create', '--project', repository.path,
      '--mode', 'checkout-branch', '-b', 'feature/cli-resume', '--json',
      '--control-descriptor', runtime.path,
    ]);
    assert.equal(checkout.code, 0, checkout.stderr || checkout.stdout);
    const resumed = JSON.parse(checkout.stdout).data as Record<string, unknown>;
    assert.equal(resumed.branch, 'feature/cli-resume');
    assert.equal(resumed.startPoint, 'feature/cli-resume');
    assert.equal(git(resumed.path as string, ['rev-parse', 'HEAD']), repository.localCommit);

    const visible = mods.projection.getProjectViewWorktrees(repository.path);
    assert.equal(visible.length, 2);
    assert.deepEqual(
      visible.map((worktree) => worktree.worktreeBranch).sort(),
      ['feature/cli-http', 'feature/cli-resume'],
    );
    assert.equal(visible.every((worktree) => worktree.sessions.length === 0), true);
    assert.equal(mutations.some((mutation) => (
      mutation.userId === USER_ID
      && mutation.type === 'task_mutated'
      && mutation.kind === 'created'
      && mutation.projectId === repository.path
    )), true);
  } finally {
    mods.webSocket.wsServer.sendToUser = originalSendToUser;
    await runtime.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Control reports blocking preparation outcomes while preserving inspectable Worktrees', async () => {
  const mods = await modules();
  const managedRoot = path.join(testRoot, 'preparation-checkouts');
  await mods.settings.SettingsManager.save(USER_ID, {
    ...mods.defaults.DEFAULT_SETTINGS,
    agentEnvironment: 'wsl',
    managedWorktreePathTemplate: path.join(managedRoot, '{branchName}'),
    lastModified: new Date().toISOString(),
  });

  const failedRepository = createRepository('preparation-failed');
  mods.projects.registerProject(failedRepository.path, failedRepository.path, 'Preparation failed');
  mods.projects.setPreparationScript(failedRepository.path, 'printf "before failed\\n"; exit 9');
  const failedControl = createControl(mods, 5_000);
  await assert.rejects(
    failedControl.createWorktree({
      selector: { kind: 'project', projectId: failedRepository.path },
      branch: 'feature/preparation-failed',
      startPoint: 'main',
    }, { agentEnvironment: 'wsl' }),
    (error: unknown) => {
      if (!(error instanceof mods.service.ControlOperationError)) return false;
      const worktree = error.details.worktree as Record<string, unknown> | undefined;
      assert.equal(error.code, 'PREPARATION_FAILED');
      assert.equal(worktree?.branch, 'feature/preparation-failed');
      assert.equal((worktree?.preparation as Record<string, unknown>)?.status, 'failed');
      assert.deepEqual(worktree?.sessions, []);
      return true;
    },
  );
  assert.equal(mods.projection.getProjectViewWorktrees(failedRepository.path)[0]?.sessions.length, 0);
  assert.equal(hasBranch(failedRepository.path, 'feature/preparation-failed'), true);

  const succeededRepository = createRepository('preparation-succeeded');
  mods.projects.registerProject(
    succeededRepository.path,
    succeededRepository.path,
    'Preparation succeeded',
  );
  mods.projects.setPreparationScript(
    succeededRepository.path,
    'printf "before ready\\n" > before-stage.txt',
  );
  const succeededWorktree = await createControl(mods, 5_000).createWorktree({
    selector: { kind: 'project', projectId: succeededRepository.path },
    branch: 'feature/preparation-succeeded',
    startPoint: 'main',
  }, { agentEnvironment: 'wsl' });
  assert.deepEqual(succeededWorktree.preparation, {
    status: 'succeeded',
    phase: 'before',
    afterRunning: false,
  });
  assert.equal(fs.existsSync(path.join(succeededWorktree.path!, 'before-stage.txt')), true);

  const afterRepository = createRepository('preparation-after');
  mods.projects.registerProject(afterRepository.path, afterRepository.path, 'Preparation after');
  mods.projects.setPreparationScript(
    afterRepository.path,
    'printf "before ready\\n" > before-stage.txt',
  );
  mods.projects.setPreparationScript(
    afterRepository.path,
    'sleep 3; printf "after ready\\n" > after-stage.txt',
    'after',
  );
  const afterWorktree = await createControl(mods, 5_000).createWorktree({
    selector: { kind: 'project', projectId: afterRepository.path },
    branch: 'feature/preparation-after',
    startPoint: 'origin/remote-start',
  }, { agentEnvironment: 'wsl' });
  assert.deepEqual(afterWorktree.preparation, {
    status: 'running',
    phase: 'after',
    afterRunning: true,
  });
  assert.equal(fs.existsSync(path.join(afterWorktree.path!, 'before-stage.txt')), true);

  const timeoutRepository = createRepository('preparation-timeout');
  mods.projects.registerProject(timeoutRepository.path, timeoutRepository.path, 'Preparation timeout');
  mods.projects.setPreparationScript(timeoutRepository.path, 'sleep 5');
  await assert.rejects(
    createControl(mods, 25).createWorktree({
      selector: { kind: 'project', projectId: timeoutRepository.path },
      branch: 'feature/preparation-timeout',
      startPoint: 'main',
    }, { agentEnvironment: 'wsl' }),
    (error: unknown) => {
      if (!(error instanceof mods.service.ControlOperationError)) return false;
      const worktree = error.details.worktree as Record<string, unknown> | undefined;
      assert.equal(error.code, 'PREPARATION_TIMEOUT');
      assert.equal(worktree?.branch, 'feature/preparation-timeout');
      assert.equal((worktree?.preparation as Record<string, unknown>)?.status, 'running');
      assert.equal((worktree?.preparation as Record<string, unknown>)?.phase, 'before');
      return true;
    },
  );
  assert.equal(mods.projection.getProjectViewWorktrees(timeoutRepository.path)[0]?.sessions.length, 0);
  assert.equal(hasBranch(timeoutRepository.path, 'feature/preparation-timeout'), true);
});

test('a persistence failure compensates the checkout and exact new branch', async () => {
  const mods = await modules();
  const repository = createRepository('persistence-failure');
  const managedRoot = path.join(testRoot, 'compensated-checkouts');
  mods.projects.registerProject(repository.path, repository.path, 'Persistence failure');
  await mods.settings.SettingsManager.save(USER_ID, {
    ...mods.defaults.DEFAULT_SETTINGS,
    agentEnvironment: 'wsl',
    managedWorktreePathTemplate: path.join(managedRoot, '{branchName}'),
    lastModified: new Date().toISOString(),
  });
  mods.database.getDb().exec(`
    CREATE TRIGGER fail_control_worktree_persist
    BEFORE INSERT ON tasks
    FOR EACH ROW
    WHEN NEW.project_id = '${repository.path.replaceAll("'", "''")}'
    BEGIN
      SELECT RAISE(ABORT, 'forced persistence failure');
    END;
  `);

  try {
    await assert.rejects(
      createControl(mods, 5_000).createWorktree({
        selector: { kind: 'project', projectId: repository.path },
        branch: 'feature/compensated',
        startPoint: 'main',
      }, { agentEnvironment: 'wsl' }),
      (error: unknown) => error instanceof mods.service.ControlOperationError
        && error.code === 'WORKTREE_PERSIST_FAILED',
    );
  } finally {
    mods.database.getDb().exec('DROP TRIGGER fail_control_worktree_persist');
  }

  assert.equal(mods.projection.getProjectViewWorktrees(repository.path).length, 0);
  assert.equal(hasBranch(repository.path, 'feature/compensated'), false);
  assert.equal(fs.existsSync(path.join(managedRoot, 'feature/compensated')), false);
});

function createControl(mods: Modules, preparationTimeoutMs: number) {
  return mods.service.createControlService({
    appVersion: '1.0.0',
    runtimeId: 'runtime-create-test',
    projects: mods.controlProjects.createDatabaseControlProjectSource(),
    worktrees: mods.controlWorktrees.createDatabaseControlWorktreeSource(),
    worktreeCreator: mods.creator.createDatabaseControlWorktreeCreator({
      userId: USER_ID,
      preparationTimeoutMs,
    }),
  });
}

function createRepository(label: string): {
  path: string;
  localCommit: string;
  remoteCommit: string;
} {
  const repository = path.join(testRoot, label, 'repository');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.email', 'test@example.com']);
  git(repository, ['config', 'user.name', 'Tessera Test']);
  fs.writeFileSync(path.join(repository, 'file.txt'), 'local\n');
  git(repository, ['add', 'file.txt']);
  git(repository, ['commit', '-m', 'local start']);
  git(repository, ['branch', '-M', 'main']);
  const localCommit = git(repository, ['rev-parse', 'HEAD']);

  fs.writeFileSync(path.join(repository, 'file.txt'), 'remote\n');
  git(repository, ['commit', '-am', 'remote start']);
  const remoteCommit = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['update-ref', 'refs/remotes/origin/remote-start', remoteCommit]);
  git(repository, ['config', 'remote.origin.url', path.join(testRoot, label, 'origin.git')]);
  git(repository, [
    'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*',
  ]);
  git(repository, ['reset', '--hard', localCommit]);
  return { path: repository, localCommit, remoteCommit };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function hasBranch(repository: string, branch: string): boolean {
  try {
    git(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}
