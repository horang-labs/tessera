/**
 * Codex rollout (JSONL) → SessionHistoryEvent decoder.
 *
 * Codex 0.145 records conversation in `event_msg`. Although the same turns also
 * appear in `response_item`, those copies contain model-facing context and must
 * remain ignored. Codex 0.147 stopped writing conversation `event_msg` entries,
 * so only that version and newer read conversation from `response_item.message`.
 *
 * The rollout's `session_meta.payload.cli_version` gates the new source:
 *   - Codex <= 0.146 → `event_msg` (user_message / agent_message)
 *   - Codex >= 0.147 → `response_item.message`
 *   - tools         → `response_item` (function_call, custom_tool_call, …)
 *   - everything else is dropped
 *
 * Developer and synthetic user context is filtered out of response messages so
 * only the conversation visible to the user reaches the chat view.
 *
 * Reasoning is not decoded: `response_item.reasoning` ships `encrypted_content`
 * with an empty `summary` in every rollout inspected, so there is no text to
 * show.
 */

import type { SessionHistoryEvent } from '@/lib/session-replay-types';
import type { ToolCallKind } from '@/types/tool-call-kind';
import type { ToolDisplayMetadata } from '@/types/tool-display';
import { inferToolCallKindFromToolName } from '@/types/tool-call-kind';
import { buildToolDisplay } from '@/lib/tool-display';
import { extractImageToolResult } from '@/lib/tool-results/tool-image';
import type { FileReadImageToolResult } from '@/types/tool-result';
import type { ContentBlock, ImageContentBlock } from '@/lib/ws/message-types';

/** Mirrors HISTORY_VERSION in session-history.ts. */
const HISTORY_VERSION = 1;

const RESPONSE_ITEM_CONVERSATION_MIN_MINOR = 147;
const SYNTHETIC_RESPONSE_USER_PREFIXES = [
  '# AGENTS.md instructions',
  '<INSTRUCTIONS>',
  '<environment_context>',
  '<user_instructions>',
  '<recommended_plugins>',
  '<skill>',
];

interface PendingToolCall {
  toolName: string;
  toolKind?: ToolCallKind;
  toolParams: Record<string, any>;
  toolDisplay?: ToolDisplayMetadata;
}

export interface CodexTranscriptDecoderState {
  /** Calls awaiting their output, keyed by Codex `call_id`. */
  pendingToolCalls: Map<string, PendingToolCall>;
  /** Whether this rollout version stores conversation in response_item.message. */
  readResponseItemConversation: boolean;
}

export function createCodexTranscriptDecoderState(): CodexTranscriptDecoderState {
  return {
    pendingToolCalls: new Map(),
    // Missing or malformed metadata keeps the proven 0.145 behavior.
    readResponseItemConversation: false,
  };
}

