import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecResult } from '../src/lib/cli/cli-exec';
import { classifyAuthStatus } from '../src/lib/cli/status-detection';

function execResult(overrides: Partial<ExecResult>): ExecResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 25,
    ...overrides,
  };
}

test('auth status keeps nonzero auth probe failures as needs_login', () => {
  assert.deepEqual(
    classifyAuthStatus(execResult({ exitCode: 1 })),
    {
      status: 'needs_login',
      detectionReason: 'auth_failed',
    },
  );
});

test('auth status maps timeout auth probe failures away from needs_login', () => {
  assert.deepEqual(
    classifyAuthStatus(execResult({ exitCode: null, timedOut: true })),
    {
      status: 'not_installed',
      detectionReason: 'auth_timeout',
    },
  );
});

test('auth status maps spawn-error auth probe failures away from needs_login', () => {
  assert.deepEqual(
    classifyAuthStatus(execResult({ exitCode: null, spawnErrorCode: 'ENOENT' })),
    {
      status: 'not_installed',
      detectionReason: 'auth_failed',
    },
  );
});

test('auth status maps unknown auth probe failures away from needs_login', () => {
  assert.deepEqual(
    classifyAuthStatus(execResult({ exitCode: null })),
    {
      status: 'not_installed',
      detectionReason: 'auth_failed',
    },
  );
});

test('auth status preserves connected probes', () => {
  assert.deepEqual(
    classifyAuthStatus(execResult({ ok: true, exitCode: 0 })),
    {
      status: 'connected',
      detectionReason: 'connected',
    },
  );
});
