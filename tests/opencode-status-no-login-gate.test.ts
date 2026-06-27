import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOpenCodeStatus } from '../src/lib/cli/status-detection';
import type { ExecResult } from '../src/lib/cli/cli-exec';

function execResult(overrides: Partial<ExecResult>): ExecResult {
  return {
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 0,
    ...overrides,
  };
}

test('OpenCode is connected as soon as the version probe succeeds', () => {
  const versionOk = execResult({ ok: true, exitCode: 0, stdout: '1.14.39' });

  const result = classifyOpenCodeStatus(versionOk, 'default');

  assert.equal(result.status, 'connected');
  assert.equal(result.detectionReason, 'connected');
});

test('OpenCode never reports needs_login when the binary runs', () => {
  // Regression: OpenCode needs no login (free zen models are always available),
  // yet a slow `opencode models` probe used to time out and surface a
  // misleading "needs_login". A runnable binary must read as connected.
  const versionOk = execResult({ ok: true, exitCode: 0, stdout: '1.14.39' });

  const result = classifyOpenCodeStatus(versionOk, 'default');

  assert.notEqual(result.status, 'needs_login');
});

test('OpenCode stays connected when the version probe merely times out', () => {
  // Regression on the original "needs_login" bug: a slow boot proves the binary
  // is installed. Treating timeout as "not installed" would re-introduce the
  // same false alarm one layer down.
  const versionTimeout = execResult({ ok: false, exitCode: null, timedOut: true });

  const result = classifyOpenCodeStatus(versionTimeout, 'default');

  assert.equal(result.status, 'connected');
  assert.equal(result.detectionReason, 'connected');
});

test('OpenCode stays connected when the version probe exits non-zero', () => {
  // CLIs that dump help-to-stderr and exit 1 are still installed.
  const versionNonzero = execResult({ ok: false, exitCode: 1 });

  const result = classifyOpenCodeStatus(versionNonzero, 'default');

  assert.equal(result.status, 'connected');
});

test('OpenCode is not_installed when the binary is missing', () => {
  const missing = execResult({ ok: false, exitCode: null, spawnErrorCode: 'ENOENT' });

  const result = classifyOpenCodeStatus(missing, 'default');

  assert.equal(result.status, 'not_installed');
  assert.equal(result.detectionReason, 'binary_missing');
});

test('OpenCode is not_installed when the binary is not executable', () => {
  const enoexec = execResult({ ok: false, exitCode: null, spawnErrorCode: 'ENOEXEC' });

  const result = classifyOpenCodeStatus(enoexec, 'default');

  assert.equal(result.status, 'not_installed');
  assert.equal(result.detectionReason, 'binary_missing');
});
