import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPhoneAppServerEnvironment,
  sanitizePhoneAppServerEvidence,
  startPhoneAppServer,
} from './helpers/phone-app-server.mjs';

test('phone app-server environment keeps only platform essentials and fixture-owned state', () => {
  const { WSLENV, ...environment } = buildPhoneAppServerEnvironment({
    PATH: [
      '/usr/bin',
      '/HOME/CALLER/.TESSERA/CODEX-OVERLAY/SESSION-HOSTILE/TMP/BIN',
      '/run/user/1000/tessera/control-bridges/bridge-hostile',
    ].join(path.delimiter),
    LANG: 'en_US.UTF-8',
    SystemRoot: 'C:\\Windows',
    WSL_DISTRO_NAME: 'Ubuntu-24.04',
    WSL_INTEROP: '/run/WSL/123_interop',
    HOME: '/home/caller',
    CODEX_HOME: '/home/caller/.tessera/codex-overlay/session-hostile',
    TESSERA_CLI_COMMAND: '/run/user/1000/tessera/control-bridges/bridge-hostile/tessera',
    USERPROFILE: 'C:\\Users\\caller',
    XDG_DATA_HOME: '/home/caller/.local/share',
    WSLENV: 'CODEX_HOME/p:TESSERA_FUTURE_AUTHORITY',
    TERM_PROGRAM: 'Tessera',
    TESSERA_FUTURE_AUTHORITY: 'tessera-authority',
    CODEX_FUTURE_SESSION: 'codex-session',
    CLAUDE_FUTURE_CREDENTIAL: 'claude-credential',
    CLAUDECODE: '1',
    OPENCODE_FUTURE_RUNTIME: 'opencode-runtime',
    GITHUB_TOKEN: 'github-secret',
    SLACK_WEBHOOK_URL: 'https://secret.invalid/hook',
  }, {
    HOME: '/fixture/data',
    USERPROFILE: '/fixture/data',
    NODE_ENV: 'development',
    TESSERA_DATA_DIR: '/fixture/data',
  });

  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    SystemRoot: 'C:\\Windows',
    WSL_DISTRO_NAME: 'Ubuntu-24.04',
    WSL_INTEROP: '/run/WSL/123_interop',
    HOME: '/fixture/data',
    USERPROFILE: '/fixture/data',
    NODE_ENV: 'development',
    TESSERA_DATA_DIR: '/fixture/data',
  });
  const scrubbedAcrossWsl = new Set(WSLENV.split(':'));
  for (const name of [
    'CLAUDECODE',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_FUTURE_CREDENTIAL',
    'CODEX_FUTURE_SESSION',
    'CODEX_HOME',
    'ELECTRON_CHILD',
    'ELECTRON_RUN_AS_NODE',
    'GITHUB_TOKEN',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_DATA_DIR',
    'OPENCODE_FUTURE_RUNTIME',
    'SLACK_WEBHOOK_URL',
    'TERM_PROGRAM',
    'TESSERA_CODEX_HOME',
    'TESSERA_FUTURE_AUTHORITY',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ]) {
    assert.equal(scrubbedAcrossWsl.has(name), true, `${name} must be scrubbed across WSL interop`);
  }
});

test('phone app-server failure evidence redacts caller credentials and session authority', () => {
  const evidence = sanitizePhoneAppServerEvidence(
    'startup failed with s3cr3t and session-authority; useful diagnostic',
    {
      GITHUB_TOKEN: 's3cr3t',
      TESSERA_FUTURE_AUTHORITY: 'session-authority',
    },
  );

  assert.equal(evidence.includes('s3cr3t'), false);
  assert.equal(evidence.includes('session-authority'), false);
  assert.match(evidence, /startup failed/);
  assert.match(evidence, /useful diagnostic/);
  assert.match(evidence, /\[redacted\]/);
});

test('phone app-server removes every owned resource after each initialization failure', async (t) => {
  for (const phase of ['startup', 'settings', 'project', 'session']) {
    await t.test(phase, async () => {
      const name = `phone-server-${phase}-${process.pid}-${Date.now()}`;
      let app;
      let failure;
      try {
        app = await startPhoneAppServer({ name, failInitializationAt: phase });
      } catch (error) {
        failure = error;
      } finally {
        await app?.stop();
      }

      assert.ok(failure instanceof Error, `the forced ${phase} failure must reject`);
      assert.match(failure.message, new RegExp(`phone app-server ${phase} initialization failed`));
      assert.match(failure.message, new RegExp(`forced ${phase} initialization failure`));
      assert.match(failure.message, /isolated server evidence:/);
      const ownership = failure.message.match(/at (http:\/\/127\.0\.0\.1:\d+) \(child pid (\d+)\)/);
      assert.ok(ownership, 'failure evidence must identify the owned listener and child');
      assert.throws(
        () => process.kill(Number(ownership[2]), 0),
        (error) => error?.code === 'ESRCH',
        'the exact fixture child must be gone before startPhoneAppServer rejects',
      );
      await assert.rejects(fetch(ownership[1]), 'the fixture listener must be gone');

      const entries = await fs.readdir(path.join(os.homedir(), 'tmp'));
      assert.deepEqual(
        entries.filter((entry) => entry.startsWith(`tessera-${name}-`)),
        [],
        'the fixture data directory and Git repository must be gone',
      );
    });
  }
});
