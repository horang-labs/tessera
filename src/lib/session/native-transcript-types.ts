/**
 * A conversation turn recovered from a CLI's own transcript.
 *
 * PTY sessions have no Tessera-side assistant record: the hooks only observe
 * lifecycle, and a stock Stop payload carries no assistant text (see
 * `hook-receiver.ts`). Session export therefore falls back to whatever the
 * provider wrote for itself.
 *
 * This is a context handoff, not a replay — thinking blocks, tool calls and
 * streaming chunks are dropped, and only user/assistant prose survives.
 */
export interface NativeTranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Prompts Tessera recorded for the session (from `UserPromptSubmit`), used to
 * tell real user turns apart from the synthetic ones a CLI injects into its
 * own transcript (Codex replays AGENTS.md as a `user` message).
 */
export interface NativeTranscriptParseOptions {
  knownUserPrompts?: readonly string[];
}

export function normalizePromptForComparison(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
