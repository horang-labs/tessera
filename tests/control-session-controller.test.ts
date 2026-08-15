import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalControlSessionController } from '../src/lib/control/session-controller';
import { ControlOperationError } from '../src/lib/control/service';
import {
  TerminalSessionInputError,
  TerminalSessionRuntimeNotRunningError,
} from '../src/lib/terminal/terminal-manager';

test('Control Session mutations resolve one user and preserve stable runtime input errors', async () => {
  const calls: string[] = [];
  const controller = createTerminalControlSessionController({
    userId: 'control-user',
    manager: {
      submitSessionPrompt: async (_sessionId, userId) => {
        calls.push(userId);
        throw new TerminalSessionInputError('The Session provider TUI is not ready for input.');
      },
      sendSessionKeys: async (_sessionId, userId) => {
        calls.push(userId);
        throw new TerminalSessionRuntimeNotRunningError('durable-session');
      },
      stopSessionRuntime: async (_sessionId, userId) => {
        calls.push(userId);
        throw new TerminalSessionRuntimeNotRunningError('durable-session');
      },
    },
  });

  await assert.rejects(
    controller.prompt('durable-session', 'follow up'),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'INPUT_NOT_ACCEPTED'
      && error.details.sessionId === 'durable-session',
  );
  for (const operation of [
    () => controller.sendKeys('durable-session', ['enter']),
    () => controller.stop('durable-session'),
  ]) {
    await assert.rejects(
      operation(),
      (error: unknown) => error instanceof ControlOperationError
        && error.code === 'SESSION_RUNTIME_NOT_RUNNING'
        && error.details.sessionId === 'durable-session',
    );
  }
  assert.deepEqual(calls, ['control-user', 'control-user', 'control-user']);
});
