export const TERMINAL_NAMED_KEYS = [
  'enter',
  'escape',
  'ctrl-c',
  'up',
  'down',
  'left',
  'right',
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
