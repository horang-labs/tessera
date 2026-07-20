export interface TerminalKeyEvent {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

export type TerminalClientPlatform = 'mac' | 'windows' | 'linux';

export interface TerminalInputContext {
  platform: TerminalClientPlatform;
}

export type TerminalInputAction =
  | { type: 'send-input'; data: string }
  | { type: 'scroll-viewport'; position: 'top' | 'bottom' };

export function detectTerminalClientPlatform(userAgent: string): TerminalClientPlatform {
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'mac';
  if (/Windows/.test(userAgent)) return 'windows';
  return 'linux';
}

export function isTerminalPasteShortcut(
  event: TerminalKeyEvent,
  platform: TerminalClientPlatform,
): boolean {
  if (
    event.type !== 'keydown'
    || event.isComposing
    || event.key.toLowerCase() !== 'v'
    || event.altKey
    || event.shiftKey
  ) {
    return false;
  }

  return platform === 'mac'
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/**
 * Returns input that must bypass xterm's default keyboard encoder.
 *
 * xterm collapses Shift+Enter to the same carriage return as plain Enter.
 * ESC + CR is the legacy modified-enter sequence understood by Claude Code,
 * Codex, and other terminal TUIs as a newline without submitting the prompt.
 */
export function resolveTerminalKeyInput(event: TerminalKeyEvent): string | null {
  if (
    event.type === 'keydown'
    && event.key === 'Enter'
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.isComposing
  ) {
    return '\x1b\r';
  }

  return null;
}

export function resolveTerminalInputAction(
  event: TerminalKeyEvent,
  context: TerminalInputContext,
): TerminalInputAction | null {
  if (event.type !== 'keydown' || event.isComposing) return null;

  if (
    event.key === 'Enter'
    && event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && !event.shiftKey
  ) {
    return { type: 'send-input', data: '\x1b[13;5u' };
  }

  if (
    event.key === 'Backspace'
    && event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && !event.shiftKey
  ) {
    return { type: 'send-input', data: '\x17' };
  }

  if (
    event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
  ) {
    if (event.key === 'Backspace') {
      return { type: 'send-input', data: '\x1b\x7f' };
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      return {
        type: 'send-input',
        data: event.key === 'ArrowLeft' ? '\x1bb' : '\x1bf',
      };
    }
  }

  if (
    context.platform === 'mac'
    && event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
  ) {
    const inputByKey: Partial<Record<string, string>> = {
      Backspace: '\x15',
      Delete: '\x0b',
      ArrowLeft: '\x01',
      ArrowRight: '\x05',
    };
    const data = inputByKey[event.key];
    if (data !== undefined) return { type: 'send-input', data };
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      return {
        type: 'scroll-viewport',
        position: event.key === 'ArrowUp' ? 'top' : 'bottom',
      };
    }
  }

  if (
    context.platform === 'linux'
    && event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
  ) {
    return {
      type: 'send-input',
      data: event.key === 'ArrowLeft' ? '\x1bb' : '\x1bf',
    };
  }

  const input = resolveTerminalKeyInput(event);
  return input === null ? null : { type: 'send-input', data: input };
}
