import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createProviderIntegration,
  type ProviderSkillId,
} from '@/lib/cli/provider-integration';

const PROVIDERS: ProviderSkillId[] = ['claude-code', 'codex', 'opencode'];
const TEST_SKILL = '---\nname: tessera-cli\ndescription: test\n---\nUse TESSERA_CLI_COMMAND.\n';

function skillOnlyProvider(providerId: ProviderSkillId) {
  return {
    getProviderId: () => providerId,
    getProviderIntegrationRequirements: () => ({
      lifecycle: 'not-applicable' as const,
      skill: 'optional' as const,
      launchEnvironment: 'not-applicable' as const,
    }),
  };
}

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-skills-'));
  const homes = Object.fromEntries(
    ['native', 'wsl'].flatMap((environment) => PROVIDERS.map((providerId) => [
      `${environment}:${providerId}`,
      path.join(root, environment, providerId),
    ])),
  ) as Record<string, string>;
  const createIntegration = (
    environment: 'native' | 'wsl' = 'native',
    skillContent: string = TEST_SKILL,
    detectedProviders: ProviderSkillId[] = PROVIDERS,
  ) => (
    createProviderIntegration({
      resolveAgentEnvironment: async () => environment,
      detectSkillProviders: async () => detectedProviders,
      resolveProviderSkillHome: async (providerId, selectedEnvironment) => (
        homes[`${selectedEnvironment}:${providerId}`]
      ),
      providerSkillStateDirectory: path.join(root, 'state'),
      readProviderSkillFiles: () => [{
        relativePath: 'SKILL.md',
        content: skillContent,
      }],
    })
  );
  const integration = createIntegration();
  return {
    root,
    homes,
    integration,
    createIntegration,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('install selects every detected supported provider in the current native Agent Environment', async () => {
  const harness = createHarness();
  try {
    const result = await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'native-user' },
    });

    assert.equal(result.success, true);
    assert.equal(result.agentEnvironment, 'native');
    assert.deepEqual(result.providers.map((provider) => provider.providerId), PROVIDERS);
    for (const providerId of PROVIDERS) {
      assert.equal(
        fs.readFileSync(
          path.join(harness.homes[`native:${providerId}`], 'skills', 'tessera-cli', 'SKILL.md'),
          'utf8',
        ),
        TEST_SKILL,
      );
      assert.equal(
        fs.existsSync(path.join(harness.homes[`wsl:${providerId}`], 'skills', 'tessera-cli')),
        false,
      );
    }
  } finally {
    harness.cleanup();
  }
});

test('default install fails before resolving homes when no supported provider is detected', async () => {
  const harness = createHarness();
  let resolvedHomes = 0;
  try {
    const integration = createProviderIntegration({
      resolveAgentEnvironment: async () => 'native',
      detectSkillProviders: async () => [],
      resolveProviderSkillHome: async () => {
        resolvedHomes += 1;
        throw new Error('must not resolve a provider home');
      },
      providerSkillStateDirectory: path.join(harness.root, 'empty-state'),
      readProviderSkillFiles: () => [{ relativePath: 'SKILL.md', content: TEST_SKILL }],
    });

    const result = await integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'empty-user' },
    });

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'PROVIDER_SKILL_NO_PROVIDERS');
    assert.equal(resolvedHomes, 0);
  } finally {
    harness.cleanup();
  }
});

test('an explicit provider selection is treated as a set', async () => {
  const harness = createHarness();
  try {
    const result = await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'duplicate-selection-user' },
      providerIds: ['codex', 'codex'],
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.providers.map(({ providerId }) => providerId), ['codex']);
  } finally {
    harness.cleanup();
  }
});

