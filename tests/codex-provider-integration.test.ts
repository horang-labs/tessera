import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CliRawLogEvent } from '@/lib/cli/providers/session-types';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-integration-'));
const fakeBin = path.join(testRoot, 'bin');
const fakeCodex = path.join(fakeBin, 'codex');
const workspace = path.join(testRoot, 'workspace');
const authoritativeCodexHome = path.join(testRoot, 'authoritative-codex-home');

process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.CODEX_HOME = authoritativeCodexHome;
process.env.NODE_ENV = 'test';

fs.mkdirSync(fakeBin, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(authoritativeCodexHome, { recursive: true });
fs.writeFileSync(
  fakeCodex,
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
process.stderr.write('provider-home:' + (process.env.CODEX_HOME || '<unset>') + '\\n');
process.stderr.write('legacy-overlay:' + (process.env.TESSERA_CODEX_HOME || '<unset>') + '\\n');
const stateKey = process.env.TESSERA_TEST_CODEX_STATE_KEY;
const statePath = stateKey ? path.join(process.env.CODEX_HOME, stateKey) : null;
if (statePath) process.stderr.write('state-before:' + (fs.existsSync(statePath) ? 'present' : 'absent') + '\\n');
if (process.argv[2] === 'ordinary-state') {
  if (statePath) fs.writeFileSync(statePath, 'provider-owned\\n');
  process.exit(0);
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'thread/start' && statePath) fs.writeFileSync(statePath, 'provider-owned\\n');
  const result = request.method === 'thread/start'
    ? { thread: { id: 'shared-policy-thread' } }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
  { mode: 0o755 },
);

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('Codex app-server launch preserves explicit server-default ownership without a user', async () => {
  const { CodexAdapter } = await import('@/lib/cli/providers/codex/adapter');
  const ownership: unknown[] = [];
  const adapter = new CodexAdapter({
    providerIntegration: {
      resolveLaunch: async (request) => {
        ownership.push(request.agentEnvironmentOwner);
        throw new Error('stop after resolving explicit ownership');
      },
      buildLaunchEnvironment: () => undefined,
      inspectLifecycle: async () => { throw new Error('not used'); },
      installLifecycle: async () => { throw new Error('not used'); },
    },
  });

  await assert.rejects(
    adapter.spawn(workspace, { sessionId: '__provider__' }),
    /stop after resolving explicit ownership/,
  );
  assert.deepEqual(ownership, [{ kind: 'server-default' }]);
});

test('Provider Integration exposes path-free, provider-specific integration state', async () => {
  const [{ CodexAdapter }, { createProviderIntegration }] = await Promise.all([
    import('@/lib/cli/providers/codex/adapter'),
    import('@/lib/cli/provider-integration'),
  ]);
  const providerIntegration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'wsl',
    detectSkillProviders: async () => ['codex'],
    resolveProviderSkillHome: async () => authoritativeCodexHome,
    providerSkillStateDirectory: path.join(testRoot, 'provider-integration-state'),
    lifecycle: {
      inspect: async () => ({ state: 'installed', trust: 'trusted' }),
      install: async () => ({ state: 'installed', trust: 'trusted' }),
    },
  });
  const provider = new CodexAdapter();

  const codex = await providerIntegration.resolveLaunch({
    provider,
    agentEnvironmentOwner: { kind: 'user', userId: 'provider-integration-user' },
  });
  assert.deepEqual({
    owner: codex.providerHome.owner,
    agentEnvironment: codex.providerHome.agentEnvironment,
  }, {
    owner: 'agent-environment',
    agentEnvironment: 'wsl',
  });
  assert.match(codex.providerHome.identity ?? '', /^codex-home:v1:[a-f0-9]{64}$/);
  assert.deepEqual(codex.lifecycle, {
    requirement: 'required',
    state: 'installed',
    consent: 'granted',
    trust: 'trusted',
  });
  assert.deepEqual(codex.skill, {
    requirement: 'optional',
    state: 'absent',
    consent: 'declined',
    trust: 'not-required',
  });
  assert.deepEqual(codex.health, { state: 'unchecked' });
  assert.equal('launchEnvironment' in codex, false);

  await providerIntegration.manageSkills({
    operation: 'install',
    agentEnvironmentOwner: { kind: 'user', userId: 'provider-integration-user' },
    providerIds: ['codex'],
  });
  const codexWithReadyOptionalSkill = await providerIntegration.resolveLaunch({
    provider: new CodexAdapter(),
    agentEnvironmentOwner: { kind: 'user', userId: 'provider-integration-user' },
  });
  assert.equal(codexWithReadyOptionalSkill.skill.state, 'ready');
  assert.equal(codexWithReadyOptionalSkill.health.state, 'unchecked');

  const providerWithoutRequiredLifecycle = await providerIntegration.resolveLaunch({
    provider: {
      getProviderId: () => 'claude-code',
      getProviderIntegrationRequirements: () => ({
        lifecycle: 'not-applicable',
        skill: 'optional',
        launchEnvironment: 'not-applicable',
      }),
    },
    agentEnvironmentOwner: { kind: 'user', userId: 'provider-integration-user' },
  });
  assert.deepEqual(providerWithoutRequiredLifecycle.lifecycle, {
    requirement: 'not-applicable',
    state: 'not-applicable',
    consent: 'not-required',
    trust: 'not-required',
  });
});

