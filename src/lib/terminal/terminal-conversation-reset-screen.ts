/**
 * Screen signatures that mean "the conversation running in this PTY was reset".
 *
 * Claude Code announces `/clear` through a SessionStart hook, so it needs none
 * of this. Codex and OpenCode announce nothing: both create the new session
 * lazily on the next prompt (measured 2026-07-22), leaving the PTY bound to the
 * previous Tessera session until then. What they *do* do, immediately and
 * regardless of how the command was issued, is repaint the screen — so that is
 * what these matchers read.
 *
 * Both patterns are anchored on something that cannot appear mid-conversation:
 *  - Codex prints the resume hint for the session it just closed, naming that
 *    session's id — matched against the id Tessera currently holds, which makes
 *    a false positive essentially impossible.
 *  - OpenCode returns to its empty-composer home screen, whose placeholder is
 *    replaced by the transcript as soon as anything is said.
 */

/** Codex: `To continue this session, run codex resume <uuid>` after a reset. */
export function codexScreenShowsConversationReset(options: {
  visibleText: string;
  currentProviderSessionId: string;
}): boolean {
  const { currentProviderSessionId, visibleText } = options;
  if (!currentProviderSessionId) return false;
  const escaped = currentProviderSessionId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`codex\\s+resume\\s+${escaped}\\b`, 'iu').test(visibleText);
}

/**
 * OpenCode: the home screen's composer placeholder. It is only rendered while
 * the session has no messages, so seeing it again after a bound conversation
 * means that conversation is gone.
 */
export function openCodeScreenShowsConversationReset(options: {
  visibleText: string;
  currentProviderSessionId: string;
}): boolean {
  if (!options.currentProviderSessionId) return false;
  return /Ask anything\.\.\./u.test(options.visibleText);
}
