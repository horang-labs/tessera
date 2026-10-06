import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  POSIX_SCRIPT_ENV,
  buildPosixScriptInvocation,
  isPosixShell,
} from '@/lib/terminal/posix-script-shell';
import { resolveTerminalShell } from '@/lib/terminal/terminal-resolver';

const skip = process.platform === 'win32';

// Stands in for fish when fish is not installed: refuses the POSIX constructs
// the probe and launch wrapper use (fish exits 127 on them), runs anything else.
const NON_POSIX_SHELL = [
  '#!/bin/sh',
  'while [ $# -gt 0 ] && [ "$1" != "-c" ]; do shift; done',
  'shift',
  'case "$1" in',
  `  *'$('*|*'\${'*|*'if ['*|*' then '*) echo "fake-fish: unsupported syntax" >&2; exit 127 ;;`,
  'esac',
  'eval "$1"',
  '',
].join('\n');

function findRealFish(): string | null {
  try {
    return execFileSync('sh', ['-c', 'command -v fish'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function makeFixture(): { root: string; fakeFish: string; binDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-posix-script-shell-'));
  const fakeFish = path.join(root, 'fish');
  fs.writeFileSync(fakeFish, NON_POSIX_SHELL, { mode: 0o700 });
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return { root, fakeFish, binDir };
}

test('POSIX shells get the script directly; others get the /bin/sh handoff', () => {
  for (const shell of ['/bin/sh', '/usr/bin/bash', '/bin/zsh', '/usr/bin/dash', '/bin/BASH']) {
    assert.equal(isPosixShell(shell), true, shell);
    assert.deepEqual(buildPosixScriptInvocation(shell, ['-l'], 'echo hi'), {
      args: ['-l', '-c', 'echo hi'],
    });
  }

  for (const shell of ['/usr/bin/fish', '/opt/homebrew/bin/nu', '/bin/tcsh']) {
    assert.equal(isPosixShell(shell), false, shell);
    const invocation = buildPosixScriptInvocation(shell, ['-l'], 'echo hi');
    assert.deepEqual(invocation.args, ['-l', '-c', `exec /bin/sh -c 'eval "$${POSIX_SCRIPT_ENV}"'`]);
    assert.equal(invocation.env?.[POSIX_SCRIPT_ENV], `unset ${POSIX_SCRIPT_ENV}; echo hi`);
  }
});

test('provider probe succeeds under a shell that rejects POSIX syntax', { skip }, async () => {
  const { root, fakeFish, binDir } = makeFixture();
  const originalShell = process.env.SHELL;
  const originalPath = process.env.PATH;
  try {
    const detection = await import('@/lib/terminal/provider-detection');
    detection.invalidateTerminalProviderDetection();
    process.env.SHELL = fakeFish;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    const results = await detection.detectTerminalProviders({ force: true, environment: 'native' });
    const claude = results.find((result) => result.providerId === 'claude-code');
    assert.equal(claude?.installed, true);
    assert.equal(claude?.resolvedPath, path.join(binDir, 'claude'));
  } finally {
    process.env.SHELL = originalShell;
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runResolvedLaunch(shellPath: string, cwd: string): { status: number | null; stdout: string } {
  const resolved = resolveTerminalShell({
    cwd,
    platform: 'linux',
    env: { SHELL: shellPath },
    launchSpec: {
      program: 'sh',
      args: ['-c', `printf '%s|%s\\n' "$1" "\${${POSIX_SCRIPT_ENV}-unset}"; exit 7`, 'sh', "it's \\ $HOME"],
    },
  });
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: resolved.cwd,
    env: { ...process.env, TESSERA_CODEX_HOME: '', TESSERA_OPENCODE_CONFIG_DIR: '', ...resolved.env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout };
}

test('PTY launch wrapper runs under a shell that rejects POSIX syntax', { skip }, () => {
  const { root, fakeFish } = makeFixture();
  try {
    const { status, stdout } = runResolvedLaunch(fakeFish, root);
    // Arguments arrive verbatim, the handoff variable does not leak into the
    // launched program, and its exit code comes back.
    assert.equal(stdout, "it's \\ $HOME|unset\n");
    assert.equal(status, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const realFish = skip ? null : findRealFish();

test('real fish: probe finds CLIs on a PATH set in config.fish, launch wrapper runs', {
  skip: realFish ? false : 'fish is not installed',
}, async () => {
  const { root, binDir } = makeFixture();
  const configDir = path.join(root, 'config');
  fs.mkdirSync(path.join(configDir, 'fish'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'fish', 'config.fish'),
    `set -gx PATH ${binDir} $PATH\necho 'rc noise on stdout'\n`,
  );
  const saved = {
    SHELL: process.env.SHELL,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  try {
    process.env.SHELL = realFish!;
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.XDG_DATA_HOME = path.join(root, 'data');

    const detection = await import('@/lib/terminal/provider-detection');
    detection.invalidateTerminalProviderDetection();
    const results = await detection.detectTerminalProviders({ force: true, environment: 'native' });
    assert.equal(
      results.find((result) => result.providerId === 'claude-code')?.resolvedPath,
      path.join(binDir, 'claude'),
    );

    const { status, stdout } = runResolvedLaunch(realFish!, root);
    assert.equal(stdout.split('\n').filter((line) => line.includes('|')).join('\n'), "it's \\ $HOME|unset");
    assert.equal(status, 7);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
