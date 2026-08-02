import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupCodexOverlayForTerminal,
  createCodexOverlay,
} from '@/lib/terminal/codex-overlay';

// 훅 커맨드(hook-command.ts)나 timeout이 바뀌면 함께 바뀐다 — codex의
// command_hook_hash 계약(정규화·직렬화)이 유지되는지 고정하는 값.
const EXPECTED_TRUSTED_HASHES = {
  session_start: 'sha256:54118a230f5a83c3bd07b62077af4c27a38bd3d2e7087c3771b2effb1318e2f9',
  user_prompt_submit: 'sha256:0f11b1e78a95d841d47f37b1bd79b598ce91ba11f0962e4fb4b30c264fb4d9f1',
  pre_tool_use: 'sha256:c6164b8a833972d6597fb603f95193db1a327b1c6bebd379fad3d06e42509285',
  permission_request: 'sha256:dbfc8a48b3def5b466ef460fdc822ba1521ec4ed587227d237c8cccc19f3c2e3',
  post_tool_use: 'sha256:9417b820045acf8a0ada4b56ab7d0295b36fe475949ce9bf77b3db36b3bd6ba1',
  stop: 'sha256:5af8ee0181c8ee533e4a53fc56e393ee95096c6c7699613d56438d98a198e5a1',
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
