import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupCodexOverlayForTerminal,
  createCodexOverlay,
  repairCodexOverlayResumePath,
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

test('Codex overlay preserves trust for project-local hooks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-overlay-user-trust-'));
  const systemHome = path.join(root, 'system-codex-home');
  const dataDir = path.join(root, 'tessera-data');
  const projectHookKey = '/tmp/example/.codex/hooks.json:pre_tool_use:0:0';
  fs.mkdirSync(systemHome, { recursive: true });
  fs.writeFileSync(
    path.join(systemHome, 'config.toml'),
    [
      'model = "gpt-5.4"',
      '',
      '[projects."/tmp/example"]',
      'trust_level = "trusted"',
      '',
      `[hooks.state."${projectHookKey}"]`,
      'enabled = true',
      'trusted_hash = "sha256:project-hook"',
      '',
    ].join('\n'),
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  process.env.CODEX_HOME = systemHome;
  process.env.TESSERA_DATA_DIR = dataDir;

  try {
    const overlayDir = createCodexOverlay('terminal-user-trust-test');
    const config = fs.readFileSync(path.join(overlayDir, 'config.toml'), 'utf8');

    assert.match(config, /^\[projects\."\/tmp\/example"\]$/m);
    assert.match(config, /^trust_level = "trusted"$/m);
    assert.match(config, new RegExp(escapeRegExp(`[hooks.state."${projectHookKey}"]`)));
    assert.match(config, /trusted_hash = "sha256:project-hook"/);
  } finally {
    cleanupCodexOverlayForTerminal('terminal-user-trust-test');
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('TESSERA_DATA_DIR', previousDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex overlay cleanup and legacy repair keep recorded rollouts resumable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-overlay-resume-'));
  const systemHome = path.join(root, 'system-codex-home');
  const dataDir = path.join(root, 'tessera-data');
  const rolloutRelative = path.join(
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T09-09-06-child-session.jsonl',
  );
  const accountRollout = path.join(systemHome, rolloutRelative);
  fs.mkdirSync(path.dirname(accountRollout), { recursive: true });
  fs.writeFileSync(accountRollout, 'fork rollout\n');

  const previousCodexHome = process.env.CODEX_HOME;
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  process.env.CODEX_HOME = systemHome;
  process.env.TESSERA_DATA_DIR = dataDir;

  try {
    const overlayDir = createCodexOverlay('session-parent-terminal');
    const recordedRollout = path.join(overlayDir, rolloutRelative);
    cleanupCodexOverlayForTerminal('session-parent-terminal');
    assert.equal(fs.readFileSync(recordedRollout, 'utf8'), 'fork rollout\n');
    assert.deepEqual(fs.readdirSync(overlayDir), ['sessions']);

    fs.rmSync(overlayDir, { recursive: true, force: true });
    repairCodexOverlayResumePath(recordedRollout);
    assert.equal(fs.readFileSync(recordedRollout, 'utf8'), 'fork rollout\n');
  } finally {
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('TESSERA_DATA_DIR', previousDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex overlay cleanup promotes only user trust decisions to the account config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-overlay-promotion-'));
  const systemHome = path.join(root, 'system-codex-home');
  const dataDir = path.join(root, 'tessera-data');
  fs.mkdirSync(systemHome, { recursive: true });
  fs.writeFileSync(path.join(systemHome, 'config.toml'), 'model = "gpt-5.4"\n');

  const previousCodexHome = process.env.CODEX_HOME;
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  process.env.CODEX_HOME = systemHome;
  process.env.TESSERA_DATA_DIR = dataDir;

  try {
    const overlayDir = createCodexOverlay('terminal-promotion-test');
    const overlayConfigPath = path.join(overlayDir, 'config.toml');
    const overlayHooksPath = fs.realpathSync.native(path.join(overlayDir, 'hooks.json'));
    fs.writeFileSync(
      overlayConfigPath,
      fs.readFileSync(overlayConfigPath, 'utf8').replace(
        'model = "gpt-5.4"',
        'model = "gpt-5.9-should-not-promote"',
      ),
    );
    fs.appendFileSync(
      overlayConfigPath,
      [
        '',
        '[projects."/tmp/new-project"]',
        'trust_level = "trusted"',
        '',
        '[hooks.state."/tmp/new-project/.codex/hooks.json:pre_tool_use:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:approved-project-hook"',
        '',
      ].join('\n'),
    );

    cleanupCodexOverlayForTerminal('terminal-promotion-test');

    const systemConfig = fs.readFileSync(path.join(systemHome, 'config.toml'), 'utf8');
    assert.match(systemConfig, /^model = "gpt-5\.4"$/m);
    assert.doesNotMatch(systemConfig, /gpt-5\.9-should-not-promote/);
    assert.match(systemConfig, /^\[projects\."\/tmp\/new-project"\]$/m);
    assert.match(systemConfig, /^trust_level = "trusted"$/m);
    assert.match(systemConfig, /approved-project-hook/);
    assert.doesNotMatch(systemConfig, new RegExp(escapeRegExp(overlayHooksPath)));
  } finally {
    cleanupCodexOverlayForTerminal('terminal-promotion-test');
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('TESSERA_DATA_DIR', previousDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a running Codex overlay promotes trust without waiting for cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-overlay-watched-trust-'));
  const systemHome = path.join(root, 'system-codex-home');
  const dataDir = path.join(root, 'tessera-data');
  fs.mkdirSync(systemHome, { recursive: true });
  const accountConfigPath = path.join(systemHome, 'config.toml');
  fs.writeFileSync(accountConfigPath, 'model = "gpt-5.4"\n');

  const previousCodexHome = process.env.CODEX_HOME;
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  process.env.CODEX_HOME = systemHome;
  process.env.TESSERA_DATA_DIR = dataDir;

  try {
    const overlayDir = createCodexOverlay('terminal-watched-trust');
    const overlayConfigPath = path.join(overlayDir, 'config.toml');
    fs.appendFileSync(
      overlayConfigPath,
      [
        '',
        '[projects."/tmp/watched-project"]',
        'trust_level = "trusted"',
        '',
        '[hooks.state."/tmp/watched-project/.codex/hooks.json:pre_tool_use:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:watched-project-hook"',
        '',
      ].join('\n'),
    );

    await waitForFileMatch(accountConfigPath, /\/tmp\/watched-project/);

    let accountConfig = fs.readFileSync(accountConfigPath, 'utf8');
    assert.match(accountConfig, /^trust_level = "trusted"$/m);
    assert.doesNotMatch(accountConfig, /watched-project-hook/);
    fs.writeFileSync(
      overlayConfigPath,
      fs.readFileSync(overlayConfigPath, 'utf8')
        .replace('trust_level = "trusted"', 'trust_level = "untrusted"'),
    );

    await waitForFileMatch(accountConfigPath, /^trust_level = "untrusted"$/m);

    assert.equal(
      fs.existsSync(overlayConfigPath),
      true,
      'promotion must not require stopping the terminal',
    );
    cleanupCodexOverlayForTerminal('terminal-watched-trust');
    accountConfig = fs.readFileSync(accountConfigPath, 'utf8');
    assert.match(accountConfig, /watched-project-hook/);
  } finally {
    cleanupCodexOverlayForTerminal('terminal-watched-trust');
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('TESSERA_DATA_DIR', previousDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new Codex overlay inherits trust accepted by a still-running terminal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-overlay-live-trust-'));
  const systemHome = path.join(root, 'system-codex-home');
  const dataDir = path.join(root, 'tessera-data');
  fs.mkdirSync(systemHome, { recursive: true });
  fs.writeFileSync(path.join(systemHome, 'config.toml'), 'model = "gpt-5.4"\n');

  const previousCodexHome = process.env.CODEX_HOME;
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  process.env.CODEX_HOME = systemHome;
  process.env.TESSERA_DATA_DIR = dataDir;

  try {
    const firstOverlay = createCodexOverlay('terminal-live-trust-first');
    const firstConfigPath = path.join(firstOverlay, 'config.toml');
    fs.writeFileSync(
      firstConfigPath,
      fs.readFileSync(firstConfigPath, 'utf8')
        .replace('model = "gpt-5.4"', 'model = "gpt-5.9-overlay-only"')
        .concat('\n[projects."/tmp/live-project"]\ntrust_level = "trusted"\n'),
    );

    const secondOverlay = createCodexOverlay('terminal-live-trust-second');
    const secondConfig = fs.readFileSync(path.join(secondOverlay, 'config.toml'), 'utf8');

    assert.match(secondConfig, /^model = "gpt-5\.4"$/m);
    assert.doesNotMatch(secondConfig, /gpt-5\.9-overlay-only/);
    assert.match(secondConfig, /^\[projects\."\/tmp\/live-project"\]$/m);
    assert.match(secondConfig, /^trust_level = "trusted"$/m);
    assert.equal(fs.existsSync(firstConfigPath), true, 'the accepting terminal stays alive');
  } finally {
    cleanupCodexOverlayForTerminal('terminal-live-trust-first');
    cleanupCodexOverlayForTerminal('terminal-live-trust-second');
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('TESSERA_DATA_DIR', previousDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex trust promotion preserves a symlinked account config', (t) => {
  if (process.platform === 'win32') {
    t.skip('file symlinks require optional Windows privileges');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-overlay-symlink-'));
  const systemHome = path.join(root, 'system-codex-home');
  const dataDir = path.join(root, 'tessera-data');
  const sharedConfig = path.join(root, 'shared-config.toml');
  fs.mkdirSync(systemHome, { recursive: true });
  fs.writeFileSync(sharedConfig, 'model = "gpt-5.4"\n');
  fs.symlinkSync(sharedConfig, path.join(systemHome, 'config.toml'));

  const previousCodexHome = process.env.CODEX_HOME;
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  process.env.CODEX_HOME = systemHome;
  process.env.TESSERA_DATA_DIR = dataDir;

  try {
    const overlayDir = createCodexOverlay('terminal-symlink-test');
    fs.appendFileSync(
      path.join(overlayDir, 'config.toml'),
      '\n[projects."/tmp/symlink-project"]\ntrust_level = "trusted"\n',
    );

    cleanupCodexOverlayForTerminal('terminal-symlink-test');

    assert.equal(fs.lstatSync(path.join(systemHome, 'config.toml')).isSymbolicLink(), true);
    assert.match(fs.readFileSync(sharedConfig, 'utf8'), /\/tmp\/symlink-project/);
  } finally {
    cleanupCodexOverlayForTerminal('terminal-symlink-test');
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('TESSERA_DATA_DIR', previousDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitForFileMatch(filePath: string, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (pattern.test(fs.readFileSync(filePath, 'utf8'))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${filePath} to match ${pattern}`);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