test('concurrent provider commands preserve every consent ledger update', async () => {
  const harness = createHarness();
  try {
    const owner = { kind: 'user' as const, userId: 'concurrent-user' };
    const [claude, codex] = await Promise.all([
      harness.integration.manageSkills({
        operation: 'install',
        agentEnvironmentOwner: owner,
        providerIds: ['claude-code'],
      }),
      harness.integration.manageSkills({
        operation: 'install',
        agentEnvironmentOwner: owner,
        providerIds: ['codex'],
      }),
    ]);

    assert.equal(claude.success, true);
    assert.equal(codex.success, true);
    const status = await harness.createIntegration().manageSkills({
      operation: 'status',
      agentEnvironmentOwner: owner,
      providerIds: ['claude-code', 'codex'],
    });
    assert.deepEqual(status.providers.map(({ providerId, consent }) => ({
      providerId,
      consent,
    })), [
      { providerId: 'claude-code', consent: 'granted' },
      { providerId: 'codex', consent: 'granted' },
    ]);
  } finally {
    harness.cleanup();
  }
});

test('changing Agent Environments requires fresh consent and leaves the prior install in place', async () => {
  const harness = createHarness();
  try {
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'environment-user' },
      providerIds: ['codex'],
    });

    const wslStatus = await harness.createIntegration('wsl').manageSkills({
      operation: 'status',
      agentEnvironmentOwner: { kind: 'user', userId: 'environment-user' },
      providerIds: ['codex'],
    });
    assert.deepEqual(wslStatus.providers, [{
      providerId: 'codex',
      detected: true,
      state: 'absent',
      consent: 'not-granted',
      ownership: 'none',
      policy: { onboarding: 'offer', canInstall: true, canUpdate: false, canRemove: false },
    }]);
    assert.equal(
      fs.existsSync(path.join(harness.homes['native:codex'], 'skills', 'tessera-cli')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(harness.homes['wsl:codex'], 'skills', 'tessera-cli')),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test('a newly detected provider stays absent until a fresh explicit install grants consent', async () => {
  const harness = createHarness();
  try {
    const initialIntegration = harness.createIntegration('native', TEST_SKILL, ['codex']);
    await initialIntegration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'new-provider-user' },
    });

    const expandedIntegration = harness.createIntegration(
      'native',
      TEST_SKILL,
      ['claude-code', 'codex'],
    );
    const status = await expandedIntegration.manageSkills({
      operation: 'status',
      agentEnvironmentOwner: { kind: 'user', userId: 'new-provider-user' },
    });
    assert.deepEqual(status.providers.map(({ providerId, state, consent }) => ({
      providerId,
      state,
      consent,
    })), [
      { providerId: 'claude-code', state: 'absent', consent: 'not-granted' },
      { providerId: 'codex', state: 'ready', consent: 'granted' },
    ]);

    const launch = await expandedIntegration.resolveLaunch({
      provider: skillOnlyProvider('claude-code'),
      agentEnvironmentOwner: { kind: 'user', userId: 'new-provider-user' },
    });
    assert.equal(launch.skill.state, 'absent');
    assert.equal(launch.skill.consent, 'declined');
    assert.equal(
      fs.existsSync(path.join(harness.homes['native:claude-code'], 'skills', 'tessera-cli')),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test('update refreshes a stale Tessera-owned skill only after prior consent', async () => {
  const harness = createHarness();
  const updatedSkill = `${TEST_SKILL}\nVersion two.\n`;
  try {
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'update-user' },
      providerIds: ['opencode'],
    });
    const updatedIntegration = harness.createIntegration('native', updatedSkill);
    const stale = await updatedIntegration.manageSkills({
      operation: 'status',
      agentEnvironmentOwner: { kind: 'user', userId: 'update-user' },
      providerIds: ['opencode'],
    });
    assert.equal(stale.providers[0]?.state, 'stale');

    const result = await updatedIntegration.manageSkills({
      operation: 'update',
      agentEnvironmentOwner: { kind: 'user', userId: 'update-user' },
      providerIds: ['opencode'],
    });

    assert.equal(result.success, true);
    assert.equal(result.providers[0]?.state, 'ready');
    assert.equal(
      fs.readFileSync(
        path.join(harness.homes['native:opencode'], 'skills', 'tessera-cli', 'SKILL.md'),
        'utf8',
      ),
      updatedSkill,
    );
  } finally {
    harness.cleanup();
  }
});