function versionUsesResponseItemConversation(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = /^(\d+)\.(\d+)/.exec(value);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || (major === 0 && minor >= RESPONSE_ITEM_CONVERSATION_MIN_MINOR);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readTimestamp(record: Record<string, any>): string {
  const raw = record.timestamp;
  if (typeof raw !== 'string' || !raw.trim()) return new Date().toISOString();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

/**
 * Codex tool names are normalized to the Claude-side names the chat UI already
 * renders — the live Codex parser does the same (commandExecution → "Bash",
 * fileChange → "Write"), so a replayed call looks identical to a streamed one.
 */
function normalizeToolName(rawName: string): { toolName: string; toolKind?: ToolCallKind } {
  switch (rawName) {
    case 'exec_command':
    case 'exec':
    case 'shell':
    case 'write_stdin':
      return { toolName: 'Bash', toolKind: 'shell_command' };
    case 'apply_patch':
      return { toolName: 'Write', toolKind: 'file_write' };
    case 'view_image':
      return { toolName: 'Read', toolKind: 'file_read' };
    case 'update_plan':
      return { toolName: 'TodoWrite', toolKind: 'todo_update' };
    case 'request_user_input':
      return { toolName: 'AskUserQuestion', toolKind: 'question_prompt' };
    default: {
      const inferred = inferToolCallKindFromToolName(rawName);
      return inferred ? { toolName: rawName, toolKind: inferred } : { toolName: rawName };
    }
  }
}

/**
 * `function_call.arguments` is a JSON string; `custom_tool_call.input` is raw
 * text (a patch body, for instance). Both end up as display params.
 */
function buildToolParams(payload: Record<string, any>, toolKind?: ToolCallKind): Record<string, any> {
  const rawArguments = payload.arguments;
  if (typeof rawArguments === 'string' && rawArguments.trim()) {
    try {
      const parsed = JSON.parse(rawArguments);
      if (isRecord(parsed)) {
        // Codex names the shell fields cmd/workdir; the chat UI reads command/cwd.
        const { cmd, workdir, ...rest } = parsed;
        return {
          ...rest,
          ...(cmd !== undefined ? { command: cmd } : {}),
          ...(workdir !== undefined ? { cwd: workdir } : {}),
        };
      }
    } catch {
      // Fall through — a non-JSON argument string is still worth showing.
    }
    return { command: rawArguments };
  }

  const input = payload.input;
  if (typeof input === 'string' && input.trim()) {
    return toolKind === 'file_write' ? { patch: input } : { input };
  }

  return {};
}

function decodeToolCall(
  payload: Record<string, any>,
  state: CodexTranscriptDecoderState,
  timestamp: string,
): SessionHistoryEvent | null {
  const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
  const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
  if (!rawName || !callId) return null;

  const { toolName, toolKind } = normalizeToolName(rawName);
  const toolParams = buildToolParams(payload, toolKind);
  const toolDisplay = buildToolDisplay(toolName, toolKind, toolParams);

  state.pendingToolCalls.set(callId, {
    toolName,
    ...(toolKind !== undefined ? { toolKind } : {}),
    toolParams,
    ...(toolDisplay !== undefined ? { toolDisplay } : {}),
  });

  return {
    v: HISTORY_VERSION,
    type: 'tool_call',
    timestamp,
    toolName,
    ...(toolKind !== undefined ? { toolKind } : {}),
    toolParams,
    ...(toolDisplay !== undefined ? { toolDisplay } : {}),
    status: 'running',
    toolUseId: callId,
  };
}

/** Codex writes outputs as text, structured records, or content-block arrays. */
function readToolOutput(output: unknown): {
  text: string;
  isError: boolean;
  imageResult?: FileReadImageToolResult;
} {
  if (typeof output === 'string') return { text: output, isError: false };
  if (Array.isArray(output)) {
    const text = output
      .flatMap((item: unknown) => isRecord(item) && typeof item.text === 'string' ? [item.text] : [])
      .join('\n');
    const imageResult = extractImageToolResult(output);
    return {
      text,
      isError: false,
      ...(imageResult !== undefined ? { imageResult } : {}),
    };
  }
  if (isRecord(output)) {
    const nested = output.output ?? output.content;
    const nestedResult = Array.isArray(nested) ? readToolOutput(nested) : undefined;
    const text = typeof nested === 'string'
      ? nested
      : nestedResult?.text ?? JSON.stringify(output);
    const isError = output.success === false || output.is_error === true;
    return {
      text,
      isError,
      ...(nestedResult?.imageResult !== undefined ? { imageResult: nestedResult.imageResult } : {}),
    };
  }
  return { text: '', isError: false };
}

function decodeToolResult(
  payload: Record<string, any>,
  state: CodexTranscriptDecoderState,
  timestamp: string,
): SessionHistoryEvent | null {
  const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
  if (!callId) return null;

  const { text, isError, imageResult } = readToolOutput(payload.output);
  const pending = state.pendingToolCalls.get(callId);
  state.pendingToolCalls.delete(callId);

  return {
    v: HISTORY_VERSION,
    type: 'tool_call',
    timestamp,
    // An output whose call was never seen (rollout resumed mid-turn) still
    // carries real output, so it is surfaced under a neutral name.
    toolName: pending?.toolName ?? 'Tool',
    ...(pending?.toolKind !== undefined ? { toolKind: pending.toolKind } : {}),
    toolParams: pending?.toolParams ?? {},
    ...(pending?.toolDisplay !== undefined ? { toolDisplay: pending.toolDisplay } : {}),
    status: isError ? 'error' : 'completed',
    ...(isError ? { error: text } : { output: text }),
    ...(!isError && imageResult !== undefined ? { toolUseResult: imageResult } : {}),
    toolUseId: callId,
  };
}

function decodeEventMessage(
  payload: Record<string, any>,
  timestamp: string,
): SessionHistoryEvent | null {
  const message = typeof payload.message === 'string' ? payload.message : '';
  if (!message.trim()) return null;

  if (payload.type === 'user_message') {
    return { v: HISTORY_VERSION, type: 'user_message', timestamp, content: message };
  }
  if (payload.type === 'agent_message') {
    return { v: HISTORY_VERSION, type: 'assistant_message', timestamp, content: message };
  }
  return null;
}

function decodeImageGenerationCompleted(
  payload: Record<string, any>,
  timestamp: string,
): SessionHistoryEvent | null {
  if (payload.type !== 'item_completed' || !isRecord(payload.item)) return null;
  const item = payload.item;
  if (item.kind !== 'image_gen.generation' && item.type !== 'imageGeneration') return null;
  const id = typeof item.id === 'string' && item.id ? item.id : `image-generation-${timestamp}`;
  const status = item.status === 'failed' || item.failure ? 'error' : 'completed';
  const imageResult: FileReadImageToolResult | undefined = status === 'completed'
    && typeof item.result === 'string'
    && item.result.length > 0
    ? {
        kind: 'file_read',
        contentType: 'image',
        base64: item.result,
        mimeType: 'image/png',
      }
    : undefined;
  return {
    v: HISTORY_VERSION,
    type: 'tool_call',
    timestamp,
    toolName: 'ImageGeneration',
    toolParams: {
      itemType: 'imageGeneration',
      ...(typeof item.revisedPrompt === 'string' ? { revisedPrompt: item.revisedPrompt } : {}),
      ...(typeof item.savedPath === 'string' ? { savedPath: item.savedPath } : {}),
      ...(typeof item.transparentBackground === 'boolean'
        ? { transparentBackground: item.transparentBackground }
        : {}),
      ...(typeof item.failure === 'string' ? { failure: item.failure } : {}),
    },
    status,
    ...(status === 'error' ? { error: typeof item.failure === 'string' ? item.failure : 'Image generation failed' } : {}),
    ...(imageResult ? { toolUseResult: imageResult } : {}),
    toolUseId: id,
  };
}

function imageContentBlock(value: unknown): ImageContentBlock | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (!match) return undefined;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1].toLowerCase() as ImageContentBlock['source']['media_type'],
      data: match[2].replace(/\s/g, ''),
    },
  };
}

