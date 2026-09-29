export interface ClaudeTerminalHookIdentityInput {
  expectedProviderSessionId?: string;
  observedProviderSessionId: string;
  event: string;
  source?: string;
  /** Claude records the observed conversation as a live background daemon job. */
  heldInBackground: boolean;
}

// SessionStart `source` values Claude reports when the conversation on *this*
// terminal changes: `/resume` and `/fork` switch to another one, `/clear` starts
// an empty one. `startup` is a process beginning a conversation of its own, and
// `compact` keeps the session id.
const OWN_TRANSITION_SOURCES = new Set(['resume', 'clear', 'fork']);

/**
 * A pane token identifies the owning Tessera terminal, not the Claude process
 * that inherits its environment and hook settings. A nested `claude -p`, a
 * background worker, or the placeholder conversation that replaces a PTY's
 * conversation when it is moved to the background all post validly
 * authenticated hooks under session ids the pane never launched.
 *
 * A changed session id alone therefore proves nothing. It is the pane's own
 * transition only when Claude says so (`SessionStart` with `resume`, `clear` or
 * `fork`); a conversation Claude holds in the background is registered as a
 * background session instead of moving the pane. Everything else came from a
 * process that is not on this terminal's screen and must not create a session.
 */
export function shouldIgnoreForeignClaudeHookIdentity(
  input: ClaudeTerminalHookIdentityInput,
): boolean {
  const {
    expectedProviderSessionId,
    observedProviderSessionId,
    event,
    source,
    heldInBackground,
  } = input;
  if (!expectedProviderSessionId || expectedProviderSessionId === observedProviderSessionId) {
    return false;
  }
  if (heldInBackground) return false;
  return event !== 'SessionStart' || !OWN_TRANSITION_SOURCES.has(source ?? '');
}
