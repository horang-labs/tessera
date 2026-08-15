import {
  normalizePromptForComparison,
  type NativeTranscriptMessage,
  type NativeTranscriptParseOptions,
} from '@/lib/session/native-transcript-types';

/**
 * Codex rollout JSONL lines are `{ type, payload, timestamp }`. Conversation
 * turns live in `response_item` payloads of type `message`; legacy `event_msg`
 * lines may mirror the same turns for the TUI, so this parser reads only the
 * canonical model-facing representation.
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
  '<recommended_plugins>',
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

export function looksLikeSyntheticCodexUserMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return SYNTHETIC_USER_MARKERS.some((marker) => trimmed.startsWith(marker));
}

/** Decode one model-facing conversation item without admitting developer context. */
export function readCodexResponseMessage(payload: unknown): NativeTranscriptMessage | null {
  if (!isRecord(payload) || payload.type !== 'message') return null;
  if (payload.role !== 'user' && payload.role !== 'assistant') return null;

  const text = extractText(payload.content).trim();
  return text ? { role: payload.role, text } : null;
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
    const message = readCodexResponseMessage(entry.payload);
    if (!message) continue;

    if (message.role === 'user') {
      const isKnownPrompt = knownPrompts.has(normalizePromptForComparison(message.text));
      if (
        knownPrompts.size > 0
          ? !isKnownPrompt
          : looksLikeSyntheticCodexUserMessage(message.text)
      ) continue;
    }

    messages.push(message);
  }

  return messages;
}
