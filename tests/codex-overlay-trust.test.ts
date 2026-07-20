import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupCodexOverlayForTerminal,
  createCodexOverlay,
} from '@/lib/terminal/codex-overlay';

const EXPECTED_TRUSTED_HASHES = {
  session_start: 'sha256:b110bff27560016b57f45a92f7ffd2a2c71261ccad6eafaab5e3d6badd538865',
  user_prompt_submit: 'sha256:986f649fe8960d2fd766b18c74ed61b7c9f554806cc8d10f6dbe175851a47f89',
  stop: 'sha256:60cf356001b94ca293e9eb42ccf9be0c5b2d21e878fd4509d575c550666ef584',
} as const;

test('Codex overlay pre-trusts exactly the lifecycle hooks it installs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-overlay-trust-'));
  const systemHome = path.join(root, 'system-codex-home');
  const dataDir = path.join(root, 'tessera-data');
  fs.mkdirSync(systemHome, { recursive: true });
  fs.writeFileSync(
    path.join(systemHome, 'config.toml'),
    'model = "gpt-5.4"\n\n[projects."/tmp/example"]\ntrust_level = "trusted"\n',
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  process.env.CODEX_HOME = systemHome;
  process.env.TESSERA_DATA_DIR = dataDir;

  try {
    const originalSystemConfig = fs.readFileSync(path.join(systemHome, 'config.toml'), 'utf8');
    const overlayDir = createCodexOverlay('terminal-trust-test');
    const hooksPath = fs.realpathSync.native(path.join(overlayDir, 'hooks.json'));
    const config = fs.readFileSync(path.join(overlayDir, 'config.toml'), 'utf8');

    assert.match(config, /^model = "gpt-5\.4"$/m);
    assert.match(config, /^\[projects\."\/tmp\/example"\]$/m);
    for (const [eventLabel, trustedHash] of Object.entries(EXPECTED_TRUSTED_HASHES)) {
      const key = `${hooksPath}:${eventLabel}:0:0`;
      const escapedBasicKey = key
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"');
      const header = [
        `\\[hooks\\.state\\."${escapeRegExp(escapedBasicKey)}"\\]`,
        `\\[hooks\\.state\\.'${escapeRegExp(key)}'\\]`,
      ].join('|');
      assert.match(
        config,
        new RegExp(
          `(?:${header})\\nenabled = true\\ntrusted_hash = "${trustedHash}"`,
        ),
      );
    }
    assert.equal(
      fs.readFileSync(path.join(systemHome, 'config.toml'), 'utf8'),
      originalSystemConfig,
      'creating an overlay must not mutate the user config',
    );
  } finally {
    cleanupCodexOverlayForTerminal('terminal-trust-test');
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('TESSERA_DATA_DIR', previousDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
