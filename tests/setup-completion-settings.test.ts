import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSetupCompletionSettings,
  isSetupCompletionPersisted,
} from '@/lib/setup/setup-completion';

const setup = {
  completedAt: null,
  dismissedAt: null,
};

test('setup completion saves the chosen execution mode with the ready timestamp', () => {
  const partial = buildSetupCompletionSettings({
    setup,
    agentExecutionMode: 'gui',
    isFullyReady: true,
    now: '2026-07-20T12:00:00.000Z',
  });

  assert.deepEqual(partial, {
    agentExecutionMode: 'gui',
    setup: {
      completedAt: '2026-07-20T12:00:00.000Z',
      dismissedAt: null,
    },
  });
});

test('limited setup saves the chosen execution mode with the dismissed timestamp', () => {
  const partial = buildSetupCompletionSettings({
    setup,
    agentExecutionMode: 'pty',
    isFullyReady: false,
    now: '2026-07-20T12:00:00.000Z',
  });

  assert.deepEqual(partial, {
    agentExecutionMode: 'pty',
    setup: {
      completedAt: null,
      dismissedAt: '2026-07-20T12:00:00.000Z',
    },
  });
});

test('setup completion is persisted only when both the mode and timestamp match', () => {
  const expected = buildSetupCompletionSettings({
    setup,
    agentExecutionMode: 'gui',
    isFullyReady: true,
    now: '2026-07-20T12:00:00.000Z',
  });

  assert.equal(isSetupCompletionPersisted(expected, expected), true);
  assert.equal(isSetupCompletionPersisted({ ...expected, agentExecutionMode: 'pty' }, expected), false);
  assert.equal(isSetupCompletionPersisted({ ...expected, setup }, expected), false);
});
