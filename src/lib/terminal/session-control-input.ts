export const TERMINAL_NAMED_KEYS = [
  'enter',
  'escape',
  'ctrl-c',
  'up',
  'down',
  'left',
  'right',
  // Added for the Terminal input bar (#243), which needs it to cycle a provider's
  // permission mode. Its absence was a gap rather than a judgement: the Control CLI
  // drives sessions programmatically and never had to reach that control.
  'shift-tab',
  // Backspace deletes at the TUI prompt when the phone soft keyboard isn't up
  // — same reason the arrow keys are here. DEL (0x7f) rather than BS (0x08)
  // because that's what a modern terminal emulator sends for the ⌫ key, and
  // what readline / providers' prompt widgets bind to.
  'backspace',
] as const;

export type TerminalNamedKey = typeof TERMINAL_NAMED_KEYS[number];

const TERMINAL_NAMED_KEY_SET = new Set<string>(TERMINAL_NAMED_KEYS);

const TERMINAL_NAMED_KEY_SEQUENCES: Record<TerminalNamedKey, string> = {
  enter: '\r',
  escape: '\x1b',
  'ctrl-c': '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  'shift-tab': '\x1b[Z',
  backspace: '\x7f',
};

export function isTerminalNamedKey(value: unknown): value is TerminalNamedKey {
  return typeof value === 'string' && TERMINAL_NAMED_KEY_SET.has(value);
}

export function terminalNamedKeySequence(key: TerminalNamedKey): string {
  return TERMINAL_NAMED_KEY_SEQUENCES[key];
}

export function normalizeSemanticPrompt(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

export function bracketSemanticPrompt(value: string): string {
  // Mirror xterm's paste path: terminal newlines are carriage returns, while
  // ESC is rendered visibly so prompt text cannot close bracketed-paste mode
  // and smuggle a control sequence into the provider TUI.
  const prepared = value.replace(/\r?\n/g, '\r');
  const sanitized = prepared.replace(/\x1b/g, '\u241b');
  return `\x1b[200~${sanitized}\x1b[201~`;
}
