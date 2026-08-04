import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, before } from 'node:test';
import type { CliProvider } from '@/lib/cli/providers/types';
import type { TerminalProcessHandle, TerminalPtyFactory } from '@/lib/terminal/types';
import type { ServerTransportMessage } from '@/lib/ws/message-types';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-launch-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(testRoot, 'claude-home');
process.env.CODEX_HOME = path.join(testRoot, 'codex-home');
process.env.NODE_ENV = 'test';

type Modules = {
  sessions: typeof import('@/lib/db/sessions');
  tasks: typeof import('@/lib/db/tasks');
  taskPreparation: typeof import('@/lib/db/task-preparation');
  TerminalManager: typeof import('@/lib/terminal/terminal-manager').TerminalManager;
  createProviderLaunchModule:
    typeof import('@/lib/terminal/provider-launch-module').createProviderLaunchModule;
  ProviderLaunchError:
    typeof import('@/lib/terminal/provider-launch-module').ProviderLaunchError;
  resolvePaneToken: typeof import('@/lib/terminal/pane-token-registry').resolvePaneToken;
};

let modules: Modules;
let workspace: string;
const managers: Array<InstanceType<Modules['TerminalManager']>> = [];
const observerDisposeCounts = new Map<string, number>();

function withTestTerminalSessionObserver(provider: CliProvider): CliProvider {
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'createTerminalSessionObserver') {
        return () => ({
          ready: async () => {},
          dispose: () => {
            const providerId = target.getProviderId();
            observerDisposeCounts.set(
              providerId,
              (observerDisposeCounts.get(providerId) ?? 0) + 1,
            );
          },
        });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

before(async () => {
  workspace = fs.mkdtempSync(path.join(testRoot, 'workspace-'));
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const [
    database,
    projects,
    sessions,
    tasks,
    taskPreparation,
    terminal,
    launcher,
    registry,
    claude,
    codex,
    opencode,
    paneTokens,
  ] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/db/tasks'),
    import('@/lib/db/task-preparation'),
    import('@/lib/terminal/terminal-manager'),
    import('@/lib/terminal/provider-launch-module'),
    import('@/lib/cli/providers/registry'),
    import('@/lib/cli/providers/claude-code/adapter'),
    import('@/lib/cli/providers/codex/adapter'),
    import('@/lib/cli/providers/opencode/adapter'),
    import('@/lib/terminal/pane-token-registry'),
  ]);
  registry.cliProviderRegistry.register(
    'claude-code',
    withTestTerminalSessionObserver(claude.claudeCodeAdapter),
  );
  registry.cliProviderRegistry.register(
    'codex',
    withTestTerminalSessionObserver(codex.codexAdapter),
  );
  registry.cliProviderRegistry.register(
    'opencode',
    withTestTerminalSessionObserver(opencode.opencodeAdapter),
  );
  await database.initDatabase();
  projects.registerProject('provider-launch-project', workspace, 'Provider launch project');
  modules = {
    sessions,
    tasks,
    taskPreparation,
    TerminalManager: terminal.TerminalManager,
    createProviderLaunchModule: launcher.createProviderLaunchModule,
    ProviderLaunchError: launcher.ProviderLaunchError,
    resolvePaneToken: paneTokens.resolvePaneToken,
  };
});

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll()));
});

class FakePty implements TerminalProcessHandle {
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  onData(callback: (data: string) => void): void {
    this.dataListeners.push(callback);
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitListeners.push(callback);
  }

  write(_data: string): void {}

  resize(_cols: number, _rows: number): void {}

  kill(): void {
    this.emitExit();
  }

