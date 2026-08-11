import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { processManager } from '../src/lib/cli/process-manager';
import { startControlRuntimeHost } from '../src/lib/control/runtime-host';
import { configureSharedProviderControlCliBridge } from '../src/lib/terminal/shared-provider-launch-module';
import { runControlCli } from './helpers/control-cli-runner';

const REPO_ROOT = process.cwd();
const PACKAGE_VERSION = JSON.parse(
  fsSync.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
).version as string;

test('the shared runtime host publishes one pinned CLI transport and cleans it up', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-host-'));
  const descriptorPath = path.join(testRoot, 'runtime', 'descriptor.json');
  const host = await startControlRuntimeHost({
    appVersion: PACKAGE_VERSION,
    appRoot: REPO_ROOT,
    descriptorPath,
    bridgeArtifactRoot: path.join(testRoot, 'bridges'),
    resolveUserId: async () => 'control-host-user',
  });

  try {
    const status = await runControlCli(
      ['status', '--json', '--control-descriptor', descriptorPath],
      {
        repoRoot: REPO_ROOT,
        envOverrides: {
          TESSERA_PROJECT_ID: '',
          TESSERA_SESSION_ID: '',
          TESSERA_WORKTREE_ID: '',
        },
      },
    );
    assert.equal(status.code, 1);
    assert.equal(status.stderr, '');
    assert.deepEqual(JSON.parse(status.stdout).error, {
      code: 'CONTROL_AUTHORITY_DENIED',
      message: 'The caller does not have active Tessera Control authority.',
      details: {},
    });
    assert.equal(fsSync.existsSync(descriptorPath), true);
  } finally {
    await host.close();
  }

  assert.equal(fsSync.existsSync(descriptorPath), false);
  assert.equal(fsSync.existsSync(path.join(testRoot, 'bridges', host.runtimeId)), false);
  await fs.rm(testRoot, { recursive: true, force: true });
  await processManager.cleanup();
});

test('shared bridge release can retry a transient runtime cleanup failure', async () => {
  let disposeAttempts = 0;
  const release = configureSharedProviderControlCliBridge({
    create: async () => { throw new Error('not used'); },
    dispose: async () => {
      disposeAttempts += 1;
      if (disposeAttempts === 1) throw new Error('guest cleanup unavailable');
    },
  });

  await assert.rejects(release(), /guest cleanup unavailable/);
  await release();
  assert.equal(disposeAttempts, 2);
});
