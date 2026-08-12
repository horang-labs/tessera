import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalControlSessionObserver } from '../src/lib/control/session-observer';
import { ControlOperationError } from '../src/lib/control/service';
import { TerminalManager } from '../src/lib/terminal/terminal-manager';

test('Control Session observation maps terminal wait timeouts to the stable Control error', async () => {
  const manager = new TerminalManager(() => {});
  const observer = createTerminalControlSessionObserver({
    userId: 'control-user',
    manager,
  });

  assert.equal((await observer.read('durable-session')).runtimeState, 'exited');
  await assert.rejects(
    observer.wait('durable-session', 'running', 10),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'WAIT_TIMEOUT'
      && error.httpStatus === 408
      && error.details.sessionId === 'durable-session'
      && error.details.condition === 'running'
      && error.details.timeoutSeconds === 0.01,
  );
});

test('Control Session observation reports degraded integration health without changing runtime state', async () => {
  const runningSnapshot = {
    screen: 'still running',
    cols: 80,
    rows: 24,
    alternateScreen: false,
    outputSequence: 3,
    terminalId: 'terminal-a',
    runtimeState: 'running' as const,
    stateAt: 123,
  };
  const observer = createTerminalControlSessionObserver({
    userId: 'control-user',
    manager: {
      readSessionSnapshot: async () => runningSnapshot,
      waitForSessionState: async () => runningSnapshot,
    },
    readIntegrationHealth: () => 'degraded',
  });

  const snapshot = await observer.read('active-degraded-session');
  assert.equal(snapshot.runtimeState, 'running');
  assert.equal(snapshot.screen, 'still running');
  assert.equal(snapshot.integrationHealth, 'degraded');
});
