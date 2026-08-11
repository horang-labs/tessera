import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecResult } from '@/lib/cli/cli-exec';
import { buildCodexAppServerRequestEnvironment } from '@/lib/cli/providers/codex/app-server-request-client';
import { resolveCodexHomeForEnvironment } from '@/lib/cli/providers/codex/provider-home';

function success(stdout: string): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
    durationMs: 1,
  };
}

test('Windows backend resolves only the WSL Codex home for a WSL agent', async () => {
  const calls: Array<{ command: string; environment: string }> = [];
  const home = await resolveCodexHomeForEnvironment('wsl', {
    runtimePlatform: () => 'win32',
    runningInWsl: () => false,
    exec: async (command, _args, environment) => {
      calls.push({ command, environment });
      return success('\\\\wsl.localhost\\Ubuntu-24.04\\home\\owner\\.codex\n');
    },
  });

  assert.equal(home, '\\\\wsl.localhost\\Ubuntu-24.04\\home\\owner\\.codex');
  assert.deepEqual(calls, [{ command: 'sh', environment: 'wsl' }]);
});

test('a failed bridged WSL probe fails closed without using an opposite home', async () => {
  await assert.rejects(
    resolveCodexHomeForEnvironment('wsl', {
      runtimePlatform: () => 'win32',
      runningInWsl: () => false,
      exec: async () => ({ ...success(''), ok: false, exitCode: 1 }),
    }),
    /WSL Codex home could not be resolved/,
  );
});

test('a failed shared-filesystem probe does not guess past a custom login-shell home', async () => {
  await assert.rejects(
    resolveCodexHomeForEnvironment('native', {
      runtimePlatform: () => 'linux',
      runningInWsl: () => false,
      exec: async () => ({ ...success(''), ok: false, exitCode: 1 }),
    }),
    /Codex home could not be resolved/,
  );
});

test('WSL backend resolves a native Windows Codex home through the native agent only', async () => {
  const calls: Array<{ command: string; environment: string }> = [];
  const home = await resolveCodexHomeForEnvironment('native', {
    runtimePlatform: () => 'linux',
    runningInWsl: () => true,
    exec: async (command, _args, environment) => {
      calls.push({ command, environment });
      return success('C:\\Users\\owner\\.codex\r\n');
    },
  });

  assert.equal(home, '/mnt/c/Users/owner/.codex');
  assert.deepEqual(calls, [{ command: 'powershell.exe', environment: 'native' }]);
});

test('the trust API process is pinned to the same authoritative native home', () => {
  const env = buildCodexAppServerRequestEnvironment(
    { CODEX_HOME: '/home/server/.codex', HOME: '/home/server' },
    'native',
    '/mnt/c/Users/owner/.codex',
    {
      formatProviderHome: () => 'C:\\Users\\owner\\.codex',
      isBridged: () => true,
    },
  );

  assert.equal(env.CODEX_HOME, 'C:\\Users\\owner\\.codex');
  assert.notEqual(env.CODEX_HOME, '/home/server/.codex');
});

test('a Windows-to-WSL trust process exports the already translated WSL home without path rewriting', () => {
  const env = buildCodexAppServerRequestEnvironment(
    { CODEX_HOME: 'C:\\Users\\server\\.codex', WSLENV: 'HTTPS_PROXY' },
    'wsl',
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\owner\\.codex',
    {
      formatProviderHome: () => '/home/owner/.codex',
      isBridged: () => true,
    },
  );

  assert.equal(env.CODEX_HOME, '/home/owner/.codex');
  assert.deepEqual(env.WSLENV?.split(':'), ['HTTPS_PROXY', 'CODEX_HOME']);
  assert.doesNotMatch(env.WSLENV ?? '', /CODEX_HOME\/p/);
});