test('remove deletes only the Tessera-owned skill and revokes automatic management consent', async () => {
  const harness = createHarness();
  try {
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'remove-user' },
      providerIds: ['claude-code'],
    });

    const removed = await harness.integration.manageSkills({
      operation: 'remove',
      agentEnvironmentOwner: { kind: 'user', userId: 'remove-user' },
      providerIds: ['claude-code'],
    });
    assert.equal(removed.success, true);
    assert.deepEqual(removed.providers, [{
      providerId: 'claude-code',
      detected: true,
      state: 'absent',
      consent: 'revoked',
      ownership: 'none',
      policy: { onboarding: 'none', canInstall: true, canUpdate: false, canRemove: false },
    }]);
    assert.equal(
      fs.existsSync(path.join(harness.homes['native:claude-code'], 'skills', 'tessera-cli')),
      false,
    );

    const status = await harness.createIntegration().manageSkills({
      operation: 'status',
      agentEnvironmentOwner: { kind: 'user', userId: 'remove-user' },
      providerIds: ['claude-code'],
    });
    assert.equal(status.providers[0]?.consent, 'revoked');
    assert.equal(status.providers[0]?.state, 'absent');
  } finally {
    harness.cleanup();
  }
});

test('external modification stops automatic management and is reported without overwrite', async () => {
  const harness = createHarness();
  const skillPath = path.join(
    harness.homes['native:codex'],
    'skills',
    'tessera-cli',
    'SKILL.md',
  );
  try {
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'modified-user' },
      providerIds: ['codex'],
    });
    fs.appendFileSync(skillPath, '\nexternal edit\n');

    const status = await harness.integration.manageSkills({
      operation: 'status',
      agentEnvironmentOwner: { kind: 'user', userId: 'modified-user' },
      providerIds: ['codex'],
    });
    assert.deepEqual(status.providers, [{
      providerId: 'codex',
      detected: true,
      state: 'conflict',
      consent: 'granted',
      ownership: 'tessera',
      policy: { onboarding: 'none', canInstall: false, canUpdate: false, canRemove: false },
    }]);

    const update = await harness.integration.manageSkills({
      operation: 'update',
      agentEnvironmentOwner: { kind: 'user', userId: 'modified-user' },
      providerIds: ['codex'],
    });
    assert.equal(update.success, false);
    assert.equal(update.error?.code, 'PROVIDER_SKILL_CONFLICT');
    assert.match(fs.readFileSync(skillPath, 'utf8'), /external edit/);
  } finally {
    harness.cleanup();
  }
});

test('remove is all-or-nothing when one selected provider has an ownership conflict', async () => {
  const harness = createHarness();
  const claudeSkill = path.join(
    harness.homes['native:claude-code'],
    'skills',
    'tessera-cli',
    'SKILL.md',
  );
  const codexSkill = path.join(
    harness.homes['native:codex'],
    'skills',
    'tessera-cli',
    'SKILL.md',
  );
  try {
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'remove-conflict-user' },
      providerIds: ['claude-code', 'codex'],
    });
    fs.appendFileSync(codexSkill, '\nexternal edit\n');

    const result = await harness.integration.manageSkills({
      operation: 'remove',
      agentEnvironmentOwner: { kind: 'user', userId: 'remove-conflict-user' },
      providerIds: ['claude-code', 'codex'],
    });

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'PROVIDER_SKILL_CONFLICT');
    assert.equal(fs.readFileSync(claudeSkill, 'utf8'), TEST_SKILL);
    assert.match(fs.readFileSync(codexSkill, 'utf8'), /external edit/);
  } finally {
    harness.cleanup();
  }
});

test('Session launch refreshes a consented stale skill through Provider Integration', async () => {
  const harness = createHarness();
  const updatedSkill = `${TEST_SKILL}\nLaunch version.\n`;
  try {
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'launch-refresh-user' },
      providerIds: ['opencode'],
    });

    const launch = await harness.createIntegration('native', updatedSkill).resolveLaunch({
      provider: skillOnlyProvider('opencode'),
      agentEnvironmentOwner: { kind: 'user', userId: 'launch-refresh-user' },
    });

    assert.equal(launch.skill.state, 'ready');
    assert.equal(launch.skill.consent, 'granted');
    assert.equal(
      fs.readFileSync(
        path.join(harness.homes['native:opencode'], 'skills', 'tessera-cli', 'SKILL.md'),
        'utf8',
      ),
      updatedSkill,
    );
  } finally {
    harness.cleanup();
  }
});

