import assert from 'node:assert/strict';
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
const readline = require('node:readline');
process.stderr.write('provider-home:' + (process.env.CODEX_HOME || '<unset>') + '\\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
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
    detectSkillProviders: async () => ['codex'],
    resolveProviderSkillHome: async () => authoritativeCodexHome,
    providerSkillStateDirectory: path.join(testRoot, 'provider-integration-state'),
  });

  const codex = await providerIntegration.resolveLaunch({
    provider: new CodexAdapter(),
    agentEnvironmentOwner: { kind: 'user', userId: 'provider-integration-user' },
  });
  assert.deepEqual(codex.providerHome, {
    owner: 'agent-environment',
    agentEnvironment: 'wsl',
  });
  assert.deepEqual(codex.lifecycle, {
    requirement: 'required',
    state: 'unchecked',
    consent: 'unchecked',
  });
  assert.deepEqual(codex.skill, {
    requirement: 'optional',
    state: 'absent',
    consent: 'declined',
  });

  const providerWithoutRequiredLifecycle = await providerIntegration.resolveLaunch({
    provider: { getProviderId: () => 'claude-code' },
    agentEnvironmentOwner: { kind: 'user', userId: 'provider-integration-user' },
  });
  assert.deepEqual(providerWithoutRequiredLifecycle.lifecycle, {
    requirement: 'not-applicable',
    state: 'not-applicable',
    consent: 'not-required',
  });
});

test('Codex app-server launch uses the shared Provider Integration policy and inherited home', async (t) => {
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

  const closed = once(result.process, 'close');
  result.process.kill('SIGTERM');
  await closed;
});
