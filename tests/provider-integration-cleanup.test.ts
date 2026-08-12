import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createProviderIntegration,
  type ProviderSkillId,
} from '@/lib/cli/provider-integration';
import { createCodexLifecycleHookIntegration } from '@/lib/cli/providers/codex/lifecycle-hook-integration';
import type { CliProvider } from '@/lib/cli/providers/types';

const TEST_SKILL = '# Tessera CLI\n\nManaged test discovery skill.\n';

const codexProvider = {
  getProviderId: () => 'codex',
  getProviderIntegrationRequirements: () => ({
    lifecycle: 'required' as const,
    skill: 'optional' as const,
    launchEnvironment: 'not-applicable' as const,
  }),
} as Pick<CliProvider, 'getProviderId' | 'getProviderIntegrationRequirements'>;

type AgentEnvironment = 'native' | 'wsl';

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hookDocument(home: string): Record<string, any> {
  const file = path.join(home, 'hooks.json');
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>
    : { hooks: {} };
}

function hasTesseraHook(home: string): boolean {
  return Object.values(hookDocument(home).hooks ?? {}).some((groups) => (
    Array.isArray(groups) && groups.some((group) => (
      isRecord(group)
      && Array.isArray(group.hooks)
      && group.hooks.some((handler: unknown) => (
        isRecord(handler)
        && typeof handler.command === 'string'
        && handler.command.includes('/__tessera/hook')
      ))
    ))
  ));
}

