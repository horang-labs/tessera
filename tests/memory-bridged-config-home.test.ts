import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { buildWslFilesystemPathProbe } from '../src/lib/filesystem/wsl-path-probe';
import { isRunningInWsl } from '../src/lib/cli/cli-exec';

// ── Why this file exists ─────────────────────────────────────────────────────
//
// The Context panel resolves each CLI's config home by probing the agent's side
// of the bridge, then hands the answer straight to `fs.stat`. codex and opencode
// printed the raw WSL path (`/home/u/.codex`), which a Windows host cannot open:
// every instruction file read as missing and the panel showed "No user
// instructions" beside a home that had AGENTS.md in it. Only claude translated,
// which is why the same panel got CLAUDE.md right in the same session.
//
// Project scope was never affected — it goes through
// `resolvePathForHostFilesystem()` — so the bug looked provider-specific when it
// was really "one of two path sources forgot to translate".

const sources = {
  claude: fs.readFileSync(new URL('../src/lib/skill/skill-loader.ts', import.meta.url), 'utf8'),
  codex: fs.readFileSync(new URL('../src/lib/memory/codex-memory.ts', import.meta.url), 'utf8'),
  opencode: fs.readFileSync(new URL('../src/lib/memory/opencode-memory.ts', import.meta.url), 'utf8'),
};

// ── Behavioural: the probe really translates, under a real shell ─────────────

test('probe returns a host-openable path for a WSL home', () => {
  const script = buildWslFilesystemPathProbe('$HOME/.codex');
  const stdout = execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim();

  if (isRunningInWsl()) {
    // The whole point: a Windows host must receive a path IT can stat. Both UNC
    // (`\\wsl.localhost\...`) and a drive letter (a home on /mnt/c) qualify.
    assert.match(stdout, /^(\\\\|[A-Za-z]:\\)/,
      `expected a Windows-style path from wslpath, got ${stdout}`);
    assert.doesNotMatch(stdout, /^\//,
      'a bare POSIX path is exactly the bug: Windows cannot open it');
  } else {
    // No wslpath outside WSL — the `||` must still yield the untranslated path
    // rather than an empty string, so non-bridged hosts behave as before.
    assert.equal(stdout, `${process.env.HOME}/.codex`);
  }
});

test('probe preserves the ${CODEX_HOME} default-expansion form', () => {
  const script = buildWslFilesystemPathProbe('${CODEX_HOME:-$HOME/.codex}');
  const withOverride = execFileSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: '/tmp/probe-codex-home' },
  }).trim();
  const withoutOverride = execFileSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: '' },
  }).trim();

  assert.notEqual(withOverride, withoutOverride,
    'an exported $CODEX_HOME must still win — the panel must agree with the CLI');
  assert.match(withOverride, /probe-codex-home$/);
});

test('probe survives a path containing spaces', () => {
  const script = buildWslFilesystemPathProbe('${PROBE_DIR}');
  const stdout = execFileSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PROBE_DIR: '/tmp/dir with spaces/.codex' },
  }).trim();

  assert.match(stdout, /dir with spaces/, 'the path must not be word-split');
});

// ── Contract: every config-home probe goes through the translating helper ────

for (const [provider, source] of Object.entries(sources)) {
  test(`${provider} config-home probe translates for the host filesystem`, () => {
    assert.match(source, /buildWslFilesystemPathProbe\(/,
      `${provider} must use the shared probe builder, not a raw printf`);
    // The old form. Its output is stat-ed by the server, so it must not return.
    assert.doesNotMatch(source, /printf "%s" "\$\{?(HOME|CODEX_HOME)/,
      `${provider} still prints an untranslated WSL path to the host`);
  });
}

// ── Contract: server-side env vars are dropped across a bridge ───────────────
//
// CLAUDE_CONFIG_DIR / CODEX_HOME describe the environment the *server* runs in.
// The CLI on the other side of a bridge never saw them, so trusting them points
// the panel at a directory the agent does not read.

test('codex drops CODEX_HOME across a bridge', () => {
  assert.match(sources.codex,
    /isBridgedAgentEnvironment\(environment\)[\s\S]{0,80}process\.env\.CODEX_HOME/);
});

test('claude drops CLAUDE_CONFIG_DIR across a bridge', () => {
  assert.match(sources.claude,
    /isBridgedAgentEnvironment\(environment\)[\s\S]{0,80}process\.env\.CLAUDE_CONFIG_DIR/);
});

// ── Contract: the probe-failed fallback stays on the agent's side ────────────

for (const provider of ['codex', 'opencode'] as const) {
  test(`${provider} falls back to the agent's home, not the server's`, () => {
    assert.match(sources[provider], /resolveAgentHomeFilesystemPath\(environment\)/);
    assert.doesNotMatch(sources[provider], /path\.join\(homedir\(\)/,
      'homedir() is the wrong side of the bridge');
  });
}
