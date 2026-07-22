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
  session_start: 'sha256:0626b462a12e80f8416336be018bbdfabdf833c5e13151c958a57d9fe0c9aced',
  user_prompt_submit: 'sha256:854cacc598204def316a423448c232ce2c942b812541806270aa3ea97c9fcb01',
  pre_tool_use: 'sha256:821062830a944ef60378d1c5691a2ec89fe460af1859b398bdbb8d20d40277c9',
  permission_request: 'sha256:24918cff6d9dd35779ddf31a75a8e4af3750ae4c3532034fe4faaa9fb57d7c7c',
  post_tool_use: 'sha256:89c598cdcec1623498676672866af5166c3fd051a57b16284091514a4472424d',
  stop: 'sha256:93de6115736b90124a5856879795d5e9a1165e1ab8e004ed10e221f18846d267',
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