  emitExit(exitCode = 0): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

interface CapturedSpawn {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  pty: FakePty;
}

function createPtyFactory(
  captured: CapturedSpawn[],
  factoryOptions: { exitImmediately?: boolean } = {},
): TerminalPtyFactory {
  return {
    spawn(command, args, spawnOptions) {
      const pty = new FakePty();
      captured.push({
        command,
        args,
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        pty,
      });
      if (factoryOptions.exitImmediately) queueMicrotask(() => pty.emitExit(17));
      return pty;
    },
  };
}

function createManager(
  captured: CapturedSpawn[],
  options: { exitImmediately?: boolean } = {},
  delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [],
) {
  const manager = new modules.TerminalManager(
    (connectionId, message) => delivered.push({ connectionId, message }),
    async () => createPtyFactory(captured, options),
    undefined,
    {
      createHeadlessModel: (cols, rows) => {
        let data = '';
        return {
          write: (chunk) => { data += chunk; },
          resize: () => {},
          snapshot: async () => ({ data, cols, rows, alternateScreen: false }),
          readVisibleText: () => data,
          dispose: () => {},
        };
      },
    },
  );
  managers.push(manager);
  return manager;
}

function createTerminalSession(
  sessionId: string,
  provider: string,
  providerState: Record<string, unknown> = { kind: 'terminal' },
): void {
  modules.sessions.createSession(
    sessionId,
    'provider-launch-project',
    sessionId,
    provider,
    {
      workDir: workspace,
      providerState: JSON.stringify(providerState),
    },
  );
}

async function launchDetached(
  manager: InstanceType<Modules['TerminalManager']>,
  sessionId: string,
  initialPrompt?: string,
): Promise<void> {
  const launcher = modules.createProviderLaunchModule({ terminalManager: manager });
  await launcher.launch({
    sessionId,
    userId: 'provider-launch-user',
    mode: 'detached',
    ...(initialPrompt === undefined ? {} : { initialPrompt }),
  });
}

test('surface and detached launches make the same fresh OpenCode argv decision', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  const launcher = modules.createProviderLaunchModule({ terminalManager: manager });
  for (const sessionId of ['surface-opencode', 'detached-opencode']) {
    createTerminalSession(sessionId, 'opencode');
  }

  await launcher.launch({
    sessionId: 'surface-opencode',
    userId: 'provider-launch-user',
    initialPrompt: '-inspect\nthis worktree',
    mode: 'surface',
    surface: {
      connectionId: 'connection-one',
      surfaceId: 'surface-one',
      terminalId: 'session-surface-opencode',
    },
  });
  const reattached = await launcher.launch({
    sessionId: 'surface-opencode',
    userId: 'provider-launch-user',
    mode: 'surface',
    surface: {
      connectionId: 'connection-two',
      surfaceId: 'surface-two',
      terminalId: 'different-client-proposal',
    },
  });
  assert.deepEqual(reattached, {
    terminalId: 'session-surface-opencode',
    attachedToExistingRuntime: true,
  });
  assert.equal(captured.length, 1);
  await manager.closeSession('surface-opencode', 'provider-launch-user');

  await launcher.launch({
    sessionId: 'detached-opencode',
    userId: 'provider-launch-user',
    initialPrompt: '-inspect\nthis worktree',
    mode: 'detached',
  });

  assert.equal(captured.length, 2);
  assert.deepEqual(
    { command: captured[0].command, args: captured[0].args },
    { command: captured[1].command, args: captured[1].args },
  );
  assert.match(
    captured[0].args.join('\n'),
    /exec 'opencode' '--prompt' '-inspect\nthis worktree'/,
  );

  await manager.closeSession('detached-opencode', 'provider-launch-user');
});

test('an immediate provider exit after detached spawn keeps the durable Session', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured, { exitImmediately: true });
  const launcher = modules.createProviderLaunchModule({ terminalManager: manager });
  createTerminalSession('immediate-exit-opencode', 'opencode');

  const launched = await launcher.launch({
    sessionId: 'immediate-exit-opencode',
    userId: 'provider-launch-user',
    initialPrompt: 'Exit after this instruction',
    mode: 'detached',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(launched.terminalId, 'session-immediate-exit-opencode');
  assert.equal(captured.length, 1);
  assert.ok(modules.sessions.getSession('immediate-exit-opencode'));
  assert.deepEqual(manager.getRuntimeSummary(), { activeCount: 0, sessionCount: 0 });
});

