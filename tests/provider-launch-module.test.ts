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
  selection: { model?: string; reasoningEffort?: string; serviceTier?: string } = {},
): void {
  modules.sessions.createSession(
    sessionId,
    'provider-launch-project',
    sessionId,
    provider,
    {
      workDir: workspace,
      providerState: JSON.stringify(providerState),
      ...selection,
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

test('launch preparation finalizes provider argv before shell resolution', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  createTerminalSession('prepared-launch-argv', 'claude-code');
  const launchSpec = {
    program: 'claude',
    args: ['--plugin-dir', '__pending_plugin_dir__'],
  };

  await manager.startDetached({
    userId: 'provider-launch-user',
    terminalId: 'session-prepared-launch-argv',
    cwd: workspace,
    sessionId: 'prepared-launch-argv',
    launchSpec,
    prepareLaunch: async () => {
      launchSpec.args[1] = '/home/agent/.tessera/claude-overlay/session/';
    },
  });

  assert.match(
    captured[0]?.args.join(' ') ?? '',
    /\/home\/agent\/\.tessera\/claude-overlay\/session\//,
  );
  assert.doesNotMatch(captured[0]?.args.join(' ') ?? '', /__pending_plugin_dir__/);
  await manager.closeSession('prepared-launch-argv', 'provider-launch-user');
});

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

test('persisted Claude and Codex selections reach the provider PTY argv', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  createTerminalSession(
    'selected-codex',
    'codex',
    { kind: 'terminal' },
    { model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' },
  );
  createTerminalSession(
    'selected-claude',
    'claude-code',
    { kind: 'terminal' },
    { model: 'claude-opus-4-8', reasoningEffort: 'xhigh' },
  );

  await launchDetached(manager, 'selected-codex');
  await launchDetached(manager, 'selected-claude');

  const codexShell = captured[0]?.args.join('\n') ?? '';
  assert.match(codexShell, /exec 'codex' '--model' 'gpt-5\.6-sol'/);
  assert.match(codexShell, /'--config' 'model_reasoning_effort="high"'/);
  assert.match(codexShell, /'--config' 'service_tier="fast"'/);

  const claudeShell = captured[1]?.args.join('\n') ?? '';
  assert.match(claudeShell, /exec 'claude' '--session-id' 'selected-claude'/);
  assert.match(claudeShell, /'--model' 'claude-opus-4-8'/);
  assert.match(claudeShell, /"effortLevel":"xhigh"/);

  await manager.closeSession('selected-codex', 'provider-launch-user');
  await manager.closeSession('selected-claude', 'provider-launch-user');
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

test('a headless Session reaches turn-complete, reads output, then attaches the same runtime and screen', async () => {
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
  const completed = manager.waitForSessionState(
    'detached-then-surface',
    'provider-launch-user',
    'turn-complete',
    1_000,
  );
  captured[0]?.pty.emitData('screen-before-attach');
  manager.recordSessionState({
    type: 'session_state',
    sessionId: 'detached-then-surface',
    terminalId: detached.terminalId,
    status: 'completed',
    hookEvent: 'Stop',
    stateAt: 1234,
  }, 'provider-launch-user');
  const observed = await completed;
  assert.equal(observed.runtimeState, 'turn-complete');
  assert.equal(observed.terminalId, detached.terminalId);
  assert.match(observed.screen, /screen-before-attach/);
  assert.deepEqual(
    await manager.readSessionSnapshot('detached-then-surface', 'provider-launch-user'),
    observed,
  );
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
    assert.equal(snapshot.terminalId, observed.terminalId);
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

test('shared provider launches inject the complete control bridge environment for every provider', async () => {
  const providers = ['claude-code', 'codex', 'opencode'];
  const agentEnvironments = ['native', 'wsl'] as const;
  for (const agentEnvironment of agentEnvironments) {
    for (const provider of providers) {
    const captured: CapturedSpawn[] = [];
    const manager = createManager(captured);
    const taskId = `control-context-${agentEnvironment}-${provider}`;
    const publicWorktreeId = modules.tasks.createTask({
      id: taskId,
      projectId: 'provider-launch-project',
      title: `Control context ${provider}`,
      worktreePath: workspace,
    });
    const sessionId = `control-context-session-${agentEnvironment}-${provider}`;
    modules.sessions.createSession(
      sessionId,
      'provider-launch-project',
      sessionId,
      provider,
      {
        taskId,
        providerState: JSON.stringify({ kind: 'terminal' }),
      },
    );
    const disposed: string[] = [];
    const launcher = modules.createProviderLaunchModule({
      terminalManager: manager,
      resolveAgentEnvironment: async () => agentEnvironment,
      resolveTesseraCliEnabled: async () => true,
      prepareControlCliBridge: async (context) => {
        assert.deepEqual(context, {
          agentEnvironment,
          projectId: 'provider-launch-project',
          sessionId,
          worktreeId: publicWorktreeId,
        });
        return {
          commandPath: `/home/test/.cache/tessera/${sessionId}/tessera`,
          environment: {
            TESSERA_ENV: '1',
            TESSERA_CLI_COMMAND: `/home/test/.cache/tessera/${sessionId}/tessera`,
            TESSERA_PROJECT_ID: 'provider-launch-project',
            TESSERA_SESSION_ID: sessionId,
            TESSERA_WORKTREE_ID: publicWorktreeId,
          },
          dispose: async () => { disposed.push(sessionId); },
        };
      },
    });

    await launcher.launch({
      sessionId,
      userId: 'provider-launch-user',
      mode: 'detached',
    });

    const childEnv = captured[0]?.env;
    assert.equal(childEnv?.TESSERA_ENV, '1');
    assert.equal(
      childEnv?.TESSERA_CLI_COMMAND,
      `/home/test/.cache/tessera/${sessionId}/tessera`,
    );
    assert.equal(childEnv?.TESSERA_PROJECT_ID, 'provider-launch-project');
    assert.equal(childEnv?.TESSERA_SESSION_ID, sessionId);
    assert.equal(childEnv?.TESSERA_WORKTREE_ID, publicWorktreeId);
    if (agentEnvironment === 'wsl') {
      for (const key of [
        'TESSERA_ENV',
        'TESSERA_CLI_COMMAND',
        'TESSERA_PROJECT_ID',
        'TESSERA_SESSION_ID',
        'TESSERA_WORKTREE_ID',
      ]) {
        assert.equal(
          childEnv?.WSLENV?.split(':').some((entry) => entry.split('/')[0] === key),
          true,
          `${provider} WSLENV should contain ${key}`,
        );
      }
    }
    assert.equal(childEnv?.TESSERA_CONTROL_DESCRIPTOR, undefined);
    assert.equal(childEnv?.TESSERA_CONTROL_DESCRIPTOR_PATH, undefined);

    let providerSkillPath: string;
    if (provider === 'claude-code') {
      const pluginDir = captured[0]?.args.join(' ').match(/'--plugin-dir' '([^']+)'/)?.[1];
      assert.ok(pluginDir, 'Claude launch should include its Tessera plugin overlay');
      providerSkillPath = path.join(pluginDir, 'skills', 'tessera-cli', 'SKILL.md');
    } else if (provider === 'codex') {
      assert.ok(childEnv?.CODEX_HOME, 'Codex launch should include its overlay home');
      providerSkillPath = path.join(
        childEnv.CODEX_HOME,
        'skills',
        'tessera-cli',
        'SKILL.md',
      );
    } else {
      assert.ok(
        childEnv?.OPENCODE_CONFIG_DIR,
        'OpenCode launch should include its overlay config directory',
      );
      providerSkillPath = path.join(
        childEnv.OPENCODE_CONFIG_DIR,
        'skills',
        'tessera-cli',
        'SKILL.md',
      );
    }
    assert.equal(
      fs.readFileSync(providerSkillPath, 'utf8'),
      fs.readFileSync(path.join(process.cwd(), 'skills', 'tessera-cli', 'SKILL.md'), 'utf8'),
    );

    await manager.closeSession(sessionId, 'provider-launch-user');
    assert.equal(fs.existsSync(providerSkillPath), false);
    assert.deepEqual(disposed, [sessionId]);
    }
  }
});

test('disabled Tessera CLI omits the bridge and canonical skill while retaining lifecycle overlays', async () => {
  const previousCliCommand = process.env.TESSERA_CLI_COMMAND;
  process.env.TESSERA_CLI_COMMAND = '/stale/parent/tessera';
  try {
    for (const provider of ['claude-code', 'codex', 'opencode']) {
      const captured: CapturedSpawn[] = [];
      const manager = createManager(captured);
      const sessionId = `control-disabled-${provider}`;
      createTerminalSession(sessionId, provider);
      let bridgeCalls = 0;
      const launcher = modules.createProviderLaunchModule({
        terminalManager: manager,
        resolveTesseraCliEnabled: async () => false,
        prepareControlCliBridge: async () => {
          bridgeCalls += 1;
          throw new Error('bridge must not be prepared while disabled');
        },
      });

      await launcher.launch({
        sessionId,
        userId: 'provider-launch-user',
        mode: 'detached',
      });

      const spawned = captured[0];
      assert.equal(bridgeCalls, 0);
      assert.equal(spawned?.env?.TESSERA_CLI_COMMAND, undefined);
      if (provider === 'claude-code') {
        assert.doesNotMatch(spawned?.args.join(' ') ?? '', /--plugin-dir/);
      } else if (provider === 'codex') {
        assert.ok(spawned?.env?.CODEX_HOME);
        assert.equal(
          fs.existsSync(path.join(spawned.env.CODEX_HOME, 'skills', 'tessera-cli')),
          false,
        );
        assert.equal(fs.existsSync(path.join(spawned.env.CODEX_HOME, 'hooks.json')), true);
      } else {
        assert.ok(spawned?.env?.OPENCODE_CONFIG_DIR);
        assert.equal(
          fs.existsSync(path.join(spawned.env.OPENCODE_CONFIG_DIR, 'skills', 'tessera-cli')),
          false,
        );
        assert.equal(
          fs.existsSync(path.join(
            spawned.env.OPENCODE_CONFIG_DIR,
            'plugins',
            'tessera-lifecycle.js',
          )),
          true,
        );
      }
      await manager.closeSession(sessionId, 'provider-launch-user');
    }
  } finally {
    if (previousCliCommand === undefined) delete process.env.TESSERA_CLI_COMMAND;
    else process.env.TESSERA_CLI_COMMAND = previousCliCommand;
  }
});

test('managed fake-provider launches discover the canonical skill in a WSL-like environment', async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousTestInstance = process.env.TESSERA_ELECTRON_TEST_INSTANCE;
  const guestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-managed-wsl-skill-'));
  const fakeBin = path.join(guestHome, 'bin');
  const fakeWsl = path.join(fakeBin, 'wsl.exe');
  const userFiles = [
    path.join(guestHome, '.claude/settings.json'),
    path.join(guestHome, '.codex/skills/tessera-cli/SKILL.md'),
    path.join(guestHome, '.config/opencode/skills/tessera-cli/SKILL.md'),
  ];
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  const sessionIds = ['managed-wsl-claude-code', 'managed-wsl-codex', 'managed-wsl-opencode'];
  const transientOverlayDirs: string[] = [];

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    fakeWsl,
    '#!/bin/sh\n[ "$1" = "--exec" ] || exit 64\nshift\nexec "$@"\n',
    { mode: 0o755 },
  );
  for (const userFile of userFiles) {
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, `user-owned:${path.basename(userFile)}\n`);
  }

  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: 'win32',
  });
  process.env.HOME = guestHome;
  process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
  process.env.CODEX_HOME = 'C:\\host\\must-not-be-read';
  delete process.env.TESSERA_ELECTRON_TEST_INSTANCE;

  try {
    const launcher = modules.createProviderLaunchModule({
      terminalManager: manager,
      resolveAgentEnvironment: async () => 'wsl',
      resolveTesseraCliEnabled: async () => true,
      prepareControlCliBridge: async ({ projectId, sessionId }) => ({
        commandPath: `/home/agent/.tessera/control/${sessionId}/tessera`,
        environment: {
          TESSERA_ENV: '1',
          TESSERA_CLI_COMMAND: `/home/agent/.tessera/control/${sessionId}/tessera`,
          TESSERA_PROJECT_ID: projectId,
          TESSERA_SESSION_ID: sessionId,
        },
        dispose: async () => {},
      }),
    });

    for (const [index, provider] of ['claude-code', 'codex', 'opencode'].entries()) {
      const sessionId = sessionIds[index]!;
      createTerminalSession(sessionId, provider);
      await launcher.launch({
        sessionId,
        userId: 'provider-launch-user',
        initialPrompt: `discover ${provider}`,
        mode: 'detached',
      });

      const spawned = captured[index];
      assert.equal(spawned?.command, 'wsl.exe');
      assert.equal(spawned?.env?.TESSERA_ENV, '1');
      assert.equal(
        spawned?.env?.TESSERA_CLI_COMMAND,
        `/home/agent/.tessera/control/${sessionId}/tessera`,
      );
      assert.equal(
        spawned?.env?.WSLENV?.split(':').some((entry) => entry === 'TESSERA_CLI_COMMAND'),
        true,
      );

      let skillPath: string;
      if (provider === 'claude-code') {
        const pluginDir = spawned?.args.join(' ').match(/--plugin-dir[^/]*(\/[^'\\ ]+)/)?.[1];
        assert.ok(pluginDir);
        transientOverlayDirs.push(pluginDir);
        skillPath = path.join(pluginDir, 'skills/tessera-cli/SKILL.md');
      } else if (provider === 'codex') {
        assert.ok(spawned?.env?.CODEX_HOME?.startsWith(guestHome));
        transientOverlayDirs.push(spawned.env.CODEX_HOME);
        skillPath = path.join(spawned.env.CODEX_HOME, 'skills/tessera-cli/SKILL.md');
      } else {
        assert.ok(spawned?.env?.OPENCODE_CONFIG_DIR?.startsWith(guestHome));
        skillPath = path.join(
          spawned.env.OPENCODE_CONFIG_DIR,
          'skills/tessera-cli/SKILL.md',
        );
      }
      assert.equal(
        fs.readFileSync(skillPath, 'utf8'),
        fs.readFileSync(path.join(process.cwd(), 'skills/tessera-cli/SKILL.md'), 'utf8'),
      );
    }

    for (const sessionId of sessionIds) {
      await manager.closeSession(sessionId, 'provider-launch-user');
    }
    for (let retry = 0; retry < 50 && transientOverlayDirs.some(fs.existsSync); retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const overlayDir of transientOverlayDirs) {
      assert.equal(fs.existsSync(overlayDir), false);
    }
    for (const userFile of userFiles) {
      assert.equal(
        fs.readFileSync(userFile, 'utf8'),
        `user-owned:${path.basename(userFile)}\n`,
      );
    }
  } finally {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousTestInstance === undefined) delete process.env.TESSERA_ELECTRON_TEST_INSTANCE;
    else process.env.TESSERA_ELECTRON_TEST_INSTANCE = previousTestInstance;
    fs.rmSync(guestHome, { recursive: true, force: true });
  }
});

test('a managed top-level session omits Worktree caller context', async () => {
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  createTerminalSession('control-context-top-level', 'opencode');
  process.env.TESSERA_WORKTREE_ID = 'inherited-wrong-worktree';
  try {
    const launcher = modules.createProviderLaunchModule({
      terminalManager: manager,
      prepareControlCliBridge: async (context) => ({
        commandPath: '/tmp/tessera-top-level',
        environment: {
          TESSERA_ENV: '1',
          TESSERA_CLI_COMMAND: '/tmp/tessera-top-level',
          TESSERA_PROJECT_ID: context.projectId,
          TESSERA_SESSION_ID: context.sessionId,
          TESSERA_WORKTREE_ID: context.worktreeId,
        },
        dispose: async () => {},
      }),
    });
    await launcher.launch({
      sessionId: 'control-context-top-level',
      userId: 'provider-launch-user',
      mode: 'detached',
    });
    assert.equal(captured[0]?.env?.TESSERA_WORKTREE_ID, undefined);
  } finally {
    delete process.env.TESSERA_WORKTREE_ID;
    await manager.closeSession('control-context-top-level', 'provider-launch-user');
  }
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

test('a WSL Claude background attach does not prepare a new plugin overlay', async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: 'win32',
  });
  const captured: CapturedSpawn[] = [];
  const manager = createManager(captured);
  try {
    createTerminalSession('wsl-claude-background-attach', 'claude-code', {
      kind: 'terminal',
      launched: true,
      terminalProviderSessionId: '772b268d-7979-4fe7-aecf-50985ccb652f',
      terminalProviderSessionActivation: 'background',
    });
    const launcher = modules.createProviderLaunchModule({
      terminalManager: manager,
      resolveAgentEnvironment: async () => 'wsl',
    });

    await launcher.launch({
      sessionId: 'wsl-claude-background-attach',
      userId: 'provider-launch-user',
      mode: 'detached',
    });

    assert.match(captured[0]?.args.join(' ') ?? '', /claude.*attach.*772b268d/);
    assert.doesNotMatch(captured[0]?.args.join(' ') ?? '', /--plugin-dir/);
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
    await manager.closeSession('wsl-claude-background-attach', 'provider-launch-user');
  }
});

test('a preparation timeout removes a Codex overlay that only lands after the gate gave up', async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  const guestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-late-codex-overlay-'));
  const fakeBin = path.join(guestHome, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  // Deliberately slow, so creation is still in flight when the gate below gives
  // up — the exact window in which a cleanup keyed on an already-recorded
  // overlay finds nothing and the overlay lands unowned right after it.
  fs.writeFileSync(
    path.join(fakeBin, 'wsl.exe'),
    '#!/bin/sh\n[ "$1" = "--exec" ] || exit 64\nshift\nsleep 1\nexec "$@"\n',
    { mode: 0o755 },
  );

  const worktreePath = path.join(testRoot, 'late-codex-overlay-worktree');
  fs.mkdirSync(worktreePath, { recursive: true });
  modules.tasks.createTask({
    id: 'late-codex-overlay-task',
    projectId: 'provider-launch-project',
    title: 'Late codex overlay',
  });
  modules.tasks.setTaskWorktreeCheckout('late-codex-overlay-task', {
    branch: 'feature/late-codex-overlay',
    path: worktreePath,
  });
  modules.sessions.createSession(
    'late-codex-overlay-session',
    'provider-launch-project',
    'Late codex overlay Session',
    'codex',
    {
      taskId: 'late-codex-overlay-task',
      providerState: JSON.stringify({ kind: 'terminal' }),
    },
  );
  assert.equal(modules.taskPreparation.startTaskPreparation(
    'late-codex-overlay-task',
    { before: 'prepare-before', after: null },
  ), true);

  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: 'win32',
  });
  process.env.HOME = guestHome;
  process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
  const overlayDir = path.join(
    guestHome,
    '.tessera/codex-overlay/session-late-codex-overlay-session',
  );

  try {
    const captured: CapturedSpawn[] = [];
    const manager = createManager(captured);
    const launcher = modules.createProviderLaunchModule({
      terminalManager: manager,
      resolveAgentEnvironment: async () => 'wsl',
      // Shorter than the sleeping guest script, so the gate always loses the race.
      preparationTimeoutMs: 200,
    });

    await assert.rejects(
      launcher.launch({
        sessionId: 'late-codex-overlay-session',
        userId: 'provider-launch-user',
        mode: 'detached',
      }),
      (error: unknown) => error instanceof modules.ProviderLaunchError
        && error.code === 'PREPARATION_TIMEOUT',
    );

    // The creation is still running here, so the directory does not exist yet.
    // Waiting for it to appear first is what makes the assertion below mean
    // anything: checking too early would pass against a leak simply because the
    // overlay had not landed yet.
    let appeared = false;
    for (let retry = 0; retry < 250 && !appeared; retry += 1) {
      appeared = fs.existsSync(overlayDir);
      if (!appeared) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(
      appeared,
      true,
      'the abandoned creation should still land in the guest',
    );

    for (let retry = 0; retry < 250 && fs.existsSync(overlayDir); retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(
      fs.existsSync(overlayDir),
      false,
      'a Codex overlay that lands after the gate gave up must not be left behind',
    );
    assert.equal(captured.length, 0);
  } finally {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(guestHome, { recursive: true, force: true });
  }
});

test('a preparation timeout still removes the WSL overlay whose spawn it abandoned', async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const guestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-abandoned-overlay-'));
  const fakeBin = path.join(guestHome, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, 'wsl.exe'),
    '#!/bin/sh\n[ "$1" = "--exec" ] || exit 64\nshift\nexec "$@"\n',
    { mode: 0o755 },
  );

  const worktreePath = path.join(testRoot, 'abandoned-overlay-worktree');
  fs.mkdirSync(worktreePath, { recursive: true });
  modules.tasks.createTask({
    id: 'abandoned-overlay-task',
    projectId: 'provider-launch-project',
    title: 'Abandoned overlay',
  });
  modules.tasks.setTaskWorktreeCheckout('abandoned-overlay-task', {
    branch: 'feature/abandoned-overlay',
    path: worktreePath,
  });
  modules.sessions.createSession(
    'abandoned-overlay-session',
    'provider-launch-project',
    'Abandoned overlay Session',
    'claude-code',
    {
      taskId: 'abandoned-overlay-task',
      providerState: JSON.stringify({ kind: 'terminal' }),
    },
  );
  // Left running for the whole test, so the gate below has to give up on it.
  assert.equal(modules.taskPreparation.startTaskPreparation(
    'abandoned-overlay-task',
    { before: 'prepare-before', after: null },
  ), true);

  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: 'win32',
  });
  process.env.HOME = guestHome;
  process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
  const overlayDir = path.join(
    guestHome,
    '.tessera/claude-overlay/session-abandoned-overlay-session',
  );

  try {
    const captured: CapturedSpawn[] = [];
    const manager = createManager(captured);
    const launcher = modules.createProviderLaunchModule({
      terminalManager: manager,
      resolveAgentEnvironment: async () => 'wsl',
      resolveTesseraCliEnabled: async () => true,
      preparationTimeoutMs: 1_000,
    });

    const launch = launcher.launch({
      sessionId: 'abandoned-overlay-session',
      userId: 'provider-launch-user',
      mode: 'detached',
    });
    // The overlay is started alongside the gate, so it lands in the guest
    // while the gate is still waiting — and is then abandoned when the gate
    // gives up before any consumer of it is ever reached.
    let created = false;
    for (let retry = 0; retry < 100 && !created; retry += 1) {
      created = fs.existsSync(overlayDir);
      if (!created) await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await assert.rejects(
      launch,
      (error: unknown) => error instanceof modules.ProviderLaunchError
        && error.code === 'PREPARATION_TIMEOUT',
    );
    assert.equal(created, true, 'the overlay should have landed before the gate gave up');
    for (let retry = 0; retry < 100 && fs.existsSync(overlayDir); retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      fs.existsSync(overlayDir),
      false,
      'an abandoned overlay must not be left behind in the guest',
    );
    assert.equal(captured.length, 0);
  } finally {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(guestHome, { recursive: true, force: true });
  }
});

