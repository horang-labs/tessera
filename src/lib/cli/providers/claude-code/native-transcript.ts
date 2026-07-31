import type { NativeTranscriptMessage } from '@/lib/session/native-transcript-types';

/**
 * Claude writes one JSONL line per streaming chunk into
 * `~/.claude/projects/<slug>/<session-id>.jsonl`. The envelope is documented in
 * `@/types/cli-jsonl-schemas`; only the fields this reader needs are typed here
 * so a schema change degrades to "no text" instead of throwing.
 */
interface ClaudeTranscriptLine {
  type?: unknown;
  isSidechain?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Text blocks only: `thinking`, `redacted_thinking`, `tool_use` and the
 * `tool_result` blocks that ride on `user` lines are all dropped.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text') continue;
    if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text);
  }
  return parts.join('\n');
}

export function parseClaudeNativeTranscript(content: string): NativeTranscriptMessage[] {
  const messages: NativeTranscriptMessage[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: ClaudeTranscriptLine;
    try {
      entry = JSON.parse(trimmed) as ClaudeTranscriptLine;
    } catch {
      continue;
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    // Sidechain lines are subagent turns — they are not part of the
    // conversation the user had with the lead agent.
    if (entry.isSidechain === true) continue;
    if (!isRecord(entry.message)) continue;

    const text = extractText(entry.message.content).trim();
    if (!text) continue;

    messages.push({ role: entry.type, text });
  }

  return messages;
}