test('a surface attaches to the detached runtime and restores its existing screen', async () => {
  const captured: CapturedSpawn[] = [];
  const delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [];
  const manager = createManager(captured, {}, delivered);
  const launcher = modules.createProviderLaunchModule({ terminalManager: manager });
  createTerminalSession('detached-then-surface', 'opencode');

  const detached = await launcher.launch({
    sessionId: 'detached-then-surface',
    userId: 'provider-launch-user',
    initialPrompt: 'Keep running',
    mode: 'detached',
  });
  captured[0]?.pty.emitData('screen-before-attach');
  const attached = await launcher.launch({
    sessionId: 'detached-then-surface',
    userId: 'provider-launch-user',
    mode: 'surface',
    surface: {
      connectionId: 'later-connection',
      surfaceId: 'later-surface',
      terminalId: 'different-client-proposal',
    },
  });

  assert.deepEqual(attached, {
    terminalId: detached.terminalId,
    attachedToExistingRuntime: true,
  });
  assert.equal(captured.length, 1);
  const snapshot = delivered.find(({ message }) => message.type === 'terminal_snapshot')?.message;
  assert.ok(snapshot && snapshot.type === 'terminal_snapshot');
  if (snapshot?.type === 'terminal_snapshot') {
    assert.match(snapshot.data, /screen-before-attach/);
  }
});

