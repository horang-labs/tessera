import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearClientTerminalHandoff,
  hasClientTerminalHandoff,
  markClientTerminalHandoff,
} from '../src/lib/terminal/client-terminal-handoff-state';

test('client handoff state remains active until every terminal for the session clears', () => {
  const sessionId = 'client-handoff-session';
  markClientTerminalHandoff('client-terminal-1', sessionId);
  markClientTerminalHandoff('client-terminal-2', sessionId);

  assert.equal(hasClientTerminalHandoff(sessionId), true);
  clearClientTerminalHandoff('client-terminal-1');
  assert.equal(hasClientTerminalHandoff(sessionId), true);
  clearClientTerminalHandoff('client-terminal-2');
  assert.equal(hasClientTerminalHandoff(sessionId), false);
});
