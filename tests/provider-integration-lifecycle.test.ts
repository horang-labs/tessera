import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CliProvider } from '@/lib/cli/providers/types';
import { createCodexLifecycleHookIntegration } from '@/lib/cli/providers/codex/lifecycle-hook-integration';
import { buildCodexHookSettings } from '@/lib/terminal/codex-hook-settings';

const CODEX_EVENTS = [
  'sessionStart',
  'userPromptSubmit',
  'preToolUse',
  'permissionRequest',
  'postToolUse',
  'stop',
] as const;

const codexProvider = {
  getProviderId: () => 'codex',
  getProviderIntegrationRequirements: () => ({
    lifecycle: 'required' as const,
    skill: 'optional' as const,
    launchEnvironment: 'not-applicable' as const,
  }),
} as Pick<CliProvider, 'getProviderId' | 'getProviderIntegrationRequirements'>;

const claudeProvider = {
  getProviderId: () => 'claude-code',
  getProviderIntegrationRequirements: () => ({
    lifecycle: 'not-applicable' as const,
    skill: 'optional' as const,
    launchEnvironment: 'not-applicable' as const,
  }),
} as Pick<CliProvider, 'getProviderId' | 'getProviderIntegrationRequirements'>;

interface FakeCodexApi {
  request: (
    context: {
      environment?: 'native' | 'wsl';
      workDir?: string | null;
      providerHomeFilesystemPath?: string;
    },
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  calls: Array<{
    environment: unknown;
    providerHomeFilesystemPath: unknown;
    method: string;
    params: Record<string, unknown>;
  }>;
  trustedHashes: Map<string, string>;
}

function createFakeCodexApi(home: string): FakeCodexApi {
  const calls: FakeCodexApi['calls'] = [];
  const trustedHashes = new Map<string, string>();

  return {
    calls,
    trustedHashes,
    async request(context, method, params) {
      calls.push({
        environment: context.environment,
        providerHomeFilesystemPath: context.providerHomeFilesystemPath,
        method,
        params,
      });
      if (method === 'hooks/list') {
        const hookDocument = readHookDocument(home);
        const hooks: Array<Record<string, unknown>> = [];
        for (const [eventName, groups] of Object.entries(hookDocument.hooks ?? {})) {
          if (!Array.isArray(groups)) continue;
          groups.forEach((group, groupIndex) => {
            if (!isRecord(group) || !Array.isArray(group.hooks)) return;
            group.hooks.forEach((handler, handlerIndex) => {
              if (!isRecord(handler) || typeof handler.command !== 'string') return;
              if (!handler.command.includes('__tessera/hook')) return;
              const key = `${home}/hooks.json:${eventName}:${groupIndex}:${handlerIndex}`;
              const currentHash = `codex-owned-hash:${eventName}:${groupIndex}:${handlerIndex}`;
              hooks.push({
                key,
                eventName: toCodexEventName(eventName),
                command: handler.command,
                source: 'user',
                enabled: true,
                currentHash,
                trustStatus: trustedHashes.get(key) === currentHash ? 'trusted' : 'untrusted',
              });
            });
          });
        }
        return {
          data: [{ cwd: params.cwds?.[0], hooks, warnings: [], errors: [] }],
        };
      }

      if (method === 'config/batchWrite') {
        const [edit] = params.edits as Array<Record<string, unknown>>;
        assert.equal(edit.keyPath, 'hooks.state');
        assert.equal(edit.mergeStrategy, 'upsert');
        assert.ok(isRecord(edit.value));
        for (const [key, value] of Object.entries(edit.value)) {
          assert.ok(isRecord(value));
          assert.equal(typeof value.trusted_hash, 'string');
          trustedHashes.set(key, value.trusted_hash as string);
        }
        return { status: 'ok' };
      }

      throw new Error(`unexpected fake Codex method: ${method}`);
    },
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readHookDocument(home: string): Record<string, any> {
  const filePath = path.join(home, 'hooks.json');
  if (!fs.existsSync(filePath)) return { hooks: {} };
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
}

function toCodexEventName(eventName: string): string {
  return eventName.charAt(0).toLowerCase() + eventName.slice(1);
}

test('Agent Environment resolution failures stop before any provider lifecycle boundary', async () => {
  const {
    createProviderIntegration,
    ProviderIntegrationEnvironmentError,
  } = await import('@/lib/cli/provider-integration');
  let lifecycleCalls = 0;
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => {
      throw new SyntaxError('malformed settings fixture');
    },
    lifecycle: {
      async inspect() {
        lifecycleCalls += 1;
        return { state: 'absent', trust: 'unchecked' };
      },
      async install() {
        lifecycleCalls += 1;
        return { state: 'installed', trust: 'trusted' };
      },
    },
  });

  await assert.rejects(
    integration.inspectLifecycle({
      provider: codexProvider,
      agentEnvironmentOwner: { kind: 'user', userId: 'malformed-owner' },
      workDir: null,
    }),
    ProviderIntegrationEnvironmentError,
  );
  assert.equal(lifecycleCalls, 0);
});

test('native lifecycle install requires explicit consent, preserves user hooks, and trusts only Codex-reported hashes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-lifecycle-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  const workDir = path.join(root, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const userHook = {
    matcher: 'startup',
    hooks: [{ type: 'command', command: '/usr/local/bin/user-session-hook' }],
  };
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({
    description: 'user-owned hook document',
    hooks: { SessionStart: [userHook] },
  }, null, 2));

  const fakeCodex = createFakeCodexApi(home);
  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => home,
      readVersion: async () => '0.146.0',
      request: fakeCodex.request,
      stateDirectory: path.join(root, 'state'),
    }),
  });
  const request = {
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'user' as const, userId: 'native-owner' },
    workDir,
  };

  const before = await integration.inspectLifecycle(request);
  assert.equal(before.lifecycle.state, 'absent');
  assert.equal(before.lifecycle.consent, 'required');
  assert.equal(before.lifecycle.trust, 'unchecked');
  assert.equal(before.health.state, 'blocked');

  const declined = await integration.installLifecycle({ ...request, consent: 'declined' });
  assert.equal(declined.lifecycle.state, 'absent');
  assert.equal(declined.lifecycle.consent, 'declined');
  assert.deepEqual(readHookDocument(home).hooks.SessionStart, [userHook]);
  assert.equal(fakeCodex.calls.some((call) => call.method === 'config/batchWrite'), false);

  const installed = await integration.installLifecycle({ ...request, consent: 'granted' });
  assert.equal(installed.lifecycle.state, 'installed');
  assert.equal(installed.lifecycle.consent, 'granted');
  assert.equal(installed.lifecycle.trust, 'trusted');
  assert.equal(installed.health.state, 'healthy');

  const document = readHookDocument(home);
  assert.equal(document.description, 'user-owned hook document');
  assert.deepEqual(document.hooks.SessionStart[0], userHook);
  assert.equal(document.hooks.SessionStart.length, 2);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']) {
    assert.equal(document.hooks[event].at(-1).hooks.length, 1);
    assert.match(document.hooks[event].at(-1).hooks[0].command, /__tessera\/hook/);
  }

  const trustCall = fakeCodex.calls.find((call) => call.method === 'config/batchWrite');
  assert.ok(trustCall);
  const [trustEdit] = trustCall.params.edits as Array<Record<string, any>>;
  assert.equal(Object.keys(trustEdit.value).length, CODEX_EVENTS.length);
  for (const [key, value] of Object.entries(trustEdit.value) as Array<[string, any]>) {
    assert.equal(value.trusted_hash, fakeCodex.trustedHashes.get(key));
    assert.match(value.trusted_hash, /^codex-owned-hash:/);
  }
  assert.equal(fakeCodex.calls.filter((call) => call.method === 'config/batchWrite').length, 1);
  assert.ok(fakeCodex.calls.filter((call) => call.method === 'hooks/list').length >= 2);
  assert.equal(fakeCodex.calls.every((call) => call.environment === 'native'), true);
  assert.equal(fakeCodex.calls.every((call) => call.providerHomeFilesystemPath === home), true);

  const inspected = await integration.inspectLifecycle(request);
  assert.equal(inspected.lifecycle.state, 'installed');
  assert.equal(inspected.lifecycle.trust, 'trusted');
  assert.equal(inspected.health.state, 'healthy');

  const disabledIntegration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => home,
      readVersion: async () => '0.146.0',
      request: async (context, method, params) => {
        const response = await fakeCodex.request(context, method, params) as Record<string, any>;
        if (method === 'hooks/list') response.data[0].hooks[0].enabled = false;
        return response;
      },
      stateDirectory: path.join(root, 'disabled-state'),
    }),
  });
  const disabled = await disabledIntegration.inspectLifecycle(request);
  assert.equal(disabled.lifecycle.state, 'conflict');
  assert.equal(disabled.health.state, 'blocked');
});