function createFakeCodexRequest(homes: Record<AgentEnvironment, string>) {
  const trustedHashes = new Map<string, string>();
  return async (
    context: { environment: AgentEnvironment; providerHomeFilesystemPath?: string },
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    const home = context.providerHomeFilesystemPath ?? homes[context.environment];
    if (method === 'hooks/list') {
      const hooks: Array<Record<string, unknown>> = [];
      for (const [eventName, groups] of Object.entries(hookDocument(home).hooks ?? {})) {
        if (!Array.isArray(groups)) continue;
        groups.forEach((group, groupIndex) => {
          if (!isRecord(group) || !Array.isArray(group.hooks)) return;
          group.hooks.forEach((handler, handlerIndex) => {
            if (!isRecord(handler) || typeof handler.command !== 'string') return;
            if (!handler.command.includes('/__tessera/hook')) return;
            const key = `${home}/hooks.json:${eventName}:${groupIndex}:${handlerIndex}`;
            const currentHash = `codex-owned-hash:${eventName}:${groupIndex}:${handlerIndex}`;
            hooks.push({
              key,
              eventName: eventName.charAt(0).toLowerCase() + eventName.slice(1),
              command: handler.command,
              source: 'user',
              enabled: true,
              currentHash,
              trustStatus: trustedHashes.get(key) === currentHash ? 'trusted' : 'untrusted',
            });
          });
        });
      }
      return { data: [{ cwd: (params.cwds as string[] | undefined)?.[0], hooks }] };
    }
    if (method === 'config/batchWrite') {
      const [edit] = params.edits as Array<Record<string, any>>;
      for (const [key, value] of Object.entries(edit.value as Record<string, any>)) {
        trustedHashes.set(key, value.trusted_hash as string);
      }
      return { status: 'ok' };
    }
    throw new Error(`Unexpected fake Codex method: ${method}`);
  };
}

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-cleanup-'));
  const lifecycleHomes = {
    native: path.join(root, 'native', 'codex'),
    wsl: path.join(root, 'wsl', 'codex'),
  } satisfies Record<AgentEnvironment, string>;
  const skillHomes = Object.fromEntries(
    (['native', 'wsl'] as const).flatMap((environment) => (
      (['claude-code', 'codex', 'opencode'] as const).map((providerId) => [
        `${environment}:${providerId}`,
        path.join(root, environment, `${providerId}-skill-home`),
      ])
    )),
  ) as Record<`${AgentEnvironment}:${ProviderSkillId}`, string>;
  for (const home of [...Object.values(lifecycleHomes), ...Object.values(skillHomes)]) {
    fs.mkdirSync(home, { recursive: true });
  }
  let activeEnvironment: AgentEnvironment = 'native';
  const resolvedSkillScopes: string[] = [];
  const blockedSkillScopes = new Set<string>();
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => activeEnvironment,
    detectSkillProviders: async (_environment, providerIds) => (
      providerIds ?? ['claude-code', 'codex', 'opencode']
    ),
    resolveProviderSkillHome: async (providerId, environment) => {
      const scope = `${environment}:${providerId}`;
      resolvedSkillScopes.push(scope);
      if (blockedSkillScopes.has(scope)) {
        throw new Error(`The ${scope} Agent Environment is unavailable; no opposite environment was used.`);
      }
      return skillHomes[`${environment}:${providerId}`];
    },
    providerSkillStateDirectory: path.join(root, 'state', 'provider-skills'),
    readProviderSkillFiles: () => [{ relativePath: 'SKILL.md', content: TEST_SKILL }],
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async (environment) => lifecycleHomes[environment],
      readVersion: async () => '0.146.0',
      request: createFakeCodexRequest(lifecycleHomes),
      stateDirectory: path.join(root, 'state', 'provider-integrations', 'codex'),
      readTesseraVersion: () => '1.0.0',
    }),
  });

  return {
    root,
    integration,
    lifecycleHomes,
    skillHomes,
    resolvedSkillScopes,
    setEnvironment(environment: AgentEnvironment) {
      activeEnvironment = environment;
    },
    blockSkillScope(scope: `${AgentEnvironment}:${ProviderSkillId}`) {
      blockedSkillScopes.add(scope);
    },
    unblockSkillScope(scope: `${AgentEnvironment}:${ProviderSkillId}`) {
      blockedSkillScopes.delete(scope);
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('application cleanup removes every known Tessera-Owned Artifact in its owning Agent Environment', async () => {
  const harness = createHarness();
  const userHook = { hooks: [{ type: 'command', command: '/opt/user/lifecycle-hook' }] };
  try {
    for (const environment of ['native', 'wsl'] as const) {
      harness.setEnvironment(environment);
      fs.writeFileSync(path.join(harness.lifecycleHomes[environment], 'hooks.json'), JSON.stringify({
        authentication: { token: `preserve-${environment}` },
        hooks: { Stop: [userHook] },
      }, null, 2));
      const installed = await harness.integration.installLifecycle({
        provider: codexProvider,
        agentEnvironmentOwner: { kind: 'user', userId: 'cleanup-owner' },
        consent: 'granted',
      });
      assert.equal(installed.lifecycle.state, 'installed');
    }

    harness.setEnvironment('native');
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'cleanup-owner' },
      providerIds: ['claude-code', 'codex'],
    });
    harness.setEnvironment('wsl');
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'cleanup-owner' },
      providerIds: ['opencode'],
    });

    const preservedSkill = path.join(harness.skillHomes['wsl:opencode'], 'skills', 'my-skill');
    fs.mkdirSync(preservedSkill, { recursive: true });
    fs.writeFileSync(path.join(preservedSkill, 'SKILL.md'), 'user-owned\n');
    fs.writeFileSync(path.join(harness.lifecycleHomes.native, 'history.jsonl'), 'provider history\n');

    harness.resolvedSkillScopes.length = 0;
    const result = await harness.integration.cleanupOwnedArtifacts();

    assert.equal(result.complete, true);
    assert.deepEqual(
      result.artifacts.map(({ artifact, providerId, agentEnvironment, state }) => ({
        artifact,
        providerId,
        agentEnvironment,
        state,
      })),
      [
        { artifact: 'lifecycle-hook', providerId: 'codex', agentEnvironment: 'native', state: 'removed' },
        { artifact: 'lifecycle-hook', providerId: 'codex', agentEnvironment: 'wsl', state: 'removed' },
        { artifact: 'provider-skill', providerId: 'claude-code', agentEnvironment: 'native', state: 'removed' },
        { artifact: 'provider-skill', providerId: 'codex', agentEnvironment: 'native', state: 'removed' },
        { artifact: 'provider-skill', providerId: 'opencode', agentEnvironment: 'wsl', state: 'removed' },
      ],
    );
    assert.deepEqual(harness.resolvedSkillScopes.sort(), [
      'native:claude-code',
      'native:codex',
      'wsl:opencode',
    ]);
    for (const environment of ['native', 'wsl'] as const) {
      assert.equal(hasTesseraHook(harness.lifecycleHomes[environment]), false);
      assert.deepEqual(hookDocument(harness.lifecycleHomes[environment]).hooks.Stop, [userHook]);
      assert.equal(
        hookDocument(harness.lifecycleHomes[environment]).authentication.token,
        `preserve-${environment}`,
      );
    }
    assert.equal(fs.readFileSync(path.join(harness.lifecycleHomes.native, 'history.jsonl'), 'utf8'), 'provider history\n');
    assert.equal(fs.readFileSync(path.join(preservedSkill, 'SKILL.md'), 'utf8'), 'user-owned\n');
  } finally {
    harness.cleanup();
  }
});

