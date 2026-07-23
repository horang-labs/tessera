import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveIsTerminalSession,
  resolveSessionProcessing,
} from '@/hooks/use-session-processing';

test('GUI processing keeps its existing chat turn and workflow sources', () => {
  assert.equal(resolveSessionProcessing({
    isTerminal: false,
    guiTurnInFlight: true,
    guiWorkflowRunning: false,
    terminalTurnProcessing: false,
  }), true);

  assert.equal(resolveSessionProcessing({
    isTerminal: false,
    guiTurnInFlight: false,
    guiWorkflowRunning: true,
    terminalTurnProcessing: false,
  }), true);
});

test('GUI processing ignores unrelated terminal hook state', () => {
  assert.equal(resolveSessionProcessing({
    isTerminal: false,
    guiTurnInFlight: false,
    guiWorkflowRunning: false,
    terminalTurnProcessing: true,
  }), false);
});

test('PTY processing ignores GUI state and reads only terminal hook state', () => {
  assert.equal(resolveSessionProcessing({
    isTerminal: true,
    guiTurnInFlight: true,
    guiWorkflowRunning: true,
    terminalTurnProcessing: false,
  }), false);

  assert.equal(resolveSessionProcessing({
    isTerminal: true,
    guiTurnInFlight: false,
    guiWorkflowRunning: false,
    terminalTurnProcessing: true,
  }), true);
});

test('PTY processing keeps the snapshot execution kind until the live session loads', () => {
  assert.equal(resolveIsTerminalSession(undefined, 'terminal'), true);
  assert.equal(resolveIsTerminalSession('chat', 'terminal'), false);
});