test('bridged WSL ownership mutates only the WSL Authoritative Provider Home', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-lifecycle-wsl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nativeHome = path.join(root, 'native-codex-home');
  const wslHome = path.join(root, 'wsl-codex-home');
  fs.mkdirSync(nativeHome, { recursive: true });
  fs.mkdirSync(wslHome, { recursive: true });
  fs.writeFileSync(path.join(nativeHome, 'hooks.json'), '{"native":"must-stay-untouched"}\n');

  const fakeCodex = createFakeCodexApi(wslHome);
  const resolvedEnvironments: string[] = [];
  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'wsl',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async (environment) => {
        resolvedEnvironments.push(environment);
        if (environment !== 'wsl') throw new Error('opposite-environment fallback attempted');
        return wslHome;
      },
      readVersion: async (environment) => {
        assert.equal(environment, 'wsl');
        return '0.147.0';
      },
      request: fakeCodex.request,
      stateDirectory: path.join(root, 'state'),
    }),
  });

  const result = await integration.installLifecycle({
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'user', userId: 'wsl-owner' },
    workDir: path.join(root, 'workspace'),
    consent: 'granted',
  });

  assert.equal(result.providerHome.agentEnvironment, 'wsl');
  assert.equal(result.lifecycle.state, 'installed');
  assert.equal(result.lifecycle.trust, 'trusted');
  assert.deepEqual(resolvedEnvironments, ['wsl']);
  assert.equal(fs.readFileSync(path.join(nativeHome, 'hooks.json'), 'utf8'), '{"native":"must-stay-untouched"}\n');
  assert.equal(fs.existsSync(path.join(wslHome, 'hooks.json')), true);
  assert.equal(fakeCodex.calls.every((call) => call.environment === 'wsl'), true);
  assert.equal(fakeCodex.calls.every((call) => call.providerHomeFilesystemPath === wslHome), true);
});

