export interface ClaudeTerminalHookIdentityInput {
  expectedProviderSessionId?: string;
  observedProviderSessionId: string;
  event: string;
  source?: string;
  /**
   * Claude holds the observed conversation in a background daemon job that is
   * not a tracked `/fork` child: the conversation on this terminal was moved to
   * the background and is continuing there.
   */
  handedOffToBackground: boolean;
}

// SessionStart `source` values Claude reports when the conversation on *this*
// terminal changes: `/resume` and `/fork` switch to another one, `/clear` starts
// an empty one. `startup` is a process beginning a conversation of its own, and
// `compact` keeps the session id.
const OWN_TRANSITION_SOURCES = new Set(['resume', 'clear', 'fork']);

/**
 * A pane token identifies the owning Tessera terminal, not the Claude process
 * that inherits its environment and hook settings. A background worker, or the
 * placeholder conversation that replaces a PTY's conversation when it is moved
 * to the background, posts validly authenticated hooks under session ids the
 * pane never launched.
 *
 * A changed session id alone therefore proves nothing. It is the pane's own
 * transition only when Claude says so (`SessionStart` with `resume`, `clear` or
 * `fork`). A conversation that was moved to the background is the one already on
 * this terminal continuing elsewhere — its worker may well report `resume` — so
 * it is ignored, whatever the source, rather than registered as a new session.
 * Everything else came from a process that is not on the terminal's screen and
 * must not create a session either.
 */
export function shouldIgnoreForeignClaudeHookIdentity(
  input: ClaudeTerminalHookIdentityInput,
): boolean {
  const {
    expectedProviderSessionId,
    observedProviderSessionId,
    event,
    source,
    handedOffToBackground,
  } = input;
  if (!expectedProviderSessionId || expectedProviderSessionId === observedProviderSessionId) {
    return false;
  }
  if (handedOffToBackground) return true;
  return event !== 'SessionStart' || !OWN_TRANSITION_SOURCES.has(source ?? '');
}
