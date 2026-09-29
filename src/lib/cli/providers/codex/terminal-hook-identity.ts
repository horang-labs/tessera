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

// Codex names every rollout `rollout-<timestamp>-<id>.jsonl`, in the account
// home and in Tessera's per-session overlay alike. Claude transcripts are
// `<uuid>.jsonl`, so the basename alone tells the two apart. Only the string is
// inspected — no filesystem access — so Windows/UNC/POSIX spellings all work.
const CODEX_ROLLOUT_BASENAME = /(?:^|[\\/])rollout-[^\\/]+\.jsonl$/;

/**
 * A pane token identifies the owning Tessera terminal, not the provider that
 * inherits its environment. A `codex exec` launched from a Claude (or OpenCode)
 * pane posts validly authenticated hooks whose session id and rollout path
 * belong to Codex; read as the pane's own provider, that id looks like a
 * `/fork` and spawns a session no Claude transcript backs.
 *
 * Claude legitimately changes session id (`/fork`, `/resume`, `/clear`), so the
 * id alone cannot be judged — the transcript path says which provider wrote it.
 */
export function isCodexHookPayloadOnForeignPane(
  paneProviderId: string,
  transcriptPath: string | undefined,
): boolean {
  return paneProviderId !== 'codex'
    && Boolean(transcriptPath)
    && CODEX_ROLLOUT_BASENAME.test(transcriptPath as string);
}
