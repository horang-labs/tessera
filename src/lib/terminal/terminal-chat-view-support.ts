/**
 * Which providers a PTY session can be replayed as a read-only chat for.
 *
 * Gated per provider because the chat view is only as good as the transcript
 * behind it: the provider must expose `readTerminalTranscriptEvents`. Renderer
 * code cannot ask the registry, so the list is mirrored here — keep it in step
 * with the adapters that implement that method.
 */
const TERMINAL_CHAT_VIEW_PROVIDERS: ReadonlySet<string> = new Set(['claude-code', 'codex', 'opencode']);

export function supportsTerminalChatView(providerId: string | null | undefined): boolean {
  return !!providerId && TERMINAL_CHAT_VIEW_PROVIDERS.has(providerId);
}