test('detached launch joins a surface that reaches terminal opening after reservation', async () => {
  const captured: CapturedSpawn[] = [];
  const delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [];
  let releasePtyLoader!: () => void;
  let reportPtyLoaderReached!: () => void;
  const ptyLoaderGate = new Promise<void>((resolve) => { releasePtyLoader = resolve; });
  const ptyLoaderReached = new Promise<void>((resolve) => { reportPtyLoaderReached = resolve; });
  const manager = new modules.TerminalManager(
    (connectionId, message) => delivered.push({ connectionId, message }),
    async () => {
      reportPtyLoaderReached();
      await ptyLoaderGate;
      return createPtyFactory(captured);
    },
    undefined,
    {
      createHeadlessModel: (cols, rows) => {
        let data = '';
        return {
          write: (chunk) => { data += chunk; },
          resize: () => {},
          snapshot: async () => ({ data, cols, rows, alternateScreen: false }),
          readVisibleText: () => data,
          dispose: () => {},
        };
      },
    },
  );
  managers.push(manager);
  createTerminalSession('detached-surface-race', 'opencode');

  let releaseDetachedStart!: () => void;
  let reportDetachedStartReached!: () => void;
  const detachedStartGate = new Promise<void>((resolve) => { releaseDetachedStart = resolve; });
  const detachedStartReached = new Promise<void>((resolve) => { reportDetachedStartReached = resolve; });
  const startDetached = manager.startDetached.bind(manager);
  manager.startDetached = async (options) => {
    reportDetachedStartReached();
    await detachedStartGate;
    return startDetached(options);
  };

  const launcher = modules.createProviderLaunchModule({ terminalManager: manager });
  const detached = launcher.launch({
    sessionId: 'detached-surface-race',
    userId: 'provider-launch-user',
    initialPrompt: 'Keep this durable Session',
    mode: 'detached',
  });
  await detachedStartReached;

  const surface = launcher.launch({
    sessionId: 'detached-surface-race',
    userId: 'provider-launch-user',
    mode: 'surface',
    surface: {
      connectionId: 'race-connection',
      surfaceId: 'race-surface',
      terminalId: 'surface-proposal',
    },
  });
  let surfaceSettled = false;
  void surface.finally(() => { surfaceSettled = true; }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(surfaceSettled, false);
  releaseDetachedStart();
  await ptyLoaderReached;
  assert.equal(
    manager.getLaunchRuntimeState(
      'session-detached-surface-race',
      'provider-launch-user',
      'detached-surface-race',
    ),
    'opening',
  );
  releasePtyLoader();

  const [detachedResult, surfaceResult] = await Promise.all([detached, surface]);
  assert.equal(detachedResult.terminalId, surfaceResult.terminalId);
  assert.equal(
    manager.getLaunchRuntimeState(
      detachedResult.terminalId,
      'provider-launch-user',
      'detached-surface-race',
    ),
    'spawned',
  );
  assert.equal(captured.length, 1);
  assert.match(
    captured[0]?.args.join('\n') ?? '',
    /--prompt' 'Keep this durable Session'/,
  );
  assert.ok(modules.sessions.getSession('detached-surface-race'));
  const starts = delivered.filter(({ message }) => message.type === 'terminal_started');
  assert.equal(starts.length, 1);
  assert.equal(
    starts[0]?.message.type === 'terminal_started' ? starts[0].message.terminalId : undefined,
    detachedResult.terminalId,
  );
});

test('concurrent surface launches preserve the first initial prompt and create one runtime', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  createTerminalSession('concurrent-surface-opencode', 'opencode');

  let releaseFirstCreate!: () => void;
  let reportFirstCreateReached!: () => void;
  const firstCreateGate = new Promise<void>((resolve) => { releaseFirstCreate = resolve; });
  const firstCreateReached = new Promise<void>((resolve) => { reportFirstCreateReached = resolve; });
  const create = manager.create.bind(manager);
  let createCalls = 0;
  manager.create = async (options) => {
    createCalls += 1;
    if (createCalls === 1) {
      reportFirstCreateReached();
      await firstCreateGate;
    }
    return create(options);
  };

  const launcher = modules.createProviderLaunchModule({ terminalManager: manager });
  const first = launcher.launch({
    sessionId: 'concurrent-surface-opencode',
    userId: 'provider-launch-user',
    initialPrompt: 'first instruction wins',
    mode: 'surface',
    surface: {
      connectionId: 'first-connection',
      surfaceId: 'first-surface',
      terminalId: 'session-concurrent-surface-opencode',
    },
  });
  await firstCreateReached;

  await assert.rejects(
    launcher.launch({
      sessionId: 'concurrent-surface-opencode',
      userId: 'provider-launch-user',
      initialPrompt: 'must not replace the first instruction',
      mode: 'surface',
      surface: {
        connectionId: 'rejected-connection',
        surfaceId: 'rejected-surface',
        terminalId: 'another-client-proposal',
      },
    }),
    (error: unknown) => error instanceof modules.ProviderLaunchError
      && error.code === 'SESSION_NOT_FRESH',
  );

  const second = launcher.launch({
    sessionId: 'concurrent-surface-opencode',
    userId: 'provider-launch-user',
    mode: 'surface',
    surface: {
      connectionId: 'second-connection',
      surfaceId: 'second-surface',
      terminalId: 'different-client-proposal',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstCreate();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.terminalId, secondResult.terminalId);
  assert.equal(createCalls, 2);
  assert.equal(captured.length, 1);
  assert.match(captured[0]?.args.join('\n') ?? '', /--prompt' 'first instruction wins'/);
});

test('an existing surface rejects an initial prompt and reattaches without workspace metadata', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  const launcher = modules.createProviderLaunchModule({ terminalManager: manager });
  createTerminalSession('surface-reattach-without-workspace', 'opencode');

  await launcher.launch({
    sessionId: 'surface-reattach-without-workspace',
    userId: 'provider-launch-user',
    mode: 'surface',
    surface: {
      connectionId: 'initial-connection',
      surfaceId: 'initial-surface',
      terminalId: 'session-surface-reattach-without-workspace',
    },
  });
  modules.sessions.updateSession('surface-reattach-without-workspace', {
    project_id: null,
    work_dir: null,
  });

  await assert.rejects(
    launcher.launch({
      sessionId: 'surface-reattach-without-workspace',
      userId: 'provider-launch-user',
      initialPrompt: 'must not be ignored',
      mode: 'surface',
      surface: {
        connectionId: 'rejected-connection',
        surfaceId: 'rejected-surface',
        terminalId: 'different-client-proposal',
      },
    }),
    (error: unknown) => error instanceof modules.ProviderLaunchError
      && error.code === 'SESSION_NOT_FRESH',
  );
  const attached = await launcher.launch({
    sessionId: 'surface-reattach-without-workspace',
    userId: 'provider-launch-user',
    mode: 'surface',
    surface: {
      connectionId: 'reattach-connection',
      surfaceId: 'reattach-surface',
      terminalId: 'another-client-proposal',
    },
  });

  assert.deepEqual(attached, {
    terminalId: 'session-surface-reattach-without-workspace',
    attachedToExistingRuntime: true,
  });
  assert.equal(captured.length, 1);
});

test('concurrent detached launches reject the loser without revoking the winning pane token', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  const launcher = modules.createProviderLaunchModule({ terminalManager: manager });
  createTerminalSession('concurrent-detached-opencode', 'opencode');
  const request = {
    sessionId: 'concurrent-detached-opencode',
    userId: 'provider-launch-user',
    mode: 'detached' as const,
  };

  const results = await Promise.allSettled([
    launcher.launch(request),
    launcher.launch(request),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof modules.ProviderLaunchError);
  assert.equal(rejected.reason.code, 'SESSION_RUNTIME_ALREADY_RUNNING');
  assert.equal(captured.length, 1);
  const paneToken = captured[0]?.env?.TESSERA_PANE_TOKEN;
  assert.ok(paneToken);
  assert.deepEqual(modules.resolvePaneToken(paneToken), {
    terminalId: 'session-concurrent-detached-opencode',
    userId: 'provider-launch-user',
    sessionId: 'concurrent-detached-opencode',
    providerId: 'opencode',
  });
});

test('fresh and resumed launches preserve each provider wrapper contract', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  const prompt = '-leading-option\nsecond line';
  const launches = [
    {
      sessionId: 'contract-claude-fresh',
      provider: 'claude-code',
      state: { kind: 'terminal' },
      prompt,
      expected: /exec 'claude' '--session-id' 'contract-claude-fresh' '--settings' [\s\S]* '--' '-leading-option\nsecond line'$/,
    },
    {
      sessionId: 'contract-codex-fresh',
      provider: 'codex',
      state: { kind: 'terminal' },
      prompt,
      expected: /exec 'codex' '--' '-leading-option\nsecond line'/,
    },
    {
      sessionId: 'contract-opencode-fresh',
      provider: 'opencode',
      state: { kind: 'terminal' },
      prompt,
      expected: /exec 'opencode' '--prompt' '-leading-option\nsecond line'/,
    },
    {
      sessionId: 'contract-claude-resume',
      provider: 'claude-code',
      state: {
        kind: 'terminal',
        terminalProviderSessionId: 'claude-provider-resume',
        terminalProviderSessionActivation: 'active',
      },
      expected: /exec 'claude' '--resume' 'claude-provider-resume' '--settings' /,
    },
    {
      sessionId: 'contract-codex-resume',
      provider: 'codex',
      state: { kind: 'terminal', codexSessionId: 'codex-provider-resume' },
      expected: /exec 'codex' 'resume' 'codex-provider-resume'/,
    },
    {
      sessionId: 'contract-opencode-resume',
      provider: 'opencode',
      state: { kind: 'terminal', opencodeTerminalSessionId: 'opencode-provider-resume' },
      expected: /exec 'opencode' '--session' 'opencode-provider-resume'/,
    },
  ];

  for (const launch of launches) {
    createTerminalSession(launch.sessionId, launch.provider, launch.state);
    await launchDetached(manager, launch.sessionId, launch.prompt);
    const spawned = captured.at(-1);
    assert.ok(spawned);
    assert.match(spawned.args.join('\n'), launch.expected);
    await manager.closeSession(launch.sessionId, 'provider-launch-user');
  }

  assert.equal(captured.length, launches.length);
});

test('initial prompt validation uses the exact UTF-8 byte boundary for every provider', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  const exactBoundary = `${'é'.repeat(8_191)}aa`;
  const tooLarge = `${exactBoundary}a`;
  assert.equal(Buffer.byteLength(exactBoundary, 'utf8'), 16_384);
  assert.equal(Buffer.byteLength(tooLarge, 'utf8'), 16_385);

  for (const provider of ['claude-code', 'codex', 'opencode']) {
    const acceptedSessionId = `boundary-accepted-${provider}`;
    createTerminalSession(acceptedSessionId, provider);
    await launchDetached(manager, acceptedSessionId, exactBoundary);
    await manager.closeSession(acceptedSessionId, 'provider-launch-user');

    const rejectedSessionId = `boundary-rejected-${provider}`;
    createTerminalSession(rejectedSessionId, provider);
    await assert.rejects(
      launchDetached(manager, rejectedSessionId, tooLarge),
      (error: unknown) => error instanceof modules.ProviderLaunchError
        && error.code === 'INITIAL_PROMPT_TOO_LARGE',
    );
  }

  assert.equal(captured.length, 3);
});

