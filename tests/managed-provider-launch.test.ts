import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-managed-gui-launch-'));
process.env.TESSERA_DATA_DIR = path.join(root, 'data');

test('GUI providers receive session-scoped Tessera CLI resources only while enabled', async () => {
  const [database, projects, sessions, settings, defaults, sharedBridge] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/settings/manager'),
    import('@/lib/settings/defaults'),
    import('@/lib/control/shared-cli-bridge'),
  ]);
  const { prepareManagedProviderLaunchResources } = await import(
    '@/lib/control/managed-provider-launch'
  );
  await database.initDatabase();
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  projects.registerProject('managed-gui-project', workspace, 'Managed GUI project');

  let bridgeCalls = 0;
  let bridgeDisposals = 0;
  const releaseBridge = sharedBridge.configureSharedControlCliBridge({
    create: async (context) => {
      bridgeCalls += 1;
      assert.equal(context.projectId, 'managed-gui-project');
      return {
        commandPath: `/tmp/${context.sessionId}/tessera`,
        environment: {
          TESSERA_ENV: '1',
          TESSERA_CLI_COMMAND: `/tmp/${context.sessionId}/tessera`,
          TESSERA_PROJECT_ID: context.projectId,
          TESSERA_SESSION_ID: context.sessionId,
        },
        dispose: async () => { bridgeDisposals += 1; },
      };
    },
    dispose: async () => {},
  });

  await settings.SettingsManager.save('managed-gui-user', {
    ...defaults.DEFAULT_SETTINGS,
    agentEnvironment: 'native',
    tesseraCliEnabled: true,
  });

  for (const providerId of ['claude-code', 'codex', 'opencode']) {
    const sessionId = `managed-gui-${providerId}`;
    sessions.createSession(
      sessionId,
      'managed-gui-project',
      sessionId,
      providerId,
      { workDir: workspace },
    );
    const resources = await prepareManagedProviderLaunchResources({
      sessionId,
      userId: 'managed-gui-user',
    });
    const rootDir = resources.managedLaunch.skillOverlay?.rootDir;
    const skillsDir = resources.managedLaunch.skillOverlay?.skillsDir;
    assert.ok(rootDir);
    assert.ok(skillsDir);
    assert.equal(resources.managedLaunch.environment.TESSERA_ENV, '1');
    assert.equal(
      fs.readFileSync(path.join(rootDir, 'skills/tessera-cli/SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(process.cwd(), 'skills/tessera-cli/SKILL.md'), 'utf8'),
    );
    assert.equal(
      fs.readFileSync(path.join(skillsDir, 'tessera-cli/SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(process.cwd(), 'skills/tessera-cli/SKILL.md'), 'utf8'),
    );
    assert.notEqual(skillsDir, path.join(rootDir, 'skills'));
    assert.equal(
      fs.existsSync(path.join(path.dirname(skillsDir), '.claude-plugin')),
      false,
      'Codex standalone skills must not sit beneath the Claude plugin manifest',
    );
    await resources.dispose();
    await resources.dispose();
    assert.equal(fs.existsSync(rootDir), false);
  }
  assert.equal(bridgeCalls, 3);
  assert.equal(bridgeDisposals, 3);

  await settings.SettingsManager.save('managed-gui-user', {
    ...defaults.DEFAULT_SETTINGS,
    agentEnvironment: 'native',
    tesseraCliEnabled: false,
  });
  process.env.TESSERA_CLI_COMMAND = '/stale/parent/tessera';
  const disabled = await prepareManagedProviderLaunchResources({
    sessionId: 'managed-gui-claude-code',
    userId: 'managed-gui-user',
  });
  assert.equal(disabled.managedLaunch.environment.TESSERA_CLI_COMMAND, undefined);
  assert.equal(disabled.managedLaunch.skillOverlay, undefined);
  assert.equal(bridgeCalls, 3);
  delete process.env.TESSERA_CLI_COMMAND;
  await releaseBridge();
});

test.after(() => {
  delete process.env.TESSERA_DATA_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});