test('application cleanup reports partial failure and retries known artifacts without opposite-environment fallback', async () => {
  const harness = createHarness();
  try {
    harness.setEnvironment('native');
    await harness.integration.installLifecycle({
      provider: codexProvider,
      agentEnvironmentOwner: { kind: 'user', userId: 'retry-owner' },
      consent: 'granted',
    });
    harness.setEnvironment('wsl');
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'retry-owner' },
      providerIds: ['opencode'],
    });
    const skillPath = path.join(harness.skillHomes['wsl:opencode'], 'skills', 'tessera-cli');
    harness.blockSkillScope('wsl:opencode');

    const partial = await harness.integration.cleanupOwnedArtifacts();

    assert.equal(partial.complete, false);
    assert.deepEqual(partial.artifacts.map(({ artifact, agentEnvironment, state }) => ({
      artifact,
      agentEnvironment,
      state,
    })), [
      { artifact: 'lifecycle-hook', agentEnvironment: 'native', state: 'removed' },
      { artifact: 'provider-skill', agentEnvironment: 'wsl', state: 'failed' },
    ]);
    assert.match(partial.artifacts[1].message ?? '', /no opposite environment was used/i);
    assert.match(partial.artifacts[1].recovery ?? '', /retry Tessera removal/i);
    assert.equal(hasTesseraHook(harness.lifecycleHomes.native), false);
    assert.equal(fs.existsSync(skillPath), true);

    harness.unblockSkillScope('wsl:opencode');
    const retried = await harness.integration.cleanupOwnedArtifacts();

    assert.equal(retried.complete, true);
    assert.deepEqual(retried.artifacts.map(({ artifact, agentEnvironment, state }) => ({
      artifact,
      agentEnvironment,
      state,
    })), [
      { artifact: 'lifecycle-hook', agentEnvironment: 'native', state: 'absent' },
      { artifact: 'provider-skill', agentEnvironment: 'wsl', state: 'removed' },
    ]);
    assert.equal(fs.existsSync(skillPath), false);
  } finally {
    harness.cleanup();
  }
});

test('application cleanup preserves externally modified and ownership-conflicted artifacts', async () => {
  const harness = createHarness();
  try {
    await harness.integration.installLifecycle({
      provider: codexProvider,
      agentEnvironmentOwner: { kind: 'user', userId: 'conflict-owner' },
      consent: 'granted',
    });
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'conflict-owner' },
      providerIds: ['claude-code', 'codex'],
    });

    const modifiedHooks = hookDocument(harness.lifecycleHomes.native);
    const managedSessionStart = modifiedHooks.hooks.SessionStart.find((group: unknown) => (
      isRecord(group)
      && Array.isArray(group.hooks)
      && group.hooks.some((handler: unknown) => (
        isRecord(handler)
        && typeof handler.command === 'string'
        && handler.command.includes('/__tessera/hook')
      ))
    ));
    managedSessionStart.hooks[0].timeout = 91;
    const hookText = `${JSON.stringify(modifiedHooks, null, 2)}\n`;
    fs.writeFileSync(path.join(harness.lifecycleHomes.native, 'hooks.json'), hookText);

    const modifiedSkillFile = path.join(
      harness.skillHomes['native:claude-code'],
      'skills',
      'tessera-cli',
      'SKILL.md',
    );
    fs.appendFileSync(modifiedSkillFile, 'external change\n');
    const modifiedSkillText = fs.readFileSync(modifiedSkillFile, 'utf8');

    const userSkillDir = path.join(harness.skillHomes['native:codex'], 'skills', 'tessera-cli');
    fs.rmSync(userSkillDir, { recursive: true, force: true });
    fs.mkdirSync(userSkillDir, { recursive: true });
    const userSkillFile = path.join(userSkillDir, 'SKILL.md');
    fs.writeFileSync(userSkillFile, 'user-created tessera-cli skill\n');

    const result = await harness.integration.cleanupOwnedArtifacts();

    assert.equal(result.complete, false);
    assert.deepEqual(result.artifacts.map(({ artifact, providerId, state }) => ({
      artifact,
      providerId,
      state,
    })), [
      { artifact: 'lifecycle-hook', providerId: 'codex', state: 'conflict' },
      { artifact: 'provider-skill', providerId: 'claude-code', state: 'conflict' },
      { artifact: 'provider-skill', providerId: 'codex', state: 'conflict' },
    ]);
    assert.ok(result.artifacts.every(({ recovery }) => recovery?.includes('retry Tessera removal')));
    assert.equal(fs.readFileSync(path.join(harness.lifecycleHomes.native, 'hooks.json'), 'utf8'), hookText);
    assert.equal(fs.readFileSync(modifiedSkillFile, 'utf8'), modifiedSkillText);
    assert.equal(fs.readFileSync(userSkillFile, 'utf8'), 'user-created tessera-cli skill\n');
  } finally {
    harness.cleanup();
  }
});