test('one Codex home resolution binds lifecycle approval and the launched environment', async () => {
  const [{ CodexAdapter }, { createProviderIntegration }] = await Promise.all([
    import('@/lib/cli/providers/codex/adapter'),
    import('@/lib/cli/provider-integration'),
  ]);
  const firstHome = path.join(testRoot, 'authority-home-a');
  const secondHome = path.join(testRoot, 'authority-home-b');
  const resolvedHomes: string[] = [];
  let resolutionCount = 0;
  const provider = new CodexAdapter({
    resolveProviderHome: async () => {
      resolutionCount += 1;
      return resolutionCount === 1 ? firstHome : secondHome;
    },
    createLifecycleIntegration: (dependencies) => ({
      inspect: async () => {
        const home = await dependencies.resolveProviderHome?.('wsl');
        assert.ok(home);
        resolvedHomes.push(home);
        return { state: 'installed', trust: 'trusted' };
      },
      install: async () => ({ state: 'installed', trust: 'trusted' }),
    }),
  });
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'wsl',
  });

  const decision = await integration.resolveLaunch({
    provider,
    agentEnvironmentOwner: { kind: 'user', userId: 'single-authority-user' },
    workDir: workspace,
  });
  const environment = integration.buildLaunchEnvironment(decision, {
    CODEX_HOME: secondHome,
  });

  assert.equal(resolutionCount, 1);
  assert.deepEqual(resolvedHomes, [firstHome]);
  assert.equal(environment?.CODEX_HOME, firstHome);
  assert.equal(environment?.TESSERA_CODEX_HOME, undefined);
  assert.equal('launchEnvironment' in decision, false);
});

test('app-server preparation exports a custom Windows-backend-to-WSL Codex home', async () => {
  const [{ CodexAdapter }, { createProviderIntegration }] = await Promise.all([
    import('@/lib/cli/providers/codex/adapter'),
    import('@/lib/cli/provider-integration'),
  ]);
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: 'win32',
  });
  try {
    const provider = new CodexAdapter({
      resolveProviderHome: async () => (
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\owner\\custom-app-codex-home'
      ),
    });
    const integration = createProviderIntegration({
      resolveAgentEnvironment: async () => 'wsl',
      lifecycle: {
        inspect: async () => ({ state: 'installed', trust: 'trusted' }),
        install: async () => ({ state: 'installed', trust: 'trusted' }),
      },
    });
    const decision = await integration.resolveLaunch({
      provider,
      agentEnvironmentOwner: { kind: 'user', userId: 'bridged-app-user' },
      workDir: workspace,
    });
    const environment = integration.buildLaunchEnvironment(decision, {
      CODEX_HOME: 'C:\\Users\\server\\.codex',
      TESSERA_CODEX_HOME: 'C:\\server\\legacy-overlay',
      WSLENV: 'HTTPS_PROXY:TESSERA_CODEX_HOME/p',
    });

    assert.equal(environment?.CODEX_HOME, '/home/owner/custom-app-codex-home');
    assert.equal(environment?.TESSERA_CODEX_HOME, undefined);
    assert.deepEqual(environment?.WSLENV?.split(':'), ['HTTPS_PROXY', 'CODEX_HOME']);
  } finally {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  }
});

