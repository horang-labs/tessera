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
      provider: { getProviderId: () => 'claude-code' },
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
      provider: { getProviderId: () => 'opencode' },
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
      provider: { getProviderId: () => 'codex' },
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
      provider: { getProviderId: () => 'claude-code' },
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
      },
      {
        providerId: 'codex',
        detected: true,
        state: 'absent',
        consent: 'not-granted',
        ownership: 'none',
      },
      {
        providerId: 'opencode',
        detected: true,
        state: 'ready',
        consent: 'granted',
        ownership: 'tessera',
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
