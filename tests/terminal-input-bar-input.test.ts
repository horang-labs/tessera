import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTerminalNamedKey,
  terminalNamedKeySequence,
} from '@/lib/terminal/session-control-input';
import {
  TERMINAL_INPUT_BAR_KEYS,
  terminalInputBarKeySequence,
  terminalInputBarTextPayload,
} from '@/lib/terminal/terminal-input-bar-input';

// Shift+Tab is the one key the Terminal input bar needs that the table never carried:
// the Control CLI drives sessions programmatically and never had to cycle a permission
// mode. The sequence is CSI Z (back-tab), per the issue.
test('the named-key table carries shift-tab as CSI Z', () => {
  assert.equal(isTerminalNamedKey('shift-tab'), true);
  assert.equal(terminalNamedKeySequence('shift-tab'), '\x1b[Z');
});

// The eight keys are a decision, not a convenience list. Tab would be a dead
// button on a buffered bar and Ctrl+C remains deliberately absent.
test('the bar offers exactly the eight decided keys, in the decided order', () => {
  assert.deepEqual(
    TERMINAL_INPUT_BAR_KEYS.map((key) => key.namedKey),
    ['escape', 'shift-tab', 'left', 'up', 'down', 'right', 'backspace', 'enter'],
  );
});

test('each bar key sends the byte sequence a keyboard would', () => {
  const sequences = Object.fromEntries(
    TERMINAL_INPUT_BAR_KEYS.map((key) => [key.namedKey, terminalInputBarKeySequence(key.namedKey)]),
  );

  assert.deepEqual(sequences, {
    escape: '\x1b',
    'shift-tab': '\x1b[Z',
    left: '\x1b[D',
    up: '\x1b[A',
    down: '\x1b[B',
    right: '\x1b[C',
    backspace: '\x7f',
    enter: '\r',
  });
});

// The bar is buffered: what the user typed goes out as one paste, not as keystrokes.
// Wrapping and ESC neutralisation are `bracketSemanticPrompt`'s, reused rather than
// rewritten, so this asserts the payload a TUI actually receives.
test('submitted text goes out bracketed-paste wrapped', () => {
  assert.equal(
    terminalInputBarTextPayload('run the tests'),
    '\x1b[200~run the tests\x1b[201~',
  );
});

test('a multi-line submit stays one paste, with carriage returns inside the brackets', () => {
  assert.equal(
    terminalInputBarTextPayload('first\r\nsecond\n'),
    '\x1b[200~first\rsecond\x1b[201~',
  );
});

// Text a user pasted in cannot be allowed to close bracketed-paste mode and smuggle a
// control sequence into the TUI behind it.
test('an ESC in the text is neutralised rather than sent', () => {
  const payload = terminalInputBarTextPayload('before\x1b[201~rm -rf /');
  assert.equal(payload, '\x1b[200~before␛[201~rm -rf /\x1b[201~');
});

test('nothing is sent for text that is empty or only whitespace', () => {
  assert.equal(terminalInputBarTextPayload(''), null);
  assert.equal(terminalInputBarTextPayload('  \n\t '), null);
});