test('Codex app-server launch uses the shared Provider Integration policy and authoritative home', async (t) => {
  const [{ CodexAdapter }, { createProviderIntegration }, { SettingsManager }] =
    await Promise.all([
      import('@/lib/cli/providers/codex/adapter'),
      import('@/lib/cli/provider-integration'),
      import('@/lib/settings/manager'),
    ]);
  const userId = 'provider-integration-app-server-user';
  const settings = await SettingsManager.load(userId, { silent: true });
  await SettingsManager.save(userId, {
    ...settings,
    agentEnvironment: 'wsl',
    cliCommandOverrides: {
      ...settings.cliCommandOverrides,
      codex: {
        ...settings.cliCommandOverrides.codex,
        wsl: fakeCodex,
      },
    },
  });

  const resolvedUsers: Array<string | undefined> = [];
  const providerIntegration = createProviderIntegration({
    resolveAgentEnvironment: async (resolvedUserId) => {
      resolvedUsers.push(resolvedUserId);
      return 'wsl';
    },
    lifecycle: {
      inspect: async () => ({ state: 'installed', trust: 'trusted' }),
      install: async () => ({ state: 'installed', trust: 'trusted' }),
    },
  });
  const rawLogs: CliRawLogEvent[] = [];
  const adapter = new CodexAdapter({
    providerIntegration,
    resolveProviderHome: async () => authoritativeCodexHome,
  });

  const result = await adapter.spawn(workspace, {
    userId,
    sessionId: '__provider__',
    startupTimeoutMs: 2_000,
    rawLog: (event) => rawLogs.push(event),
  });
  t.after(() => {
    if (result.process.exitCode === null) result.process.kill('SIGTERM');
  });

  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(resolvedUsers, [userId]);
  const spawnEvent = rawLogs.find((event) => event.phase === 'spawn');
  assert.ok(spawnEvent);
  assert.deepEqual(JSON.parse(spawnEvent.data), {
    providerId: 'codex',
    command: fakeCodex,
    args: ['app-server'],
    cwd: workspace,
    requestedCwd: workspace,
    agentEnv: 'wsl',
  });
  assert.equal(
    rawLogs.some(
      (event) => event.direction === 'stderr'
        && event.data.includes(`provider-home:${authoritativeCodexHome}`),
    ),
    true,
  );
  assert.equal(
    rawLogs.some(
      (event) => event.direction === 'stderr'
        && event.data.includes('legacy-overlay:<unset>'),
    ),
    true,
  );

  const closed = once(result.process, 'close');
  result.process.kill('SIGTERM');
  await closed;
});

test('Codex-owned state persists across separate Tessera process lifecycles like ordinary Codex', () => {
  const stateKey = 'ordinary-provider-state.json';
  const statePath = path.join(authoritativeCodexHome, stateKey);
  const ownedFiles = [
    path.join(authoritativeCodexHome, 'auth.json'),
    path.join(authoritativeCodexHome, 'config.toml'),
    path.join(authoritativeCodexHome, 'mcp-state.json'),
    path.join(authoritativeCodexHome, 'skills/user-skill/SKILL.md'),
    path.join(authoritativeCodexHome, 'plugins/user-plugin/plugin.json'),
    path.join(authoritativeCodexHome, 'history.jsonl'),
  ];
  fs.rmSync(statePath, { force: true });
  for (const ownedFile of ownedFiles) {
    fs.mkdirSync(path.dirname(ownedFile), { recursive: true });
    fs.writeFileSync(ownedFile, `user-owned:${path.basename(ownedFile)}\n`);
  }
  const harness = path.join(process.cwd(), 'node_modules/.bin/tsx');
  const harnessScript = path.join(
    process.cwd(),
    'tests/fixtures/codex-authoritative-home-harness.ts',
  );
  const launch = (label: string) => spawnSync(
    harness,
    [
      harnessScript,
      fakeCodex,
      authoritativeCodexHome,
      path.join(testRoot, `restart-data-${label}`),
      stateKey,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: process.env,
    },
  );
  const ordinary = () => spawnSync(fakeCodex, ['ordinary-state'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: authoritativeCodexHome,
      TESSERA_CODEX_HOME: undefined,
      TESSERA_TEST_CODEX_STATE_KEY: stateKey,
    },
  });

  const ordinaryBaseline = ordinary();
  assert.equal(ordinaryBaseline.status, 0, ordinaryBaseline.stderr);
  assert.match(ordinaryBaseline.stderr, /state-before:absent/);
  fs.rmSync(statePath, { force: true });

  const firstLaunch = launch('first-process');
  assert.equal(firstLaunch.status, 0, firstLaunch.stderr);
  assert.match(firstLaunch.stdout, /state-before:absent/);
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'provider-owned\n');

  const secondLaunch = launch('second-process');
  assert.equal(secondLaunch.status, 0, secondLaunch.stderr);
  assert.match(secondLaunch.stdout, /state-before:present/);
  const ordinaryAfterRestart = ordinary();
  assert.equal(ordinaryAfterRestart.status, 0, ordinaryAfterRestart.stderr);
  assert.match(ordinaryAfterRestart.stderr, /state-before:present/);
  for (const ownedFile of ownedFiles) {
    assert.equal(
      fs.readFileSync(ownedFile, 'utf8'),
      `user-owned:${path.basename(ownedFile)}\n`,
    );
  }
});

