import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecResult } from '../src/lib/cli/cli-exec';
import {
  classifyAuthStatus,
  synthesizeRunnableStatus,
} from '../src/lib/cli/status-detection';

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

test('version-ok + auth-ok → connected', () => {
  const result = synthesizeRunnableStatus(
    execResult({ ok: true, exitCode: 0 }),
    classifyAuthStatus(execResult({ ok: true, exitCode: 0 })),
  );
  assert.equal(result.status, 'connected');
  assert.equal(result.detectionReason, 'connected');
});

test('version-runnable (timeout) + auth-timeout → connected (no false not_installed)', () => {
  // The exact regression the user hit: Claude Code on a slow machine, both
  // probes time out, status flipped to not_installed even though the binary
  // is installed.
  const result = synthesizeRunnableStatus(
    execResult({ ok: false, exitCode: null, timedOut: true }),
    classifyAuthStatus(execResult({ ok: false, exitCode: null, timedOut: true })),
  );
  assert.equal(result.status, 'connected');
  assert.equal(result.detectionReason, 'auth_timeout');
});

test('version-ok + auth-timeout → connected (preserves auth_timeout reason)', () => {
  const result = synthesizeRunnableStatus(
    execResult({ ok: true, exitCode: 0 }),
    classifyAuthStatus(execResult({ ok: false, exitCode: null, timedOut: true })),
  );
  assert.equal(result.status, 'connected');
  assert.equal(result.detectionReason, 'auth_timeout');
});

test('version-runnable (non-zero exit) + auth-needs_login (non-zero exit) → needs_login', () => {
  // Non-zero exit from auth is a clear "binary says not authed" signal; we
  // should propagate it, not paper over with connected.
  const result = synthesizeRunnableStatus(
    execResult({ ok: false, exitCode: 1 }),
    classifyAuthStatus(execResult({ ok: false, exitCode: 1 })),
  );
  assert.equal(result.status, 'needs_login');
});

test('version-not-runnable (ENOENT) → auth verdict propagates unchanged', () => {
  // When the binary is genuinely missing, do not paper over: the auth verdict
  // (also typically a spawn error) flows through as-is.
  const authVerdict = classifyAuthStatus(execResult({ ok: false, exitCode: null, spawnErrorCode: 'ENOENT' }));
  const result = synthesizeRunnableStatus(
    execResult({ ok: false, exitCode: null, spawnErrorCode: 'ENOENT' }),
    authVerdict,
  );
  assert.equal(result.status, 'not_installed');
});

test('version-runnable + auth spawn-error → connected (the binary launched, auth couldn’t)', () => {
  // E.g. corrupt auth subcommand wrapper but the main binary runs.
  const result = synthesizeRunnableStatus(
    execResult({ ok: true, exitCode: 0 }),
    classifyAuthStatus(execResult({ ok: false, exitCode: null, spawnErrorCode: 'ENOENT' })),
  );
  assert.equal(result.status, 'connected');
});