test('a deterministically failing WSL overlay is not retried: Claude launches anyway, Codex does not', async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const guestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-overlay-failing-'));
  const fakeBin = path.join(guestHome, 'bin');
  const fakeWsl = path.join(fakeBin, 'wsl.exe');
  const callLog = path.join(guestHome, 'wsl-calls');
  fs.mkdirSync(fakeBin, { recursive: true });
  // Exits 1 whatever is piped to it: a script that ran and failed, which is the
  // deterministic class a second attempt cannot change. Every invocation is
  // recorded so the absence of a retry is observable rather than assumed.
  fs.writeFileSync(
    fakeWsl,
    `#!/bin/sh\necho call >> ${JSON.stringify(callLog)}\nexit 1\n`,
    { mode: 0o755 },
  );
  const wslCallCount = () => (fs.existsSync(callLog)
    ? fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean).length
    : 0);

  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: 'win32',
  });
  process.env.HOME = guestHome;
  process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

  try {
    const captured: CapturedSpawn[] = [];
    const manager = createManager(captured);
    createTerminalSession('failing-overlay-claude', 'claude-code');
    const launcher = modules.createProviderLaunchModule({
      terminalManager: manager,
      resolveAgentEnvironment: async () => 'wsl',
      resolveTesseraCliEnabled: async () => true,
    });

    await launcher.launch({
      sessionId: 'failing-overlay-claude',
      userId: 'provider-launch-user',
      mode: 'detached',
    });
    assert.doesNotMatch(captured[0]?.args.join(' ') ?? '', /--plugin-dir/);
    assert.equal(
      wslCallCount(),
      1,
      'a script that ran and exited non-zero must not be attempted a second time',
    );
    await manager.closeSession('failing-overlay-claude', 'provider-launch-user');

    // OpenCode's overlay isn't checked here: it's a single promise shared and
    // cached for the whole app process (opencode-overlay-wsl.ts), so a
    // successful run from another test in this file leaves a resolved promise
    // behind that this fake-wsl failure would never see. Codex exercises the
    // exact same launchEnvFactory failure path, so it alone is enough to cover it.
    createTerminalSession('failing-overlay-codex', 'codex');
    await assert.rejects(
      launcher.launch({
        sessionId: 'failing-overlay-codex',
        userId: 'provider-launch-user',
        mode: 'detached',
      }),
      (error: unknown) => error instanceof modules.ProviderLaunchError
        && error.code === 'LAUNCH_FAILED',
      'codex should fail its launch rather than continue without its overlay',
    );
  } finally {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(guestHome, { recursive: true, force: true });
  }
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