test('unsupported Codex fails closed with minimum-version guidance and never attempts trust mutation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-lifecycle-old-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const calls: string[] = [];

  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => home,
      readVersion: async () => '0.145.0',
      request: async (_context, method) => {
        calls.push(method);
        throw new Error('unsupported Codex must not reach the hook API');
      },
      stateDirectory: path.join(root, 'state'),
    }),
  });

  const result = await integration.installLifecycle({
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'user', userId: 'old-codex-owner' },
    workDir: root,
    consent: 'granted',
  });

  assert.equal(result.lifecycle.state, 'unavailable');
  assert.equal(result.lifecycle.trust, 'unavailable');
  assert.equal(result.lifecycle.consent, 'granted');
  assert.equal(result.health.state, 'blocked');
  assert.equal(result.guidance?.minimumVersion, '0.146.0');
  assert.equal(result.guidance?.updateCommand, 'codex update');
  assert.match(result.guidance?.message ?? '', /0\.146\.0/);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(home, 'hooks.json')), false);

  const persistedConsent = await integration.inspectLifecycle({
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'user', userId: 'old-codex-owner' },
    workDir: root,
  });
  assert.equal(persistedConsent.lifecycle.consent, 'granted');
  assert.equal(persistedConsent.health.state, 'blocked');
  assert.equal(persistedConsent.guidance?.minimumVersion, '0.146.0');
});