function readResponseMessage(
  payload: Record<string, any>,
): { role: 'user' | 'assistant'; text: string; content: string | ContentBlock[] } | null {
  if (payload.role !== 'user' && payload.role !== 'assistant') return null;
  if (!Array.isArray(payload.content)) return null;

  const content: ContentBlock[] = [];
  for (const block of payload.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim()) {
        content.push({ type: 'text', text: block.text });
      }
      continue;
    }
    if (block.type === 'input_image') {
      const image = imageContentBlock(block.image_url ?? block.imageUrl ?? block.url);
      if (image) content.push(image);
    }
  }

  const text = content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n').trim();

  if (!text && content.length === 0) return null;
  return {
    role: payload.role,
    text,
    content: payload.role === 'user' && content.some((block) => block.type === 'image') ? content : text,
  };
}

function isSyntheticResponseUserMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return SYNTHETIC_RESPONSE_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function decodeResponseMessage(
  payload: Record<string, any>,
  timestamp: string,
): SessionHistoryEvent | null {
  const message = readResponseMessage(payload);
  if (!message) return null;
  if (message.role === 'user' && isSyntheticResponseUserMessage(message.text)) return null;

  return message.role === 'user'
    ? { v: HISTORY_VERSION, type: 'user_message', timestamp, content: message.content }
    : { v: HISTORY_VERSION, type: 'assistant_message', timestamp, content: message.text };
}

/**
 * Decode one rollout line. Returns [] for blank lines, malformed JSON, and every
 * record the chat view does not render (`token_count`, `task_started`,
 * `session_meta`, `turn_context`, …) — an unrecognized line must never fail the
 * surrounding read.
 */
export function decodeCodexTranscriptLine(
  line: string,
  state: CodexTranscriptDecoderState,
): SessionHistoryEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isRecord(record) || !isRecord(record.payload)) return [];

  const payload = record.payload;
  const timestamp = readTimestamp(record);

  if (record.type === 'session_meta') {
    state.readResponseItemConversation = versionUsesResponseItemConversation(payload.cli_version);
    return [];
  }

  if (record.type === 'event_msg') {
    const imageGeneration = decodeImageGenerationCompleted(payload, timestamp);
    if (imageGeneration) return [imageGeneration];
    if (state.readResponseItemConversation) return [];
    const event = decodeEventMessage(payload, timestamp);
    return event ? [event] : [];
  }

  if (record.type === 'response_item') {
    if (payload.type === 'message') {
      if (!state.readResponseItemConversation) return [];
      const event = decodeResponseMessage(payload, timestamp);
      return event ? [event] : [];
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const event = decodeToolCall(payload, state, timestamp);
      return event ? [event] : [];
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const event = decodeToolResult(payload, state, timestamp);
      return event ? [event] : [];
    }
    return [];
  }

  return [];
}

/** Decode a whole rollout in order. */
export function decodeCodexTranscript(lines: Iterable<string>): SessionHistoryEvent[] {
  const state = createCodexTranscriptDecoderState();
  const events: SessionHistoryEvent[] = [];
  for (const line of lines) {
    events.push(...decodeCodexTranscriptLine(line, state));
  }
  return events;
}
