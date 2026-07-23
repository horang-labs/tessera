import assert from 'node:assert/strict';
import test from 'node:test';
import { createActiveSessionRuntimeController } from '@/lib/session/active-session-runtime-controller';

test('session runtime retirement closes GUI and PTY backends independently', async () => {
  const calls: string[] = [];
  const runtime = createActiveSessionRuntimeController({
    getGuiSessionIds: () => new Set(['gui-session']),
    getPtySessionIds: () => new Set(['pty-session']),
    closeGuiSession: async (sessionId) => {
      calls.push(`gui:${sessionId}`);
      throw new Error('GUI close failed');
    },
    closePtySession: async (sessionId, userId) => {
      calls.push(`pty:${userId}:${sessionId}`);
    },
  });

  const failures = await runtime.closeSession('session-a', 'user-a');

  assert.deepEqual(calls, ['gui:session-a', 'pty:user-a:session-a']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.runtime, 'gui');
  assert.match(String(failures[0]?.error), /GUI close failed/);
});

test('active session ids include GUI and PTY runtimes', () => {
  const runtime = createActiveSessionRuntimeController({
    getGuiSessionIds: () => new Set(['gui-session', 'shared-session']),
    getPtySessionIds: () => new Set(['pty-session', 'shared-session']),
    closeGuiSession: async () => {},
    closePtySession: async () => {},
  });

  assert.deepEqual(
    [...runtime.getActiveSessionIds('user-a')].sort(),
    ['gui-session', 'pty-session', 'shared-session'],
  );
});

test('runtime retirement still closes GUI when no PTY owner is available', async () => {
  const calls: string[] = [];
  const runtime = createActiveSessionRuntimeController({
    getGuiSessionIds: () => new Set(),
    getPtySessionIds: () => new Set(),
    closeGuiSession: async (sessionId) => {
      calls.push(`gui:${sessionId}`);
    },
    closePtySession: async (sessionId, userId) => {
      calls.push(`pty:${userId}:${sessionId}`);
    },
  });

  await runtime.closeSession('session-a');

  assert.deepEqual(calls, ['gui:session-a']);
});