test('missing supported trust API is unavailable and does not compute or persist substitute trust', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-lifecycle-no-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const calls: string[] = [];

  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => home,
      readVersion: async () => '0.146.0',
      request: async (_context, method) => {
        calls.push(method);
        throw new Error('Method not found: hooks/list');
      },
      stateDirectory: path.join(root, 'state'),
    }),
  });

  const result = await integration.installLifecycle({
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'server-default' },
    workDir: root,
    consent: 'granted',
  });

  assert.equal(result.lifecycle.state, 'unavailable');
  assert.equal(result.lifecycle.trust, 'unavailable');
  assert.equal(result.guidance?.minimumVersion, '0.146.0');
  assert.equal(result.guidance?.updateCommand, 'codex update');
  assert.deepEqual(calls, ['hooks/list']);
  assert.equal(fs.existsSync(path.join(home, 'config.toml')), false);
});

test('ordinary trust failures block without false Codex upgrade guidance', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-lifecycle-trust-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const fakeCodex = createFakeCodexApi(home);

  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => home,
      readVersion: async () => '0.146.0',
      request: async (context, method, params) => {
        if (method === 'config/batchWrite') throw new Error('permission denied');
        return fakeCodex.request(context, method, params);
      },
      stateDirectory: path.join(root, 'state'),
    }),
  });
  const result = await integration.installLifecycle({
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'server-default' },
    workDir: root,
    consent: 'granted',
  });

  assert.equal(result.lifecycle.state, 'installed');
  assert.equal(result.lifecycle.trust, 'untrusted');
  assert.equal(result.health.state, 'blocked');
  assert.equal(result.guidance, undefined);
  assert.match(result.lifecycle.message ?? '', /permission denied/);
});

test('malformed user hook configuration is reported as a conflict without overwrite', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-lifecycle-conflict-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const malformed = '{"hooks":{"SessionStart":[';
  fs.writeFileSync(path.join(home, 'hooks.json'), malformed);

  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => home,
      readVersion: async () => '0.146.0',
      request: async () => ({ data: [] }),
      stateDirectory: path.join(root, 'state'),
    }),
  });

  const result = await integration.installLifecycle({
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'server-default' },
    workDir: root,
    consent: 'granted',
  });

  assert.equal(result.lifecycle.state, 'conflict');
  assert.equal(result.health.state, 'blocked');
  assert.equal(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'), malformed);
});

test('modified Tessera-looking hooks are conflicted and never overwritten or trusted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-lifecycle-modified-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const modified = JSON.stringify({
    hooks: {
      SessionStart: [{
        hooks: [{
          type: 'command',
          timeout: 10,
          command: 'curl http://127.0.0.1/__tessera/hook --modified-by-user',
        }],
      }],
    },
  }, null, 2);
  fs.writeFileSync(path.join(home, 'hooks.json'), modified);
  const methods: string[] = [];

  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => home,
      readVersion: async () => '0.146.0',
      request: async (_context, method) => {
        methods.push(method);
        return { data: [{ hooks: [] }] };
      },
      stateDirectory: path.join(root, 'state'),
    }),
  });
  const result = await integration.installLifecycle({
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'server-default' },
    workDir: root,
    consent: 'granted',
  });

  assert.equal(result.lifecycle.state, 'conflict');
  assert.equal(result.lifecycle.trust, 'unavailable');
  assert.deepEqual(methods, []);
  assert.equal(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'), modified);
});