test('Codex app-server launch fails closed before spawn when the required hook is missing', async () => {
  const [{ CodexAdapter }, { createProviderIntegration }] = await Promise.all([
    import('@/lib/cli/providers/codex/adapter'),
    import('@/lib/cli/provider-integration'),
  ]);
  const adapter = new CodexAdapter({
    resolveProviderHome: async () => authoritativeCodexHome,
    providerIntegration: createProviderIntegration({
      resolveAgentEnvironment: async () => 'native',
      lifecycle: {
        inspect: async () => ({ state: 'absent', trust: 'unchecked' }),
        install: async () => ({ state: 'installed', trust: 'trusted' }),
      },
    }),
  });

  await assert.rejects(
    adapter.spawn(workspace, {
      userId: 'missing-hook-user',
      sessionId: 'missing-hook-session',
    }),
    /lifecycle hook is not installed.*lifecycle install --consent/i,
  );
});

test('untrusted and unhealthy Codex lifecycle states fail closed with actionable guidance', async () => {
  const [{ CodexAdapter }, { createProviderIntegration }] = await Promise.all([
    import('@/lib/cli/providers/codex/adapter'),
    import('@/lib/cli/provider-integration'),
  ]);
  const provider = new CodexAdapter();
  const untrusted = createProviderIntegration({
    resolveAgentEnvironment: async () => 'wsl',
    lifecycle: {
      inspect: async () => ({
        state: 'installed',
        trust: 'untrusted',
        message: 'Codex rejected the managed hook hash.',
      }),
      install: async () => ({ state: 'installed', trust: 'trusted' }),
    },
  });
  await assert.rejects(
    untrusted.resolveLaunch({
      provider,
      agentEnvironmentOwner: { kind: 'user', userId: 'untrusted-hook-user' },
    }),
    /hook is not trusted.*lifecycle install --consent.*rejected the managed hook hash/i,
  );

  const unhealthy = createProviderIntegration({
    resolveAgentEnvironment: async () => 'wsl',
    lifecycle: {
      inspect: async () => {
        throw new Error('trust API timed out');
      },
      install: async () => ({ state: 'installed', trust: 'trusted' }),
    },
  });
  await assert.rejects(
    unhealthy.resolveLaunch({
      provider,
      agentEnvironmentOwner: { kind: 'user', userId: 'unhealthy-hook-user' },
    }),
    /unavailable or unhealthy.*lifecycle status.*trust API timed out/i,
  );

  await assert.rejects(
    unhealthy.resolveLaunch({
      provider: {
        getProviderId: () => 'codex',
        getProviderIntegrationRequirements: () => ({
          lifecycle: 'required',
          skill: 'optional',
          launchEnvironment: 'required',
        }),
      },
      agentEnvironmentOwner: { kind: 'user', userId: 'missing-home-capability-user' },
    }),
    /cannot prepare its Authoritative Provider Home environment.*update Tessera/i,
  );
});

test('Provider Integration keeps exact legacy overlay resumes exempt without weakening new launches', async () => {
  const [{ CodexAdapter }, { createProviderIntegration }] = await Promise.all([
    import('@/lib/cli/providers/codex/adapter'),
    import('@/lib/cli/provider-integration'),
  ]);
  let lifecycleInspections = 0;
  const provider = new CodexAdapter({
    resolveProviderHome: async () => authoritativeCodexHome,
  });
  const providerIntegration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: {
      inspect: async () => {
        lifecycleInspections += 1;
        return { state: 'absent', trust: 'unchecked' };
      },
      install: async () => ({ state: 'installed', trust: 'trusted' }),
    },
  });

  const legacy = await providerIntegration.resolveLaunch({
    provider,
    agentEnvironmentOwner: { kind: 'user', userId: 'legacy-user' },
    compatibility: 'exact-legacy-overlay-resume',
  });

  assert.equal(legacy.compatibility, 'exact-legacy-overlay-resume');
  assert.equal(lifecycleInspections, 0);
  await assert.rejects(
    providerIntegration.resolveLaunch({
      provider,
      agentEnvironmentOwner: { kind: 'user', userId: 'legacy-user' },
    }),
    /lifecycle hook is not installed/i,
  );
  assert.equal(lifecycleInspections, 1);

  await assert.rejects(
    providerIntegration.resolveLaunch({
      provider: {
        getProviderId: () => 'claude-code',
        getProviderIntegrationRequirements: () => ({
          lifecycle: 'required',
          skill: 'optional',
          launchEnvironment: 'not-applicable',
        }),
      },
      agentEnvironmentOwner: { kind: 'user', userId: 'legacy-user' },
      compatibility: 'exact-legacy-overlay-resume',
    }),
    /lifecycle hook is not installed/i,
  );
});
