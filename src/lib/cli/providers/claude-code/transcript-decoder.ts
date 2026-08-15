/**
 * Claude Code transcript (JSONL) → SessionHistoryEvent decoder.
 *
 * Terminal (PTY) sessions never stream through ProcessManager, so Tessera has no
 * canonical history for them — only the user prompts captured by the
 * UserPromptSubmit hook. This decoder reads the transcript Claude Code itself
 * writes (`~/.claude/projects/<slug>/<id>.jsonl`) and replays it into the same
 * event shape the live pipeline persists, so the existing replay reducer,
 * pagination, and chat UI render a PTY conversation unchanged.
 *
 * Decoding is pure and stateless per file: the caller threads one decoder state
 * through the lines of a single transcript so `tool_use` blocks can be paired
 * with the `tool_result` blocks that arrive in a later record.
 */

import type { SessionHistoryEvent } from '@/lib/session-replay-types';
import type { ToolCallKind } from '@/types/tool-call-kind';
import type { ToolDisplayMetadata } from '@/types/tool-display';
import { buildToolDisplay } from '@/lib/tool-display';
import { normalizeToolResult } from '@/lib/tool-results/normalize-tool-result';
import { buildImageToolResult, isImagePath } from '@/lib/tool-results/tool-image';
import { extractOutputString } from '../../message-parser';
import { truncateToolResult } from '../../truncate-tool-result';
import {
  mapClaudeToolNameToToolKind,
  synthesizeClaudeToolResult,
} from './synthesize-claude-tool-result';

/** Mirrors HISTORY_VERSION in session-history.ts — events must be readable by the same reducer. */
const HISTORY_VERSION = 1;

interface PendingToolCall {
  toolName: string;
  toolKind?: ToolCallKind;
  toolParams: Record<string, any>;
  toolDisplay?: ToolDisplayMetadata;
}

export interface ClaudeTranscriptDecoderState {
  /** Tessera session id — image tool results resolve their URL through it. */
  sessionId: string;
  /** tool_use blocks awaiting their tool_result, keyed by tool_use id. */
  pendingToolCalls: Map<string, PendingToolCall>;
}

export function createClaudeTranscriptDecoderState(
  sessionId: string,
): ClaudeTranscriptDecoderState {
  return { sessionId, pendingToolCalls: new Map() };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readTimestamp(record: Record<string, any>): string {
  const raw = record.timestamp;
  if (typeof raw !== 'string' || !raw.trim()) {
    return new Date().toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

/**
 * Claude structurally marks turns it injected itself (compact summaries, command
 * scaffolding). Those are not user speech and must not render as user messages —
 * but a tool_result carried inside one is genuine agent output and stays visible.
 */
function isInjectedUserTurn(record: Record<string, any>): boolean {
  return record.isMeta === true
    || record.isSynthetic === true
    || record.isCompactSummary === true;
}

const COMMAND_NAME_PATTERN = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_PATTERN = /<command-args>([\s\S]*?)<\/command-args>/;
const LOCAL_COMMAND_STDOUT_PATTERN = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;

/**
 * A slash command typed into the TUI lands in the transcript as raw XML
 * scaffolding across two unflagged user records — the invocation, then its
 * stdout. GUI sessions never produce these (Tessera routes slash commands
 * itself), so nothing upstream strips them. Render the invocation as the command
 * the user actually typed and demote its output to a system note.
 *
 * Returns null when the text is ordinary user speech.
 */
function decodeLocalCommandText(
  text: string,
  timestamp: string,
): SessionHistoryEvent[] | null {
  const stdout = text.match(LOCAL_COMMAND_STDOUT_PATTERN);
  if (stdout) {
    const output = stdout[1].trim();
    return output
      ? [{
          v: HISTORY_VERSION,
          type: 'system',
          timestamp,
          message: output,
          severity: 'info',
          subtype: 'local_command',
        }]
      : [];
  }

  const name = text.match(COMMAND_NAME_PATTERN);
  if (!name) return null;

  const commandName = name[1].trim();
  if (!commandName) return [];
  const args = text.match(COMMAND_ARGS_PATTERN)?.[1].trim();

  return [{
    v: HISTORY_VERSION,
    type: 'user_message',
    timestamp,
    content: args ? `${commandName} ${args}` : commandName,
  }];
}

function decodeAssistantRecord(
  record: Record<string, any>,
  state: ClaudeTranscriptDecoderState,
): SessionHistoryEvent[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];

  const timestamp = readTimestamp(record);
  const events: SessionHistoryEvent[] = [];
  let text = '';

  for (const block of content) {
    if (!isRecord(block)) continue;

    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') text += block.text;
        break;

      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking.trim()) {
          events.push({
            v: HISTORY_VERSION,
            type: 'thinking',
            timestamp,
            content: block.thinking,
            ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
          });
        }
        break;

      case 'redacted_thinking':
        events.push({
          v: HISTORY_VERSION,
          type: 'thinking',
          timestamp,
          content: '',
          isRedacted: true,
        });
        break;

      case 'tool_use': {
        const toolName = typeof block.name === 'string' ? block.name : '';
        const toolUseId = typeof block.id === 'string' ? block.id : '';
        if (!toolName || !toolUseId) break;

        const toolKind = mapClaudeToolNameToToolKind(toolName);
        const toolParams = isRecord(block.input) ? block.input : {};
        const toolDisplay = buildToolDisplay(toolName, toolKind, toolParams);
        // Params-only preview (e.g. a diff for an edit) so a call still renders
        // something useful before — or without — its result.
        const synthetic = synthesizeClaudeToolResult(toolKind, toolParams, {});

        state.pendingToolCalls.set(toolUseId, {
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
          ...(toolDisplay !== undefined ? { toolDisplay } : {}),
        });

        events.push({
          v: HISTORY_VERSION,
          type: 'tool_call',
          timestamp,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
          ...(toolDisplay !== undefined ? { toolDisplay } : {}),
          status: 'running',
          ...(synthetic !== undefined ? { toolUseResult: synthetic } : {}),
          toolUseId,
        });
        break;
      }
    }
  }

  // Emitted after the blocks so a tool call that followed the prose still lands
  // in transcript order; the reducer keys tool calls by id, not position.
  if (text.trim()) {
    events.push({
      v: HISTORY_VERSION,
      type: 'assistant_message',
      timestamp,
      content: text,
      ...(typeof record.message?.id === 'string' ? { messageId: record.message.id } : {}),
    });
  }

  return events;
}