test('install preserves a symlinked user hooks file, its mode, and existing hook order', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-lifecycle-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  const userConfigDir = path.join(root, 'user-config');
  const target = path.join(userConfigDir, 'hooks.json');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(userConfigDir, { recursive: true });
  const userHook = { hooks: [{ type: 'command', command: '/opt/user/stop-hook' }] };
  fs.writeFileSync(target, JSON.stringify({ hooks: { Stop: [userHook] } }, null, 2), { mode: 0o640 });
  fs.symlinkSync(target, path.join(home, 'hooks.json'));
  const fakeCodex = createFakeCodexApi(home);

  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => home,
      readVersion: async () => '0.146.0',
      request: fakeCodex.request,
      stateDirectory: path.join(root, 'state'),
    }),
  });
  const result = await integration.installLifecycle({
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'server-default' },
    workDir: root,
    consent: 'granted',
  });

  assert.equal(result.lifecycle.state, 'installed');
  assert.equal(fs.lstatSync(path.join(home, 'hooks.json')).isSymbolicLink(), true);
  assert.deepEqual(readHookDocument(home).hooks.Stop[0], userHook);
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
});

test('consent is scoped to one Authoritative Provider Home and does not transfer on home change', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-lifecycle-consent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstHome = path.join(root, 'first-home');
  const secondHome = path.join(root, 'second-home');
  fs.mkdirSync(firstHome, { recursive: true });
  fs.mkdirSync(secondHome, { recursive: true });
  let activeHome = firstHome;
  let activeEnvironment: 'native' | 'wsl' = 'native';
  const firstApi = createFakeCodexApi(firstHome);
  const secondApi = createFakeCodexApi(secondHome);

  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => activeEnvironment,
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => activeHome,
      readVersion: async () => '0.146.0',
      request: (context, method, params) => (
        (context.providerHomeFilesystemPath ?? activeHome) === firstHome
          ? firstApi.request(context, method, params)
          : secondApi.request(context, method, params)
      ),
      stateDirectory: path.join(root, 'state'),
    }),
  });
  const request = {
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'user' as const, userId: 'home-switch-owner' },
    workDir: root,
  };

  const first = await integration.installLifecycle({ ...request, consent: 'granted' });
  assert.equal(first.lifecycle.state, 'installed');
  const firstText = fs.readFileSync(path.join(firstHome, 'hooks.json'), 'utf8');
  const managedSessionId = 'first-home-session';
  await integration.resolveLaunch({ ...request, managedSessionId });
  assert.equal(integration.getManagedSessionHealth(managedSessionId), 'healthy');

  activeHome = secondHome;
  const secondStatus = await integration.inspectLifecycle(request);
  assert.equal(secondStatus.lifecycle.state, 'absent');
  assert.equal(secondStatus.lifecycle.consent, 'required');
  const declined = await integration.installLifecycle({ ...request, consent: 'declined' });
  assert.equal(declined.lifecycle.state, 'absent');
  assert.equal(declined.lifecycle.consent, 'declined');
  assert.equal(fs.existsSync(path.join(secondHome, 'hooks.json')), false);
  assert.equal(fs.readFileSync(path.join(firstHome, 'hooks.json'), 'utf8'), firstText);

  activeHome = firstHome;
  const originalHome = await integration.inspectLifecycle(request);
  assert.equal(originalHome.lifecycle.consent, 'granted');
  assert.equal(originalHome.health.state, 'healthy');

  activeHome = secondHome;
  const externallyModified = readHookDocument(firstHome);
  externallyModified.hooks.SessionStart.at(-1).hooks[0].timeout = 99;
  fs.writeFileSync(
    path.join(firstHome, 'hooks.json'),
    `${JSON.stringify(externallyModified, null, 2)}\n`,
  );
  assert.equal(await integration.refreshManagedSessionHealth(managedSessionId), 'degraded');
  assert.equal(
    firstApi.calls.at(-1)?.providerHomeFilesystemPath,
    firstHome,
    'active health remains pinned to the launch-time home',
  );
  integration.releaseManagedSession(managedSessionId);

  activeEnvironment = 'wsl';
  activeHome = secondHome;
  const otherEnvironment = await integration.inspectLifecycle(request);
  assert.equal(otherEnvironment.providerHome.agentEnvironment, 'wsl');
  assert.equal(otherEnvironment.lifecycle.state, 'absent');
  assert.equal(otherEnvironment.lifecycle.consent, 'required');
  assert.equal(otherEnvironment.health.state, 'blocked');
});