test('Session launch reports an externally modified skill but remains nonblocking', async () => {
  const harness = createHarness();
  const skillPath = path.join(
    harness.homes['native:codex'],
    'skills',
    'tessera-cli',
    'SKILL.md',
  );
  try {
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'launch-conflict-user' },
      providerIds: ['codex'],
    });
    fs.appendFileSync(skillPath, '\nexternal launch edit\n');

    const launch = await harness.integration.resolveLaunch({
      provider: skillOnlyProvider('codex'),
      agentEnvironmentOwner: { kind: 'user', userId: 'launch-conflict-user' },
    });

    assert.equal(launch.skill.state, 'conflict');
    assert.equal(launch.skill.consent, 'granted');
    assert.notEqual(launch.health.state, 'blocked');
    assert.match(fs.readFileSync(skillPath, 'utf8'), /external launch edit/);
  } finally {
    harness.cleanup();
  }
});

test('Session launch reports a user-owned collision before consent without changing it', async () => {
  const harness = createHarness();
  const skillPath = path.join(
    harness.homes['native:claude-code'],
    'skills',
    'tessera-cli',
    'SKILL.md',
  );
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, 'user-owned before consent\n');
  try {
    const launch = await harness.integration.resolveLaunch({
      provider: skillOnlyProvider('claude-code'),
      agentEnvironmentOwner: { kind: 'user', userId: 'pre-consent-conflict-user' },
    });

    assert.equal(launch.skill.state, 'conflict');
    assert.equal(launch.skill.consent, 'declined');
    assert.equal(launch.health.state, 'degraded');
    assert.equal(fs.readFileSync(skillPath, 'utf8'), 'user-owned before consent\n');
  } finally {
    harness.cleanup();
  }
});

test('Session launch remains nonblocking when its provider home cannot be inspected', async () => {
  const harness = createHarness();
  try {
    const integration = createProviderIntegration({
      resolveAgentEnvironment: async () => 'wsl',
      detectSkillProviders: async () => ['opencode'],
      resolveProviderSkillHome: async () => {
        throw new Error('fake WSL home unavailable');
      },
      providerSkillStateDirectory: path.join(harness.root, 'unavailable-state'),
      readProviderSkillFiles: () => [{ relativePath: 'SKILL.md', content: TEST_SKILL }],
    });

    const launch = await integration.resolveLaunch({
      provider: skillOnlyProvider('opencode'),
      agentEnvironmentOwner: { kind: 'user', userId: 'unavailable-home-user' },
    });

    assert.equal(launch.providerHome.agentEnvironment, 'wsl');
    assert.equal(launch.skill.state, 'conflict');
    assert.equal(launch.skill.consent, 'declined');
    assert.equal(launch.health.state, 'degraded');
  } finally {
    harness.cleanup();
  }
});

