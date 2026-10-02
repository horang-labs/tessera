import assert from 'node:assert/strict';
import test from 'node:test';
import { retainTerminalInput, settleTerminalInput, retainDisconnectedInput, getRetainedTerminalInput, clearRetainedTerminalInput } from '../src/lib/terminal/raw-input-buffer';

test('only explicit accepted ack discards raw text; rejected and disconnected text remains available without replay', () => {
  retainTerminalInput('a', 'terminal', 'accepted');
  settleTerminalInput({ requestId: 'a', outcome: 'accepted' });
  retainTerminalInput('b', 'terminal', 'draft');
  settleTerminalInput({ requestId: 'b', outcome: 'rejected' });
  retainTerminalInput('c', 'terminal', ' uncertain');
  retainDisconnectedInput();
  assert.equal(getRetainedTerminalInput('terminal'), 'draft uncertain');
  clearRetainedTerminalInput('terminal');
  assert.equal(getRetainedTerminalInput('terminal'), '');
});