test('initial prompts reject whitespace and every resumed provider conversation before spawn', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  createTerminalSession('prompt-whitespace', 'codex');
  await assert.rejects(
    launchDetached(manager, 'prompt-whitespace', ' \n\t '),
    (error: unknown) => error instanceof modules.ProviderLaunchError
      && error.code === 'INITIAL_PROMPT_EMPTY',
  );

  const resumed = [
    {
      sessionId: 'prompt-resume-claude',
      provider: 'claude-code',
      state: {
        kind: 'terminal',
        terminalProviderSessionId: 'prompt-claude-provider',
        terminalProviderSessionActivation: 'active',
      },
    },
    {
      sessionId: 'prompt-resume-codex',
      provider: 'codex',
      state: { kind: 'terminal', codexSessionId: 'prompt-codex-provider' },
    },
    {
      sessionId: 'prompt-resume-opencode',
      provider: 'opencode',
      state: { kind: 'terminal', opencodeTerminalSessionId: 'prompt-opencode-provider' },
    },
  ];
  for (const item of resumed) {
    createTerminalSession(item.sessionId, item.provider, item.state);
    await assert.rejects(
      launchDetached(manager, item.sessionId, 'must not be pasted later'),
      (error: unknown) => error instanceof modules.ProviderLaunchError
        && error.code === 'SESSION_NOT_FRESH',
    );
  }

  assert.equal(captured.length, 0);
});

