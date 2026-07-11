import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CodexThreadControlError,
  deleteCodexThread,
  forkCodexThread,
  renameCodexThread,
  setCodexThreadArchived,
  setCodexThreadControlRequestExecutorForTests,
} from '../src/lib/cli/providers/codex/thread-control-client';

test.afterEach(() => {
  setCodexThreadControlRequestExecutorForTests(null);
});

test('stable lifecycle helpers emit exact app-server methods and params', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  setCodexThreadControlRequestExecutorForTests(async (_context, method, params) => {
    calls.push({ method, params });
    if (method === 'thread/fork') {
      return {
        thread: { id: 'thread-child', forkedFromId: 'thread-source' },
        model: 'gpt-5.4',
        reasoningEffort: 'high',
        serviceTier: 'fast',
      };
    }
    return {};
  });

  const fork = await forkCodexThread({ userId: 'user-1', workDir: '/tmp' }, 'thread-source');
  assert.equal(fork.threadId, 'thread-child');
  assert.equal(fork.model, 'gpt-5.4');
  assert.equal(fork.reasoningEffort, 'high');
  assert.equal(fork.serviceTier, 'fast');
  await renameCodexThread({}, 'thread-child', 'Renamed');
  await setCodexThreadArchived({}, 'thread-child', true);
  await setCodexThreadArchived({}, 'thread-child', false);
  await deleteCodexThread({}, 'thread-child');

  assert.deepEqual(calls, [
    { method: 'thread/fork', params: { threadId: 'thread-source' } },
    { method: 'thread/name/set', params: { threadId: 'thread-child', name: 'Renamed' } },
    { method: 'thread/archive', params: { threadId: 'thread-child' } },
    { method: 'thread/unarchive', params: { threadId: 'thread-child' } },
    { method: 'thread/delete', params: { threadId: 'thread-child' } },
  ]);
});

test('fork rejects invalid identity and never accepts the source as its child', async () => {
  setCodexThreadControlRequestExecutorForTests(async () => ({
    thread: { id: 'thread-source', forkedFromId: 'thread-source' },
  }));
  await assert.rejects(
    forkCodexThread({}, 'thread-source'),
    /source thread as the fork result/,
  );

  setCodexThreadControlRequestExecutorForTests(async () => ({ thread: { id: '../bad' } }));
  await assert.rejects(forkCodexThread({}, 'thread-source'), /invalid forked thread ID/);
});

test('delete treats an already absent Codex thread as idempotent success', async () => {
  setCodexThreadControlRequestExecutorForTests(async () => {
    throw new CodexThreadControlError('Thread not found', -32000);
  });
  await assert.doesNotReject(deleteCodexThread({}, 'thread-gone'));
});