test('application cleanup is incomplete when known-artifact discovery state cannot be read', async () => {
  const harness = createHarness();
  try {
    const lifecycleStateDir = path.join(harness.root, 'state', 'provider-integrations', 'codex');
    const skillStateDir = path.join(harness.root, 'state', 'provider-skills');
    fs.mkdirSync(lifecycleStateDir, { recursive: true });
    fs.mkdirSync(skillStateDir, { recursive: true });
    fs.writeFileSync(path.join(lifecycleStateDir, 'lifecycle.json'), '{"version":99}\n');
    fs.writeFileSync(path.join(skillStateDir, 'unknown.json'), '{"version":99}\n');

    const result = await harness.integration.cleanupOwnedArtifacts();

    assert.equal(result.complete, false);
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.problems.map(({ artifact }) => artifact), [
      'lifecycle-hook',
      'provider-skill',
    ]);
    assert.ok(result.problems.every(({ recovery }) => recovery.includes('retry Tessera removal')));
  } finally {
    harness.cleanup();
  }
});

test('application cleanup removes artifacts left in earlier provider homes within one Agent Environment', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-cleanup-home-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lifecycleHomes = [
    path.join(root, 'codex-home-first'),
    path.join(root, 'codex-home-second'),
  ];
  const skillHomes = [
    path.join(root, 'claude-home-first'),
    path.join(root, 'claude-home-second'),
  ];
  for (const home of [...lifecycleHomes, ...skillHomes]) fs.mkdirSync(home, { recursive: true });
  let lifecycleHome = lifecycleHomes[0];
  let skillHome = skillHomes[0];
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    detectSkillProviders: async () => ['claude-code'],
    resolveProviderSkillHome: async () => skillHome,
    providerSkillStateDirectory: path.join(root, 'state', 'provider-skills'),
    readProviderSkillFiles: () => [{ relativePath: 'SKILL.md', content: TEST_SKILL }],
    lifecycle: createCodexLifecycleHookIntegration({
      resolveProviderHome: async () => lifecycleHome,
      readVersion: async () => '0.146.0',
      request: createFakeCodexRequest({ native: lifecycleHomes[0], wsl: lifecycleHomes[0] }),
      stateDirectory: path.join(root, 'state', 'provider-integrations', 'codex'),
      readTesseraVersion: () => '1.0.0',
    }),
  });
  const lifecycleRequest = {
    provider: codexProvider,
    agentEnvironmentOwner: { kind: 'user' as const, userId: 'home-switch-owner' },
    consent: 'granted' as const,
  };
  const skillRequest = {
    operation: 'install' as const,
    agentEnvironmentOwner: { kind: 'user' as const, userId: 'home-switch-owner' },
    providerIds: ['claude-code' as const],
  };

  await integration.installLifecycle(lifecycleRequest);
  await integration.manageSkills(skillRequest);
  lifecycleHome = lifecycleHomes[1];
  skillHome = skillHomes[1];
  await integration.installLifecycle(lifecycleRequest);
  await integration.manageSkills(skillRequest);

  const result = await integration.cleanupOwnedArtifacts();

  assert.equal(result.complete, true);
  assert.equal(result.artifacts.filter(({ artifact }) => artifact === 'lifecycle-hook').length, 2);
  assert.equal(result.artifacts.filter(({ artifact }) => artifact === 'provider-skill').length, 2);
  for (const home of lifecycleHomes) assert.equal(hasTesseraHook(home), false);
  for (const home of skillHomes) {
    assert.equal(fs.existsSync(path.join(home, 'skills', 'tessera-cli')), false);
  }
});

test('one artifact-family failure does not prevent cleanup of other known artifacts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-cleanup-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillHome = path.join(root, 'claude-home');
  fs.mkdirSync(skillHome, { recursive: true });
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
    detectSkillProviders: async () => ['claude-code'],
    resolveProviderSkillHome: async () => skillHome,
    providerSkillStateDirectory: path.join(root, 'state', 'provider-skills'),
    readProviderSkillFiles: () => [{ relativePath: 'SKILL.md', content: TEST_SKILL }],
    lifecycle: {
      async inspect() {
        return { state: 'absent', trust: 'unchecked' };
      },
      async install() {
        return { state: 'installed', trust: 'trusted' };
      },
      async cleanupKnownArtifacts() {
        throw new Error('injected lifecycle discovery failure');
      },
    },
  });
  await integration.manageSkills({
    operation: 'install',
    agentEnvironmentOwner: { kind: 'user', userId: 'isolation-owner' },
    providerIds: ['claude-code'],
  });
  const target = path.join(skillHome, 'skills', 'tessera-cli');

  const result = await integration.cleanupOwnedArtifacts();

  assert.equal(result.complete, false);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(result.artifacts.map(({ artifact, state }) => ({ artifact, state })), [
    { artifact: 'provider-skill', state: 'removed' },
  ]);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].artifact, 'lifecycle-hook');
  assert.match(result.problems[0].message, /injected lifecycle discovery failure/);
});