test('Session maintenance remains pinned to the launch Agent Environment during a settings race', async () => {
  const harness = createHarness();
  const updatedSkill = `${TEST_SKILL}\nPinned update.\n`;
  try {
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'settings-race-user' },
      providerIds: ['codex'],
    });
    let environmentResolutions = 0;
    const racingIntegration = createProviderIntegration({
      resolveAgentEnvironment: async () => (
        environmentResolutions++ === 0 ? 'native' : 'wsl'
      ),
      detectSkillProviders: async () => PROVIDERS,
      resolveProviderSkillHome: async (providerId, environment) => (
        harness.homes[`${environment}:${providerId}`]
      ),
      providerSkillStateDirectory: path.join(harness.root, 'state'),
      readProviderSkillFiles: () => [{ relativePath: 'SKILL.md', content: updatedSkill }],
    });

    const launch = await racingIntegration.resolveLaunch({
      provider: skillOnlyProvider('codex'),
      agentEnvironmentOwner: { kind: 'user', userId: 'settings-race-user' },
    });

    assert.equal(launch.providerHome.agentEnvironment, 'native');
    assert.equal(environmentResolutions, 1);
    assert.equal(
      fs.readFileSync(
        path.join(harness.homes['native:codex'], 'skills', 'tessera-cli', 'SKILL.md'),
        'utf8',
      ),
      updatedSkill,
    );
    assert.equal(
      fs.existsSync(path.join(harness.homes['wsl:codex'], 'skills', 'tessera-cli')),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test('Session launch does not reinstall a skill after explicit removal revoked consent', async () => {
  const harness = createHarness();
  const skillDir = path.join(harness.homes['native:claude-code'], 'skills', 'tessera-cli');
  try {
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'launch-revoked-user' },
      providerIds: ['claude-code'],
    });
    await harness.integration.manageSkills({
      operation: 'remove',
      agentEnvironmentOwner: { kind: 'user', userId: 'launch-revoked-user' },
      providerIds: ['claude-code'],
    });

    const launch = await harness.createIntegration().resolveLaunch({
      provider: skillOnlyProvider('claude-code'),
      agentEnvironmentOwner: { kind: 'user', userId: 'launch-revoked-user' },
    });

    assert.equal(launch.skill.state, 'absent');
    assert.equal(launch.skill.consent, 'revoked');
    assert.equal(fs.existsSync(skillDir), false);
  } finally {
    harness.cleanup();
  }
});

test('status survives a Provider Integration restart as user-global environment state', async () => {
  const harness = createHarness();
  try {
    await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'persistent-user' },
      providerIds: ['claude-code', 'opencode'],
    });

    const result = await harness.createIntegration().manageSkills({
      operation: 'status',
      agentEnvironmentOwner: { kind: 'user', userId: 'persistent-user' },
      providerIds: ['claude-code', 'codex', 'opencode'],
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.providers, [
      {
        providerId: 'claude-code',
        detected: true,
        state: 'ready',
        consent: 'granted',
        ownership: 'tessera',
        policy: { onboarding: 'none', canInstall: false, canUpdate: true, canRemove: true },
      },
      {
        providerId: 'codex',
        detected: true,
        state: 'absent',
        consent: 'not-granted',
        ownership: 'none',
        policy: { onboarding: 'offer', canInstall: true, canUpdate: false, canRemove: false },
      },
      {
        providerId: 'opencode',
        detected: true,
        state: 'ready',
        consent: 'granted',
        ownership: 'tessera',
        policy: { onboarding: 'none', canInstall: false, canUpdate: true, canRemove: true },
      },
    ]);
  } finally {
    harness.cleanup();
  }
});

test('an explicit provider selection preserves unselected providers', async () => {
  const harness = createHarness();
  try {
    const result = await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'selected-user' },
      providerIds: ['codex'],
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.providers.map((provider) => provider.providerId), ['codex']);
    assert.equal(
      fs.existsSync(path.join(harness.homes['native:codex'], 'skills', 'tessera-cli')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(harness.homes['native:claude-code'], 'skills', 'tessera-cli')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(harness.homes['native:opencode'], 'skills', 'tessera-cli')),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test('Provider Integration rejects consent when the displayed Agent Environment changed', async () => {
  const harness = createHarness();
  let resolvedHomes = 0;
  try {
    const integration = createProviderIntegration({
      resolveAgentEnvironment: async () => 'wsl',
      detectSkillProviders: async () => ['codex'],
      resolveProviderSkillHome: async () => {
        resolvedHomes += 1;
        return harness.homes['wsl:codex'];
      },
      providerSkillStateDirectory: path.join(harness.root, 'environment-race-state'),
      readProviderSkillFiles: () => [{ relativePath: 'SKILL.md', content: TEST_SKILL }],
    });

    const result = await integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'environment-race-user' },
      providerIds: ['codex'],
      expectedAgentEnvironment: 'native',
    });

    assert.equal(result.success, false);
    assert.equal(result.agentEnvironment, 'wsl');
    assert.equal(result.error?.code, 'PROVIDER_SKILL_ENVIRONMENT_CHANGED');
    assert.equal(resolvedHomes, 0);
  } finally {
    harness.cleanup();
  }
});

