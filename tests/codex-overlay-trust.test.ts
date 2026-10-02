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
// Observer-enriched POSIX command; independently verified with Python hashlib against
// Codex ff6aec96 hook_hash/version_for_toml. Keep literal goldens, never call the production hasher.
const EXPECTED_TRUSTED_HASHES = {
  session_start: 'sha256:161197e323c5727946d52958ed240724481238617c66a5caa965f311f8cce0d8',
  user_prompt_submit: 'sha256:0fc8cc99f77dcd9cb1cfc3e42fb6a8fa920423ed9d94a181bbe66c67c7987c6d',
  pre_tool_use: 'sha256:1e39f2e45da784609e8de951a6ed8fe586b378e2d6984bbfbfee2935276e7578',
  permission_request: 'sha256:cd862667ce33f61b154579fa91825d7f5a2fc51e52688cf146f99ed9d7cfa895',
  post_tool_use: 'sha256:de5db1aee7c1969fad6a6b85ca3b932b023277af4347d18df26f8a19c3308d69',
  stop: 'sha256:3eab19fa62fc1ff30a84d507ab6d5495557b5af0cc3161ae3d482e6d3a1e388c',
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
