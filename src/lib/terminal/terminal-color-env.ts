/**
 * Normalize the environment at the PTY boundary so terminal applications can
 * emit their native ANSI colors. A shell startup file can still override these
 * values after the process starts.
 */
export function normalizeTerminalColorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized = { ...env };

  delete normalized.NO_COLOR;
  if (normalized.FORCE_COLOR === '0') delete normalized.FORCE_COLOR;
  if (normalized.CLICOLOR === '0') delete normalized.CLICOLOR;

  normalized.TERM = 'xterm-256color';
  normalized.COLORTERM = 'truecolor';
  normalized.TERM_PROGRAM = 'Tessera';

  return normalized;
}