test('consented lifecycle refreshes before launch, degrades on conflict, and revokes without affecting other providers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-lifecycle-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const fakeCodex = createFakeCodexApi(home);
  let tesseraVersion = '1.0.0';

  const { createProviderIntegration, ProviderIntegrationLaunchBlockedError } = await import(
    '@/lib/cli/provider-integration'
  );
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => home,
      readVersion: async () => '0.146.0',
      request: fakeCodex.request,
      stateDirectory: path.join(root, 'state'),
      readTesseraVersion: () => tesseraVersion,
    }),
  });
  const lifecycleOnlyCodexProvider = {
    ...codexProvider,
    getProviderIntegrationRequirements: () => ({
      lifecycle: 'required' as const,
      skill: 'not-applicable' as const,
      launchEnvironment: 'not-applicable' as const,
    }),
  };
  const request = {
    provider: lifecycleOnlyCodexProvider,
    agentEnvironmentOwner: { kind: 'user' as const, userId: 'policy-owner' },
    workDir: root,
  };

  const installed = await integration.installLifecycle({ ...request, consent: 'granted' });
  assert.equal(installed.lifecycle.state, 'installed');
  assert.equal(installed.lifecycle.consent, 'granted');
  assert.equal(installed.lifecycle.installedVersion, '1.0.0');
  assert.equal(installed.lifecycle.currentVersion, '1.0.0');

  tesseraVersion = '1.1.0';
  fs.appendFileSync(path.join(home, 'hooks.json'), '\n');
  const beforeRefreshText = fs.readFileSync(path.join(home, 'hooks.json'), 'utf8');
  const stale = await integration.inspectLifecycle(request);
  assert.equal(stale.lifecycle.state, 'stale');
  assert.equal(stale.lifecycle.consent, 'granted');
  assert.equal(stale.lifecycle.installedVersion, '1.0.0');
  assert.equal(stale.lifecycle.currentVersion, '1.1.0');
  assert.equal(stale.health.state, 'blocked');

  const trustWritesBeforeLaunch = fakeCodex.calls.filter(
    (call) => call.method === 'config/batchWrite',
  ).length;
  const managedSessionId = 'running-codex-session';
  const launched = await integration.resolveLaunch({ ...request, managedSessionId });
  assert.equal(launched.lifecycle.state, 'installed');
  assert.equal(launched.lifecycle.installedVersion, '1.1.0');
  assert.equal(launched.health.state, 'healthy');
  assert.equal(
    fakeCodex.calls.filter((call) => call.method === 'config/batchWrite').length,
    trustWritesBeforeLaunch + 1,
  );
  assert.notEqual(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'), beforeRefreshText);

  const document = readHookDocument(home);
  document.hooks.SessionStart.at(-1).hooks[0].timeout = 99;
  fs.writeFileSync(path.join(home, 'hooks.json'), `${JSON.stringify(document, null, 2)}\n`);
  const modifiedText = fs.readFileSync(path.join(home, 'hooks.json'), 'utf8');

  assert.equal(await integration.refreshManagedSessionHealth(managedSessionId), 'degraded');
  assert.equal(integration.getManagedSessionHealth(managedSessionId), 'degraded');
  const degraded = await integration.inspectLifecycle(request);
  assert.equal(degraded.lifecycle.state, 'conflict');
  assert.equal(degraded.lifecycle.consent, 'granted');
  assert.equal(degraded.health.state, 'blocked');
  assert.equal(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'), modifiedText);
  await assert.rejects(integration.resolveLaunch(request), ProviderIntegrationLaunchBlockedError);

  const otherProvider = await integration.resolveLaunch({
    ...request,
    provider: claudeProvider,
  });
  assert.equal(otherProvider.lifecycle.state, 'not-applicable');

  const repaired = await integration.updateLifecycle(request);
  assert.equal(repaired.lifecycle.state, 'installed');
  assert.equal(repaired.lifecycle.consent, 'granted');
  assert.equal(repaired.health.state, 'healthy');

  const repairedDocument = readHookDocument(home);
  const userStopHook = { hooks: [{ type: 'command', command: '/opt/user/stop-hook' }] };
  repairedDocument.hooks.Stop.unshift(userStopHook);
  fs.writeFileSync(path.join(home, 'hooks.json'), `${JSON.stringify(repairedDocument, null, 2)}\n`);
  const removed = await integration.removeLifecycle(request);
  assert.equal(removed.lifecycle.state, 'absent');
  assert.equal(removed.lifecycle.consent, 'revoked');
  assert.equal(removed.health.state, 'blocked');
  assert.equal(
    Object.values(readHookDocument(home).hooks).some((groups) => (
      Array.isArray(groups) && groups.some(groupLooksTesseraOwnedForTest)
    )),
    false,
  );
  assert.deepEqual(readHookDocument(home).hooks.Stop, [userStopHook]);
  await assert.rejects(integration.resolveLaunch(request), ProviderIntegrationLaunchBlockedError);
  assert.equal(integration.getManagedSessionHealth(managedSessionId), 'degraded');
  integration.releaseManagedSession(managedSessionId);
  assert.equal(integration.getManagedSessionHealth(managedSessionId), undefined);
});

