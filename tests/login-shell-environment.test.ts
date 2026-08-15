import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SpawnCliCache } from '../src/lib/cli/spawn-cli-cache';
import { buildSpawnEnvironment } from '../src/lib/cli/spawn-cli-runtime';
import { getRuntimePlatform } from '../src/lib/system/runtime-platform';

// macOS/Linux never run the CLI through a shell — they read the login shell's
// environment once and spawn the CLI directly with it. So everything that can
// go wrong with a user's dotfiles has to be survivable *by the probe*, or the
// CLI silently launches with a PATH that doesn't match the user's terminal.
//
// This rc reproduces three problems at once, in the order they'd really occur:
// a banner on stdout, real environment worth keeping, and a line that kills a
// non-interactive shell outright (`.` is a POSIX special builtin, so sourcing
// a missing file exits 2 — a stale `. "$HOME/.cargo/env"` is the usual cause).
const BROKEN_RC = [
  'echo "PATH=/hijacked-by-banner"',
  'export ANTHROPIC_PROBE_MARKER=applied',
  '. "$HOME/.tessera-does-not-exist"',
  '',
].join('\n');
const RC_FILENAMES = ['.profile', '.bashrc', '.bash_profile', '.zshrc', '.zprofile'];

const SKIP_ON_WINDOWS = getRuntimePlatform() === 'win32';

function emptyCache(): SpawnCliCache {
  return {
    agentEnvironmentByUserId: new Map(),
    defaultAgentEnvironment: null,
    loginShell: null,
    didResolveLoginShell: false,
    loginShellEnvironment: null,
    didResolveLoginShellEnvironment: false,
  };
}

function withBrokenRcHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'tessera-login-rc-'));
  try {
    for (const filename of RC_FILENAMES) {
      writeFileSync(join(home, filename), BROKEN_RC);
    }
    run(home);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

test('login-shell probe survives a broken rc', { skip: SKIP_ON_WINDOWS }, () => {
  withBrokenRcHome((home) => {
    const env = buildSpawnEnvironment(
      { ...process.env, HOME: home, PATH: '/nowhere' },
      emptyCache(),
    );

    // The rc died partway through, and the shell may well have exited nonzero.
    // What it managed to export before that is still the user's real
    // environment — throwing it away is what strips nvm/homebrew off PATH.
    assert.equal(env.ANTHROPIC_PROBE_MARKER, 'applied');
    assert.ok((env.PATH ?? '').split(':').length > 1, `PATH not hydrated: ${env.PATH}`);
  });
});

test('login-shell probe ignores rc banner output', { skip: SKIP_ON_WINDOWS }, () => {
  withBrokenRcHome((home) => {
    const env = buildSpawnEnvironment(
      { ...process.env, HOME: home, PATH: '/nowhere' },
      emptyCache(),
    );

    // The rc printed a line that looks exactly like `env` output. Markers fence
    // the real dump off from anything the rc wrote before it.
    assert.ok(
      !(env.PATH ?? '').includes('/hijacked-by-banner'),
      `banner leaked into PATH: ${env.PATH}`,
    );
  });
});

test('login shell does not depend on $SHELL being set', { skip: SKIP_ON_WINDOWS }, () => {
  withBrokenRcHome((home) => {
    // A GUI launch (Finder, Dock, .desktop, systemd) hands the app a minimal
    // env where $SHELL is absent or stale. The passwd entry is the source of
    // truth — same thing the WSL bridge reads via `getent passwd`.
    const env = buildSpawnEnvironment(
      { ...process.env, HOME: home, PATH: '/nowhere', SHELL: '/nonexistent/shell' },
      emptyCache(),
    );

    assert.equal(env.ANTHROPIC_PROBE_MARKER, 'applied');
  });
});

test('probe result is cached across calls', { skip: SKIP_ON_WINDOWS }, () => {
  withBrokenRcHome((home) => {
    const cache = emptyCache();
    const baseEnv = { ...process.env, HOME: home, PATH: '/nowhere' };

    buildSpawnEnvironment(baseEnv, cache);
    assert.equal(cache.didResolveLoginShellEnvironment, true);

    // A second call must not spawn another shell: rc files routinely take
    // hundreds of ms, and this runs on every CLI spawn.
    const second = buildSpawnEnvironment({ ...baseEnv, HOME: '/nonexistent-home' }, cache);
    assert.equal(second.ANTHROPIC_PROBE_MARKER, 'applied');
  });
});
