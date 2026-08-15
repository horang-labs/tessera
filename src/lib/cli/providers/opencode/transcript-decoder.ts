/**
 * OpenCode session export → SessionHistoryEvent decoder.
 *
 * The export gives whole messages, each carrying an ordered list of parts, so
 * decoding is a flat walk — no line-by-line state, and no call/result pairing:
 * unlike Claude and Codex, an OpenCode tool part holds both its input and its
 * output in one record.
 *
 * `step-start` / `step-finish` mark model-invocation boundaries rather than
 * anything the user asked for, so they are dropped.
 */

import type { SessionHistoryEvent } from '@/lib/session-replay-types';
import type { ToolCallKind } from '@/types/tool-call-kind';
import { inferToolCallKindFromToolName } from '@/types/tool-call-kind';
import { buildToolDisplay } from '@/lib/tool-display';
import { normalizeToolName } from './protocol-parser';
import type {
  OpenCodeExportedMessage,
  OpenCodeExportedPart,
  OpenCodeExportedSession,
} from './transcript-source';

/** Mirrors HISTORY_VERSION in session-history.ts. */
const HISTORY_VERSION = 1;

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  // OpenCode stores epoch milliseconds.
  return new Date(value).toISOString();
}

/**
 * OpenCode reports tool status as pending/running/completed/error; Tessera's
 * replay events only distinguish running / completed / error.
 */
function toToolStatus(status: unknown): 'running' | 'completed' | 'error' {
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'completed') return 'completed';
  return 'running';
}

function decodeToolPart(
  part: OpenCodeExportedPart,
  timestamp: string,
): SessionHistoryEvent | null {
  const toolName = normalizeToolName(part.tool);
  const state = isRecord(part.state) ? part.state : {};
  const status = toToolStatus(state.status);
  const toolParams = isRecord(state.input) ? state.input : {};
  const toolKind: ToolCallKind | undefined = inferToolCallKindFromToolName(toolName);
  const toolDisplay = buildToolDisplay(toolName, toolKind, toolParams);
  const output = typeof state.output === 'string' ? state.output : '';
  const startedAt = isRecord(state.time) ? state.time.start : undefined;

  return {
    v: HISTORY_VERSION,
    type: 'tool_call',
    timestamp: toTimestamp(startedAt, timestamp),
    toolName,
    ...(toolKind !== undefined ? { toolKind } : {}),
    toolParams,
    ...(toolDisplay !== undefined ? { toolDisplay } : {}),
    status,
    ...(status === 'error'
      ? { error: output }
      : output
        ? { output }
        : {}),
    ...(typeof part.callID === 'string' && part.callID ? { toolUseId: part.callID } : {}),
  };
}

function decodeMessage(
  message: OpenCodeExportedMessage,
  fallbackTimestamp: string,
): SessionHistoryEvent[] {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (!parts.length) return [];

  const role = message.info?.role;
  const created = message.info?.time?.created;
  const messageTimestamp = toTimestamp(created, fallbackTimestamp);

  const events: SessionHistoryEvent[] = [];
  let text = '';

  for (const part of parts) {
    if (!isRecord(part)) continue;

    switch (part.type) {
      case 'text':
        if (typeof part.text === 'string') text += part.text;
        break;

      case 'reasoning':
        if (typeof part.text === 'string' && part.text.trim()) {
          events.push({
            v: HISTORY_VERSION,
            type: 'thinking',
            timestamp: toTimestamp(part.time?.start, messageTimestamp),
            content: part.text,
          });
        }
        break;

      case 'tool': {
        const event = decodeToolPart(part, messageTimestamp);
        if (event) events.push(event);
        break;
      }

      // step-start / step-finish are model-invocation bookkeeping, not content.
      default:
        break;
    }
  }

  if (text.trim()) {
    events.push(
      role === 'user'
        ? {
            v: HISTORY_VERSION,
            type: 'user_message',
            timestamp: messageTimestamp,
            content: text,
          }
        : {
            v: HISTORY_VERSION,
            type: 'assistant_message',
            timestamp: messageTimestamp,
            content: text,
          },
    );
  }

  return events;
}

/** Decode an exported OpenCode session into replayable history events. */
export function decodeOpenCodeSession(
  session: OpenCodeExportedSession | null,
): SessionHistoryEvent[] {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  if (!messages.length) return [];

  // Messages without a usable timestamp still need a monotonic one so the
  // reducer keeps transcript order.
  const fallbackBase = Date.now() - messages.length;
  const events: SessionHistoryEvent[] = [];

  messages.forEach((message, index) => {
    if (!isRecord(message)) return;
    events.push(...decodeMessage(message, new Date(fallbackBase + index).toISOString()));
  });

  return events;
}
