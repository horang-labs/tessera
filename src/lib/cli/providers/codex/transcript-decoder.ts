/**
 * Codex rollout (JSONL) → SessionHistoryEvent decoder.
 *
 * Legacy Codex rollouts record the same turn twice: `event_msg` carries what
 * the TUI showed, while `response_item` carries what went to the model. Codex
 * 0.147 stopped writing conversation `event_msg` entries, so current rollouts
 * can only be replayed from `response_item.message`.
 *
 * Both representations are therefore decoded, with adjacent cross-source
 * copies collapsed for legacy and mixed-version rollouts:
 *   - conversation  → `event_msg` and `response_item.message`
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
import {
  looksLikeSyntheticCodexUserMessage,
  readCodexResponseMessage,
} from './native-transcript';
import { normalizePromptForComparison } from '@/lib/session/native-transcript-types';

/** Mirrors HISTORY_VERSION in session-history.ts. */
const HISTORY_VERSION = 1;

interface PendingToolCall {
  toolName: string;
  toolKind?: ToolCallKind;
  toolParams: Record<string, any>;
  toolDisplay?: ToolDisplayMetadata;
}

type CodexConversationEvent = {
  v: number;
  type: 'user_message' | 'assistant_message';
  timestamp: string;
  content: string;
};

export interface CodexTranscriptDecoderState {
  /** Calls awaiting their output, keyed by Codex `call_id`. */
  pendingToolCalls: Map<string, PendingToolCall>;
  /** Last visible turn, used only to collapse the two rollout representations. */
  lastConversation?: {
    source: 'event_msg' | 'response_item';
    type: 'user_message' | 'assistant_message';
    content: string;
  };
  knownUserPrompts: Set<string>;
}

export interface CodexTranscriptDecoderOptions {
  knownUserPrompts?: readonly string[];
}

export function createCodexTranscriptDecoderState(
  options: CodexTranscriptDecoderOptions = {},
): CodexTranscriptDecoderState {
  return {
    pendingToolCalls: new Map(),
    knownUserPrompts: new Set(
      (options.knownUserPrompts ?? [])
        .map(normalizePromptForComparison)
        .filter(Boolean),
    ),
  };
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
): CodexConversationEvent | null {
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

function decodeResponseMessage(
  payload: Record<string, any>,
  timestamp: string,
  state: CodexTranscriptDecoderState,
): CodexConversationEvent | null {
  const message = readCodexResponseMessage(payload);
  if (!message) return null;
  if (message.role === 'user') {
    const isKnownPrompt = state.knownUserPrompts.has(normalizePromptForComparison(message.text));
    if (
      state.knownUserPrompts.size > 0
        ? !isKnownPrompt
        : looksLikeSyntheticCodexUserMessage(message.text)
    ) return null;
  }

  return message.role === 'user'
    ? { v: HISTORY_VERSION, type: 'user_message', timestamp, content: message.text }
    : { v: HISTORY_VERSION, type: 'assistant_message', timestamp, content: message.text };
}

function omitCrossSourceConversationDuplicate(
  event: CodexConversationEvent,
  source: 'event_msg' | 'response_item',
  state: CodexTranscriptDecoderState,
): CodexConversationEvent | null {
  const previous = state.lastConversation;
  const isDuplicate = previous
    && previous.source !== source
    && previous.type === event.type
    && previous.content === event.content;
  if (isDuplicate) return null;

  state.lastConversation = { source, type: event.type, content: event.content };
  return event;
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

  if (record.type === 'event_msg') {
    const event = decodeEventMessage(payload, timestamp);
    if (!event) {
      state.lastConversation = undefined;
      return [];
    }
    const unique = omitCrossSourceConversationDuplicate(event, 'event_msg', state);
    return unique ? [unique] : [];
  }

  if (record.type === 'response_item') {
    if (payload.type === 'message') {
      const event = decodeResponseMessage(payload, timestamp, state);
      if (!event) {
        state.lastConversation = undefined;
        return [];
      }
      const unique = omitCrossSourceConversationDuplicate(event, 'response_item', state);
      return unique ? [unique] : [];
    }
    state.lastConversation = undefined;
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

  state.lastConversation = undefined;
  return [];
}

/** Decode a whole rollout in order. */
export function decodeCodexTranscript(
  lines: Iterable<string>,
  options: CodexTranscriptDecoderOptions = {},
): SessionHistoryEvent[] {
  const state = createCodexTranscriptDecoderState(options);
  const events: SessionHistoryEvent[] = [];
  for (const line of lines) {
    events.push(...decodeCodexTranscriptLine(line, state));
  }
  return events;
}
