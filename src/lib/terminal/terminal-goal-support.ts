/**
 * Providers whose PTY transcript records `/goal`. Renderer code cannot ask
 * the provider registry, so the list is mirrored here — keep it in step with
 * the adapters that implement `reduceTerminalGoalTranscriptLine`.
 */
const TERMINAL_GOAL_PROVIDERS: ReadonlySet<string> = new Set(['claude-code', 'codex']);

export function supportsTerminalGoal(providerId: string | null | undefined): boolean {
  return !!providerId && TERMINAL_GOAL_PROVIDERS.has(providerId);
}
