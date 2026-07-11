import assert from 'node:assert/strict';
import test from 'node:test';
import {
  setPendingTerminalLaunch,
  takePendingTerminalLaunch,
  type PendingTerminalLaunch,
} from '../src/lib/terminal/pending-terminal-launch';

test('requeueing a consumed launch resets its expiry timer', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const terminalId = 'requeued-terminal';
  const launch: PendingTerminalLaunch = {
    intent: { kind: 'codex-slash', commandInput: '/theme' },
    sourceSessionId: 'source-session',
  };

  setPendingTerminalLaunch(terminalId, launch);
  context.mock.timers.tick(30_000);
  assert.equal(takePendingTerminalLaunch(terminalId), launch);

  setPendingTerminalLaunch(terminalId, launch);
  context.mock.timers.tick(30_001);
  assert.equal(takePendingTerminalLaunch(terminalId), launch);
});
