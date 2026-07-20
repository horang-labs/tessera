import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveSessionRuntimePresentation,
} from '@/lib/session/session-runtime-presentation';

test('PTY runtime exposes the green running state and stop action', () => {
  assert.deepEqual(resolveSessionRuntimePresentation({
    kind: 'terminal',
    isRunning: true,
  }), {
    showRunning: true,
    canStop: true,
  });
});

test('GUI runtime keeps its existing green running state and stop action', () => {
  assert.deepEqual(resolveSessionRuntimePresentation({
    kind: 'chat',
    isRunning: true,
  }), {
    showRunning: true,
    canStop: true,
  });
});

test('stopped sessions expose neither a running state nor a stop action', () => {
  for (const kind of ['chat', 'terminal'] as const) {
    assert.deepEqual(resolveSessionRuntimePresentation({ kind, isRunning: false }), {
      showRunning: false,
      canStop: false,
    });
  }
});