test('running Session health remains independent across Agent Environments', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-health-scopes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nativeHome = path.join(root, 'native-home');
  const wslHome = path.join(root, 'wsl-home');
  fs.mkdirSync(nativeHome, { recursive: true });
  fs.mkdirSync(wslHome, { recursive: true });
  const nativeApi = createFakeCodexApi(nativeHome);
  const wslApi = createFakeCodexApi(wslHome);
  let activeEnvironment: 'native' | 'wsl' = 'native';

  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => activeEnvironment,
    healthRefreshIntervalMs: 0,
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async (environment) => (
        environment === 'native' ? nativeHome : wslHome
      ),
      readVersion: async () => '0.146.0',
      request: async (context, method, params) => (
        context.providerHomeFilesystemPath === nativeHome
          ? nativeApi.request(context, method, params)
          : wslApi.request(context, method, params)
      ),
      stateDirectory: path.join(root, 'state'),
      readTesseraVersion: () => '1.0.0',
    }),
  });
  const request = {
    provider: {
      ...codexProvider,
      getProviderIntegrationRequirements: () => ({
        lifecycle: 'required' as const,
        skill: 'not-applicable' as const,
        launchEnvironment: 'not-applicable' as const,
      }),
    },
    agentEnvironmentOwner: { kind: 'user' as const, userId: 'scope-owner' },
    workDir: root,
  };
  const changes: Array<{ sessionId: string; integrationHealth: string | undefined }> = [];
  const unsubscribe = integration.subscribeManagedSessionHealth((change) => changes.push(change));
  t.after(unsubscribe);

  await integration.installLifecycle({ ...request, consent: 'granted' });
  await integration.resolveLaunch({ ...request, managedSessionId: 'native-session' });
  activeEnvironment = 'wsl';
  await integration.installLifecycle({ ...request, consent: 'granted' });
  await integration.resolveLaunch({ ...request, managedSessionId: 'wsl-session' });

  const nativeDocument = readHookDocument(nativeHome);
  nativeDocument.hooks.SessionStart.at(-1).hooks[0].timeout = 99;
  fs.writeFileSync(
    path.join(nativeHome, 'hooks.json'),
    `${JSON.stringify(nativeDocument, null, 2)}\n`,
  );
  assert.equal(await integration.refreshManagedSessionHealth('native-session'), 'degraded');
  assert.equal(integration.getManagedSessionHealth('wsl-session'), 'healthy');
  assert.equal(
    changes.some((change) => change.sessionId === 'native-session'
      && change.integrationHealth === 'degraded'),
    true,
  );
  assert.equal(
    changes.some((change) => change.sessionId === 'wsl-session'
      && change.integrationHealth === 'degraded'),
    false,
  );
  integration.releaseManagedSession('native-session');
  integration.releaseManagedSession('wsl-session');
});

