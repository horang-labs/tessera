export interface CodexTerminalHookIdentityInput {
  expectedProviderSessionId?: string;
  observedProviderSessionId: string;
  event: string;
  source?: string;
}

/**
 * A pane token identifies the owning Tessera terminal, not every Codex process
 * that inherits its environment. Nested `codex exec` processes therefore send
 * validly authenticated hooks with an unrelated rollout id.
 *
 * Real Codex forks are discovered authoritatively from rollout metadata
 * (`forked_from_id`). The only hook-driven identity transition is `/clear`,
 * whose SessionStart payload explicitly reports `source=clear`.
 */
export function shouldIgnoreForeignCodexHookIdentity(
  input: CodexTerminalHookIdentityInput,
): boolean {
  const {
    expectedProviderSessionId,
    observedProviderSessionId,
    event,
    source,
  } = input;
  if (!expectedProviderSessionId || expectedProviderSessionId === observedProviderSessionId) {
    return false;
  }
  return event !== 'SessionStart' || source !== 'clear';
}