test('launch resolves a Session checkout from its parent Worktree', async () => {
  const parentPath = path.join(testRoot, 'parent-owned-worktree');
  const staleChildPath = path.join(testRoot, 'stale-child-worktree');
  fs.mkdirSync(parentPath, { recursive: true });
  fs.mkdirSync(staleChildPath, { recursive: true });
  modules.tasks.createTask({
    id: 'provider-launch-parent',
    projectId: 'provider-launch-project',
    title: 'Provider launch parent',
  });
  modules.sessions.createSession(
    'parent-owned-session',
    'provider-launch-project',
    'Parent-owned Session',
    'opencode',
    {
      taskId: 'provider-launch-parent',
      workDir: staleChildPath,
      providerState: JSON.stringify({ kind: 'terminal' }),
    },
  );
  modules.tasks.setTaskWorktreeCheckout('provider-launch-parent', {
    branch: 'feature/provider-launch-parent',
    path: parentPath,
  });

  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  await launchDetached(manager, 'parent-owned-session');

  assert.equal(captured[0]?.cwd, parentPath);
  await manager.closeSession('parent-owned-session', 'provider-launch-user');
});

test('detached preparation gates fail closed while the surface adapter keeps its timeout behavior', async () => {
  const worktreePath = path.join(testRoot, 'preparation-worktree');
  fs.mkdirSync(worktreePath, { recursive: true });
  modules.tasks.createTask({
    id: 'provider-launch-preparation',
    projectId: 'provider-launch-project',
    title: 'Provider launch preparation',
  });
  modules.tasks.setTaskWorktreeCheckout('provider-launch-preparation', {
    branch: 'feature/provider-launch-preparation',
    path: worktreePath,
  });
  modules.sessions.createSession(
    'preparation-session',
    'provider-launch-project',
    'Preparation Session',
    'opencode',
    {
      taskId: 'provider-launch-preparation',
      providerState: JSON.stringify({ kind: 'terminal' }),
    },
  );
  assert.equal(modules.taskPreparation.startTaskPreparation(
    'provider-launch-preparation',
    { before: 'prepare-before', after: null },
  ), true);

  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  const launcher = modules.createProviderLaunchModule({
    terminalManager: manager,
    preparationTimeoutMs: 1,
  });
  await assert.rejects(
    launcher.launch({
      sessionId: 'preparation-session',
      userId: 'provider-launch-user',
      mode: 'detached',
    }),
    (error: unknown) => error instanceof modules.ProviderLaunchError
      && error.code === 'PREPARATION_TIMEOUT',
  );

  let surfaceWaitNotifications = 0;
  await launcher.launch({
    sessionId: 'preparation-session',
    userId: 'provider-launch-user',
    mode: 'surface',
    surface: {
      connectionId: 'preparation-connection',
      surfaceId: 'preparation-surface',
      terminalId: 'session-preparation-session',
      onAwaitingPreparation: () => { surfaceWaitNotifications += 1; },
    },
  });
  assert.equal(surfaceWaitNotifications, 1);
  assert.equal(captured.length, 1);
  await manager.closeSession('preparation-session', 'provider-launch-user');

  assert.equal(modules.taskPreparation.finishPreparationStage(
    'provider-launch-preparation',
    1,
    'failed before',
  )?.status, 'failed');
  await assert.rejects(
    launcher.launch({
      sessionId: 'preparation-session',
      userId: 'provider-launch-user',
      mode: 'detached',
    }),
    (error: unknown) => error instanceof modules.ProviderLaunchError
      && error.code === 'PREPARATION_FAILED',
  );
  await launcher.launch({
    sessionId: 'preparation-session',
    userId: 'provider-launch-user',
    mode: 'detached',
    allowPreparationFailure: true,
  });
  assert.equal(captured.length, 2);
  await manager.closeSession('preparation-session', 'provider-launch-user');
});