test('a Tessera upgrade refreshes the previously managed hook definition before launch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-definition-refresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const fakeCodex = createFakeCodexApi(home);
  const olderHookSettings: typeof buildCodexHookSettings = (style) => {
    const settings = structuredClone(buildCodexHookSettings(style));
    for (const groups of Object.values(settings.hooks)) {
      groups[0].hooks[0].timeout = 4;
    }
    return settings;
  };
  const lifecycleOptions = {
    resolveProviderHome: async () => home,
    readVersion: async () => '0.146.0',
    request: fakeCodex.request,
    stateDirectory: path.join(root, 'state'),
  };
  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const request = {
    provider: {
      ...codexProvider,
      getProviderIntegrationRequirements: () => ({
        lifecycle: 'required' as const,
        skill: 'not-applicable' as const,
        launchEnvironment: 'not-applicable' as const,
      }),
    },
    agentEnvironmentOwner: { kind: 'user' as const, userId: 'upgrade-owner' },
    workDir: root,
  };
  const oldIntegration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      ...lifecycleOptions,
      readTesseraVersion: () => '1.0.0',
      buildHookSettings: olderHookSettings,
    }),
  });
  assert.equal(
    (await oldIntegration.installLifecycle({ ...request, consent: 'granted' })).health.state,
    'healthy',
  );
  assert.equal(readHookDocument(home).hooks.SessionStart.at(-1).hooks[0].timeout, 4);

  const currentIntegration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    lifecycle: createCodexLifecycleHookIntegration({
      ...lifecycleOptions,
      readTesseraVersion: () => '2.0.0',
    }),
  });
  assert.equal((await currentIntegration.inspectLifecycle(request)).lifecycle.state, 'stale');
  const launched = await currentIntegration.resolveLaunch(request);
  assert.equal(launched.health.state, 'healthy');
  assert.equal(launched.lifecycle.installedVersion, '2.0.0');
  assert.notEqual(readHookDocument(home).hooks.SessionStart.at(-1).hooks[0].timeout, 4);
});

function groupLooksTesseraOwnedForTest(group: unknown): boolean {
  return isRecord(group)
    && Array.isArray(group.hooks)
    && group.hooks.some((hook: unknown) => (
      isRecord(hook)
      && typeof hook.command === 'string'
      && hook.command.includes('/__tessera/hook')
    ));
}

test('non-Codex lifecycle management is not applicable and never touches Codex boundaries', async () => {
  const calls: string[] = [];
  const { createProviderIntegration } = await import('@/lib/cli/provider-integration');
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'wsl',
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => {
        calls.push('home');
        throw new Error('must not resolve a Codex home for Claude Code');
      },
      readVersion: async () => {
        calls.push('version');
        return '0.146.0';
      },
      request: async () => {
        calls.push('request');
        return {};
      },
    }),
  });
  const request = {
    provider: claudeProvider,
    agentEnvironmentOwner: { kind: 'user' as const, userId: 'claude-owner' },
    workDir: '/workspace',
  };

  const inspected = await integration.inspectLifecycle(request);
  const installed = await integration.installLifecycle({ ...request, consent: 'granted' });

  for (const result of [inspected, installed]) {
    assert.equal(result.providerHome.agentEnvironment, 'wsl');
    assert.equal(result.lifecycle.state, 'not-applicable');
    assert.equal(result.lifecycle.trust, 'not-required');
    assert.equal(result.health.state, 'healthy');
  }
  assert.deepEqual(calls, []);
});

test('the exported provider integration survives server bundle module boundaries', async () => {
  const { providerIntegration } = await import('@/lib/cli/provider-integration');
  const globalProviderIntegration = (
    globalThis as typeof globalThis & {
      [key: symbol]: typeof providerIntegration | undefined;
    }
  )[Symbol.for('tessera.providerIntegration')];

  assert.equal(globalProviderIntegration, providerIntegration);
});
