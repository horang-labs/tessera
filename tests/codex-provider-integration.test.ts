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
  assert.deepEqual(codex.providerHome, {
    owner: 'agent-environment',
    agentEnvironment: 'wsl',
  });
  assert.deepEqual(codex.lifecycle, {
    requirement: 'required',
    state: 'installed',
    consent: 'granted',
    trust: 'trusted',
  });
  assert.deepEqual(codex.skill, {
    requirement: 'optional',
    state: 'unchecked',
    consent: 'unchecked',
    trust: 'unchecked',
  });
  assert.deepEqual(codex.health, { state: 'healthy' });
  assert.equal('launchEnvironment' in codex, false);

  const providerWithoutRequiredLifecycle = await providerIntegration.resolveLaunch({
    provider: { getProviderId: () => 'claude-code' },
    agentEnvironmentOwner: { kind: 'user', userId: 'provider-integration-user' },
  });
  assert.deepEqual(providerWithoutRequiredLifecycle.lifecycle, {
    requirement: 'not-applicable',
    state: 'not-applicable',
    consent: 'not-required',
    trust: 'not-required',
  });
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
  const adapter = new CodexAdapter({ providerIntegration });

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

test('Codex-owned state persists across separate managed app-server lifecycles in the authoritative home', async (t) => {
  const [{ CodexAdapter }, { createProviderIntegration }, { SettingsManager }] =
    await Promise.all([
      import('@/lib/cli/providers/codex/adapter'),
      import('@/lib/cli/provider-integration'),
      import('@/lib/settings/manager'),
    ]);
  const userId = 'provider-integration-persistence-user';
  const settings = await SettingsManager.load(userId, { silent: true });
  await SettingsManager.save(userId, {
    ...settings,
    agentEnvironment: 'wsl',
    cliCommandOverrides: {
      ...settings.cliCommandOverrides,
      codex: { ...settings.cliCommandOverrides.codex, wsl: fakeCodex },
    },
  });
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
  const previousTestStateKey = process.env.TESSERA_TEST_CODEX_STATE_KEY;
  const previousOverlayHome = process.env.TESSERA_CODEX_HOME;
  process.env.TESSERA_TEST_CODEX_STATE_KEY = stateKey;
  process.env.TESSERA_CODEX_HOME = path.join(testRoot, 'inherited-legacy-overlay');
  t.after(() => {
    if (previousTestStateKey === undefined) delete process.env.TESSERA_TEST_CODEX_STATE_KEY;
    else process.env.TESSERA_TEST_CODEX_STATE_KEY = previousTestStateKey;
    if (previousOverlayHome === undefined) delete process.env.TESSERA_CODEX_HOME;
    else process.env.TESSERA_CODEX_HOME = previousOverlayHome;
  });

  const launch = async (): Promise<CliRawLogEvent[]> => {
    const rawLogs: CliRawLogEvent[] = [];
    const integration = createProviderIntegration({
      resolveAgentEnvironment: async () => 'wsl',
      lifecycle: {
        inspect: async () => ({ state: 'installed', trust: 'trusted' }),
        install: async () => ({ state: 'installed', trust: 'trusted' }),
      },
    });
    const adapter = new CodexAdapter({ providerIntegration: integration });
    const result = await adapter.spawn(workspace, {
      userId,
      sessionId: `persistence-${Date.now()}`,
      startupTimeoutMs: 2_000,
      rawLog: (event) => rawLogs.push(event),
    });
    assert.equal(result.ok, true, result.error?.message);
    const closed = once(result.process, 'close');
    result.process.kill('SIGTERM');
    await closed;
    return rawLogs;
  };

  const firstLogs = await launch();
  assert.equal(
    firstLogs.some((event) => event.data.includes('state-before:absent')),
    true,
  );
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'provider-owned\n');

  // A fresh integration and adapter model a later Tessera process lifecycle.
  const secondLogs = await launch();
  assert.equal(
    secondLogs.some((event) => event.data.includes('state-before:present')),
    true,
  );
  const ordinary = spawnSync(fakeCodex, ['ordinary-state'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: authoritativeCodexHome,
      TESSERA_CODEX_HOME: undefined,
    },
  });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.match(ordinary.stderr, /state-before:present/);
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
});

test('Provider Integration keeps exact legacy overlay resumes exempt without weakening new launches', async () => {
  const [{ CodexAdapter }, { createProviderIntegration }] = await Promise.all([
    import('@/lib/cli/providers/codex/adapter'),
    import('@/lib/cli/provider-integration'),
  ]);
  let lifecycleInspections = 0;
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
    provider: new CodexAdapter(),
    agentEnvironmentOwner: { kind: 'user', userId: 'legacy-user' },
    compatibility: 'exact-legacy-overlay-resume',
  });

  assert.equal(legacy.compatibility, 'exact-legacy-overlay-resume');
  assert.equal(lifecycleInspections, 0);
  await assert.rejects(
    providerIntegration.resolveLaunch({
      provider: new CodexAdapter(),
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
        }),
      },
      agentEnvironmentOwner: { kind: 'user', userId: 'legacy-user' },
      compatibility: 'exact-legacy-overlay-resume',
    }),
    /lifecycle hook is not installed/i,
  );
});
