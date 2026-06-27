import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVersion } from '../src/lib/cli/cli-exec';
import type { ExecResult } from '../src/lib/cli/cli-exec';
import {
  classifyVersionFailure,
  isVersionProbeRunnable,
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

test('isVersionProbeRunnable: success is runnable', () => {
  assert.equal(
    isVersionProbeRunnable(execResult({ ok: true, exitCode: 0 })),
    true,
  );
});

test('isVersionProbeRunnable: timeout counts as runnable', () => {
  // Slow boot (opencode is ~2s) shouldn't be read as missing.
  assert.equal(
    isVersionProbeRunnable(execResult({ exitCode: null, timedOut: true })),
    true,
  );
});

test('isVersionProbeRunnable: non-zero exit counts as runnable', () => {
  // The binary ran — printing usage to stderr and exiting 1 still proves install.
  assert.equal(
    isVersionProbeRunnable(execResult({ exitCode: 1 })),
    true,
  );
});

test('isVersionProbeRunnable: ENOENT is not runnable', () => {
  assert.equal(
    isVersionProbeRunnable(execResult({ exitCode: null, spawnErrorCode: 'ENOENT' })),
    false,
  );
});

test('isVersionProbeRunnable: ENOEXEC is not runnable', () => {
  assert.equal(
    isVersionProbeRunnable(execResult({ exitCode: null, spawnErrorCode: 'ENOEXEC' })),
    false,
  );
});

test('isVersionProbeRunnable: EACCES is not runnable', () => {
  assert.equal(
    isVersionProbeRunnable(execResult({ exitCode: null, spawnErrorCode: 'EACCES' })),
    false,
  );
});

test('classifyVersionFailure: ENOEXEC maps to binary_missing', () => {
  assert.equal(
    classifyVersionFailure(execResult({ spawnErrorCode: 'ENOEXEC' }), 'default'),
    'binary_missing',
  );
});

test('classifyVersionFailure: spawn-error wins over timeout', () => {
  // A timed-out ENOENT is still a missing binary, not a slow one.
  assert.equal(
    classifyVersionFailure(
      execResult({ spawnErrorCode: 'ENOENT', timedOut: true }),
      'default',
    ),
    'binary_missing',
  );
});

test('parseVersion: extracts the three-part version', () => {
  assert.equal(parseVersion('Claude Code 2.1.114'), '2.1.114');
  assert.equal(parseVersion('codex-cli 0.42.0 (build 1234)'), '0.42.0');
});

test('parseVersion: does NOT overmatch a runtime number from a two-part fallback', () => {
  // Regression guard: a two-part fallback used to grab the wrong standalone
  // number from banner text. We now return undefined rather than a wrong value.
  assert.equal(parseVersion('codex-cli (node 18.20, build 0.46)'), undefined);
  assert.equal(parseVersion('weird output with no version'), undefined);
});