test('Provider Integration status isolates an unavailable provider from healthy provider states', async () => {
  const harness = createHarness();
  try {
    const integration = createProviderIntegration({
      resolveAgentEnvironment: async () => 'native',
      detectSkillProviders: async () => PROVIDERS,
      resolveProviderSkillHome: async (providerId, environment) => {
        if (providerId === 'codex') throw new Error('Codex home unavailable');
        return harness.homes[`${environment}:${providerId}`];
      },
      providerSkillStateDirectory: path.join(harness.root, 'isolated-status-state'),
      readProviderSkillFiles: () => [{ relativePath: 'SKILL.md', content: TEST_SKILL }],
    });

    const result = await integration.manageSkills({
      operation: 'status',
      agentEnvironmentOwner: { kind: 'user', userId: 'isolated-status-user' },
      providerIds: PROVIDERS,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.providers.map(({ providerId, state }) => ({ providerId, state })), [
      { providerId: 'claude-code', state: 'absent' },
      { providerId: 'codex', state: 'unavailable' },
      { providerId: 'opencode', state: 'absent' },
    ]);
    assert.equal(result.providers[1]?.policy.canInstall, false);
  } finally {
    harness.cleanup();
  }
});

test('a user-owned collision fails the selected provider set without partial installation', async () => {
  const harness = createHarness();
  const collisionPath = path.join(
    harness.homes['native:codex'],
    'skills',
    'tessera-cli',
    'SKILL.md',
  );
  fs.mkdirSync(path.dirname(collisionPath), { recursive: true });
  fs.writeFileSync(collisionPath, 'user-owned skill\n');

  try {
    const result = await harness.integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'collision-user' },
      providerIds: ['claude-code', 'codex'],
    });

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'PROVIDER_SKILL_CONFLICT');
    assert.equal(
      fs.existsSync(path.join(harness.homes['native:claude-code'], 'skills', 'tessera-cli')),
      false,
    );
    assert.equal(fs.readFileSync(collisionPath, 'utf8'), 'user-owned skill\n');
  } finally {
    harness.cleanup();
  }
});

test('a mid-commit filesystem failure rolls back the whole selected provider set', async () => {
  const harness = createHarness();
  const claudeTarget = path.join(
    harness.homes['native:claude-code'],
    'skills',
    'tessera-cli',
  );
  const codexTarget = path.join(harness.homes['native:codex'], 'skills', 'tessera-cli');
  let injected = false;
  try {
    const integration = createProviderIntegration({
      resolveAgentEnvironment: async () => 'native',
      detectSkillProviders: async () => PROVIDERS,
      resolveProviderSkillHome: async (providerId, environment) => (
        harness.homes[`${environment}:${providerId}`]
      ),
      providerSkillStateDirectory: path.join(harness.root, 'state'),
      readProviderSkillFiles: () => [{ relativePath: 'SKILL.md', content: TEST_SKILL }],
      renameProviderSkillPath: async (source, destination) => {
        if (!injected && destination === codexTarget && source.includes('.stage-')) {
          injected = true;
          throw new Error('injected second-provider commit failure');
        }
        await fs.promises.rename(source, destination);
      },
    });

    const result = await integration.manageSkills({
      operation: 'install',
      agentEnvironmentOwner: { kind: 'user', userId: 'mid-commit-user' },
      providerIds: ['claude-code', 'codex'],
    });

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'PROVIDER_SKILL_TRANSACTION_FAILED');
    assert.equal(injected, true);
    assert.equal(fs.existsSync(claudeTarget), false);
    assert.equal(fs.existsSync(codexTarget), false);
    const status = await harness.createIntegration().manageSkills({
      operation: 'status',
      agentEnvironmentOwner: { kind: 'user', userId: 'mid-commit-user' },
      providerIds: ['claude-code', 'codex'],
    });
    assert.deepEqual(status.providers.map(({ state, consent }) => ({ state, consent })), [
      { state: 'absent', consent: 'not-granted' },
      { state: 'absent', consent: 'not-granted' },
    ]);
  } finally {
    harness.cleanup();
  }
});