function decodeToolResultBlock(
  block: Record<string, any>,
  record: Record<string, any>,
  state: ClaudeTranscriptDecoderState,
  timestamp: string,
  soleToolResult: boolean,
): SessionHistoryEvent | null {
  const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
  if (!toolUseId) return null;

  const isError = block.is_error === true;
  const output = extractOutputString(block.content);
  const pending = state.pendingToolCalls.get(toolUseId);

  // A result whose tool_use never appeared (transcript truncated or resumed
  // mid-turn) still carries real output — surface it rather than dropping it.
  if (!pending) {
    return {
      v: HISTORY_VERSION,
      type: 'tool_call',
      timestamp,
      toolName: 'Tool',
      toolParams: {},
      status: isError ? 'error' : 'completed',
      ...(isError ? { error: output } : { output }),
      toolUseId,
    };
  }

  state.pendingToolCalls.delete(toolUseId);

  // `toolUseResult` sits on the record, not the block, so it can only be
  // attributed when this record carries exactly one tool_result.
  const rawToolUseResult = soleToolResult ? record.toolUseResult : undefined;
  const isImageRead = !isError
    && pending.toolKind === 'file_read'
    && isImagePath(pending.toolParams?.file_path);

  const toolUseResult = rawToolUseResult !== undefined && rawToolUseResult !== null
    ? normalizeToolResult(
        pending.toolKind,
        truncateToolResult(rawToolUseResult, {
          sessionId: state.sessionId,
          toolName: pending.toolName,
        }),
      )
    : isImageRead
      ? buildImageToolResult(state.sessionId, toolUseId)
      : synthesizeClaudeToolResult(pending.toolKind, pending.toolParams, {
          output,
          ...(isError ? { error: output } : {}),
          isError,
        });

  return {
    v: HISTORY_VERSION,
    type: 'tool_call',
    timestamp,
    toolName: pending.toolName,
    ...(pending.toolKind !== undefined ? { toolKind: pending.toolKind } : {}),
    toolParams: pending.toolParams,
    ...(pending.toolDisplay !== undefined ? { toolDisplay: pending.toolDisplay } : {}),
    status: isError ? 'error' : 'completed',
    ...(isError ? { error: output } : { output }),
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
    toolUseId,
  };
}

function decodeUserRecord(
  record: Record<string, any>,
  state: ClaudeTranscriptDecoderState,
): SessionHistoryEvent[] {
  const content = record.message?.content;
  const timestamp = readTimestamp(record);
  const injected = isInjectedUserTurn(record);

  if (typeof content === 'string') {
    if (injected || !content.trim()) return [];
    return decodeLocalCommandText(content, timestamp) ?? [{
      v: HISTORY_VERSION,
      type: 'user_message',
      timestamp,
      content,
      ...(typeof record.uuid === 'string' ? { messageId: record.uuid } : {}),
    }];
  }

  if (!Array.isArray(content)) return [];

  const toolResultCount = content.filter(
    (block) => isRecord(block) && block.type === 'tool_result',
  ).length;

  const events: SessionHistoryEvent[] = [];
  let text = '';

  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === 'tool_result') {
      const event = decodeToolResultBlock(
        block,
        record,
        state,
        timestamp,
        toolResultCount === 1,
      );
      if (event) events.push(event);
      continue;
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }

  if (!injected && text.trim()) {
    const localCommand = decodeLocalCommandText(text, timestamp);
    events.push(...(localCommand ?? [{
      v: HISTORY_VERSION,
      type: 'user_message',
      timestamp,
      content: text,
      ...(typeof record.uuid === 'string' ? { messageId: record.uuid } : {}),
    } satisfies SessionHistoryEvent]));
  }

  return events;
}

/**
 * Decode one transcript line. Returns [] for blank lines, malformed JSON, and
 * every record type the chat view does not render (`mode`, `attachment`,
 * `ai-title`, `file-history-snapshot`, …) — an unrecognized line must never
 * fail the surrounding read.
 */
export function decodeClaudeTranscriptLine(
  line: string,
  state: ClaudeTranscriptDecoderState,
): SessionHistoryEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isRecord(record)) return [];

  // Sidechain records belong to subagent conversations that the main chat view
  // renders through the parent Task tool call, not as top-level messages.
  if (record.isSidechain === true) return [];

  if (record.type === 'assistant') return decodeAssistantRecord(record, state);
  if (record.type === 'user') return decodeUserRecord(record, state);
  return [];
}

/** Decode a whole transcript in order. */
export function decodeClaudeTranscript(
  lines: Iterable<string>,
  sessionId: string,
): SessionHistoryEvent[] {
  const state = createClaudeTranscriptDecoderState(sessionId);
  const events: SessionHistoryEvent[] = [];
  for (const line of lines) {
    events.push(...decodeClaudeTranscriptLine(line, state));
  }
  return events;
}