test('a pre-spawn failure releases the reservation, pane token, and native OpenCode overlay', async () => {
  let spawnEnv: NodeJS.ProcessEnv | undefined;
  const manager = new modules.TerminalManager(
    () => {},
    async () => ({
      spawn(_command, _args, options) {
        spawnEnv = options.env;
        throw new Error('fake PTY spawn failed');
      },
    }),
  );
  managers.push(manager);
  createTerminalSession('cleanup-opencode', 'opencode');
  const observerDisposalsBefore = observerDisposeCounts.get('opencode') ?? 0;

  await assert.rejects(
    launchDetached(manager, 'cleanup-opencode', 'cleanup evidence'),
    (error: unknown) => error instanceof modules.ProviderLaunchError
      && error.code === 'LAUNCH_FAILED'
      && error.message === 'fake PTY spawn failed',
  );

  const paneToken = spawnEnv?.TESSERA_PANE_TOKEN;
  const overlayDir = spawnEnv?.OPENCODE_CONFIG_DIR;
  assert.ok(paneToken);
  assert.ok(overlayDir);
  assert.equal(modules.resolvePaneToken(paneToken), null);
  assert.equal(fs.existsSync(overlayDir), false);
  assert.equal(observerDisposeCounts.get('opencode'), observerDisposalsBefore + 1);
  assert.equal(
    manager.reserveTerminalId(
      'provider-launch-user',
      'replacement-terminal',
      'cleanup-opencode',
    ),
    'replacement-terminal',
  );
  manager.releaseTerminalReservation(
    'provider-launch-user',
    'cleanup-opencode',
    'replacement-terminal',
  );
});
