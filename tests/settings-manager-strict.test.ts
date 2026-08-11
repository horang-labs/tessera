import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('strict settings load accepts absence but rejects a malformed existing file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-strict-settings-'));
  process.env.TESSERA_DATA_DIR = root;
  try {
    const { SettingsManager } = await import('@/lib/settings/manager');
    const defaults = await SettingsManager.load('missing-user', { silent: true, strict: true });
    assert.equal(defaults.agentEnvironment, 'native');

    const settingsDir = path.join(root, 'settings');
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(path.join(settingsDir, 'malformed-user.json'), '{not-json', 'utf8');
    await assert.rejects(
      SettingsManager.load('malformed-user', { silent: true, strict: true }),
      SyntaxError,
    );
    const { getAgentEnvironmentStrict } = await import('@/lib/cli/spawn-cli');
    await assert.rejects(
      getAgentEnvironmentStrict('malformed-user'),
      SyntaxError,
    );
  } finally {
    delete process.env.TESSERA_DATA_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});
