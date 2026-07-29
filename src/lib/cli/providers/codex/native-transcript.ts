import {
  normalizePromptForComparison,
  type NativeTranscriptMessage,
  type NativeTranscriptParseOptions,
} from '@/lib/session/native-transcript-types';

/**
 * Codex rollout JSONL lines are `{ type, payload, timestamp }`. Conversation
 * turns live in `response_item` payloads of type `message`; `event_msg` lines
 * mirror the same turns for the TUI, so reading both would duplicate every
 * message.
 */
interface CodexRolloutLine {
  type?: unknown;
  payload?: unknown;
}

/**
 * Codex replays instruction context as `user` turns inside its own transcript:
 * a rollout for a two-line chat also contains AGENTS.md and environment
 * preambles. Tessera's own `user_message` history is the reliable list of what
 * the person actually typed, so these markers are only the fallback for
 * sessions whose prompts were never recorded.
 */
const SYNTHETIC_USER_MARKERS = [
  '# AGENTS.md instructions',
  '<INSTRUCTIONS>',
  '<environment_context>',
  '<user_instructions>',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'input_text' && block.type !== 'output_text' && block.type !== 'text') {
      continue;
    }
    if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text);
  }
  return parts.join('\n');
}

function looksSynthetic(text: string): boolean {
  return SYNTHETIC_USER_MARKERS.some((marker) => text.includes(marker));
}

export function parseCodexNativeTranscript(
  content: string,
  options: NativeTranscriptParseOptions = {},
): NativeTranscriptMessage[] {
  const knownPrompts = new Set(
    (options.knownUserPrompts ?? [])
      .map(normalizePromptForComparison)
      .filter(Boolean),
  );
  const messages: NativeTranscriptMessage[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: CodexRolloutLine;
    try {
      entry = JSON.parse(trimmed) as CodexRolloutLine;
    } catch {
      continue;
    }

    if (entry.type !== 'response_item' || !isRecord(entry.payload)) continue;
    const payload = entry.payload;
    if (payload.type !== 'message') continue;
    // `developer` carries the system prompt and sandbox policy — never a turn.
    if (payload.role !== 'user' && payload.role !== 'assistant') continue;

    const text = extractText(payload.content).trim();
    if (!text) continue;

    if (payload.role === 'user') {
      const isKnownPrompt = knownPrompts.has(normalizePromptForComparison(text));
      if (knownPrompts.size > 0 ? !isKnownPrompt : looksSynthetic(text)) continue;
    }

    messages.push({ role: payload.role, text });
  }

  return messages;
}
