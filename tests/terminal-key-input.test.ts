import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectTerminalClientPlatform,
  isTerminalPasteShortcut,
  resolveTerminalInputAction,
  resolveTerminalKeyInput,
} from '@/lib/terminal/terminal-key-input';

function keyEvent(overrides: Partial<Parameters<typeof resolveTerminalKeyInput>[0]> = {}) {
  return {
    type: 'keydown',
    key: 'Enter',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

test('terminal client platform is derived from the browser user agent', () => {
  assert.deepEqual(
    [
      detectTerminalClientPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'),
      detectTerminalClientPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
      detectTerminalClientPlatform('Mozilla/5.0 (X11; Linux x86_64)'),
    ],
    ['mac', 'windows', 'linux'],
  );
});

test('terminal paste shortcut follows the client platform without intercepting composition', () => {
  assert.deepEqual(
    [
      isTerminalPasteShortcut(keyEvent({ key: 'v', metaKey: true }), 'mac'),
      isTerminalPasteShortcut(keyEvent({ key: 'V', ctrlKey: true }), 'linux'),
      isTerminalPasteShortcut(keyEvent({ key: 'v', ctrlKey: true }), 'windows'),
      isTerminalPasteShortcut(keyEvent({ key: 'v', ctrlKey: true }), 'mac'),
      isTerminalPasteShortcut(keyEvent({ key: 'v', metaKey: true, isComposing: true }), 'mac'),
      isTerminalPasteShortcut(keyEvent({ type: 'keyup', key: 'v', metaKey: true }), 'mac'),
    ],
    [true, true, true, false, false, false],
  );
});

test('Shift+Enter sends the legacy modified-enter sequence used for TUI newlines', () => {
  assert.equal(
    resolveTerminalKeyInput(keyEvent({ shiftKey: true })),
    '\x1b\r',
  );
});

test('terminal input policy returns an explicit PTY action for modified Enter', () => {
  assert.deepEqual(
    resolveTerminalInputAction(keyEvent({ shiftKey: true }), { platform: 'mac' }),
    { type: 'send-input', data: '\x1b\r' },
  );
});

test('Ctrl+Enter sends the CSI-u modified-enter sequence used by terminal TUIs', () => {
  assert.deepEqual(
    resolveTerminalInputAction(keyEvent({ ctrlKey: true }), { platform: 'linux' }),
    { type: 'send-input', data: '\x1b[13;5u' },
  );
});

test('Ctrl+Backspace deletes the previous word in shells and TUIs', () => {
  assert.deepEqual(
    resolveTerminalInputAction(
      keyEvent({ key: 'Backspace', ctrlKey: true }),
      { platform: 'windows' },
    ),
    { type: 'send-input', data: '\x17' },
  );
});

test('Alt word-editing chords use readline-compatible escape sequences', () => {
  const context = { platform: 'linux' as const };
  assert.deepEqual(
    [
      resolveTerminalInputAction(
        keyEvent({ key: 'Backspace', altKey: true }),
        context,
      ),
      resolveTerminalInputAction(
        keyEvent({ key: 'ArrowLeft', altKey: true }),
        context,
      ),
      resolveTerminalInputAction(
        keyEvent({ key: 'ArrowRight', altKey: true }),
        context,
      ),
    ],
    [
      { type: 'send-input', data: '\x1b\x7f' },
      { type: 'send-input', data: '\x1bb' },
      { type: 'send-input', data: '\x1bf' },
    ],
  );
});

test('macOS Command editing chords match native terminal line operations', () => {
  const context = { platform: 'mac' as const };
  assert.deepEqual(
    [
      resolveTerminalInputAction(
        keyEvent({ key: 'Backspace', metaKey: true }),
        context,
      ),
      resolveTerminalInputAction(
        keyEvent({ key: 'Delete', metaKey: true }),
        context,
      ),
      resolveTerminalInputAction(
        keyEvent({ key: 'ArrowLeft', metaKey: true }),
        context,
      ),
      resolveTerminalInputAction(
        keyEvent({ key: 'ArrowRight', metaKey: true }),
        context,
      ),
    ],
    [
      { type: 'send-input', data: '\x15' },
      { type: 'send-input', data: '\x0b' },
      { type: 'send-input', data: '\x01' },
      { type: 'send-input', data: '\x05' },
    ],
  );
});

test('macOS Command+Up and Command+Down navigate terminal scrollback without PTY input', () => {
  const context = { platform: 'mac' as const };
  assert.deepEqual(
    [
      resolveTerminalInputAction(
        keyEvent({ key: 'ArrowUp', metaKey: true }),
        context,
      ),
      resolveTerminalInputAction(
        keyEvent({ key: 'ArrowDown', metaKey: true }),
        context,
      ),
    ],
    [
      { type: 'scroll-viewport', position: 'top' },
      { type: 'scroll-viewport', position: 'bottom' },
    ],
  );
});

test('Linux Ctrl+Arrow uses readline word navigation without affecting Windows', () => {
  assert.deepEqual(
    [
      resolveTerminalInputAction(
        keyEvent({ key: 'ArrowLeft', ctrlKey: true }),
        { platform: 'linux' },
      ),
      resolveTerminalInputAction(
        keyEvent({ key: 'ArrowRight', ctrlKey: true }),
        { platform: 'linux' },
      ),
      resolveTerminalInputAction(
        keyEvent({ key: 'ArrowRight', ctrlKey: true }),
        { platform: 'windows' },
      ),
    ],
    [
      { type: 'send-input', data: '\x1bb' },
      { type: 'send-input', data: '\x1bf' },
      null,
    ],
  );
});

test('plain Enter and unrelated modified keys stay on the xterm default path', () => {
  assert.equal(resolveTerminalKeyInput(keyEvent()), null);
  assert.equal(resolveTerminalKeyInput(keyEvent({ shiftKey: true, ctrlKey: true })), null);
  assert.equal(
    resolveTerminalKeyInput(keyEvent({ key: 'A', shiftKey: true })),
    null,
  );
  assert.equal(
    resolveTerminalKeyInput(keyEvent({ type: 'keyup', shiftKey: true })),
    null,
  );
  assert.equal(
    resolveTerminalKeyInput(keyEvent({ isComposing: true, shiftKey: true })),
    null,
  );
});
