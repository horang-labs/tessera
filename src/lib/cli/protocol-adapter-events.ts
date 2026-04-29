import logger from '../logger';
import type { SessionReplayEvent } from '../session-replay-types';
import type { AppServerMessage, ModelUsageEntry } from '../ws/message-types';
import type { CliMessage } from './types';

const PROTOCOL_TYPED_PROGRESS_TYPES = [
  'bash_progress',
  'agent_progress',
  'mcp_progress',
  'waiting_for_task',
  'search_results_received',
  'query_update',
] as const;

const PROTOCOL_RELEVANT_PROGRESS_HOOKS = ['BeforeToolCall', 'AfterToolCall', 'Start', 'Stop'] as const;
const TASK_COMPLETED_MESSAGE = 'Task completed.';
const COMPLETION_PREVIEW_LENGTH = 50;

type NotificationMessage = Extract<AppServerMessage, { type: 'notification' }>;
type NotificationUsage = NonNullable<NotificationMessage['usage']>;

/**
 * Pick the primary model from CLI's modelUsage map.
 *
 * Preferred path (`assistantModelHint`): match the bare model id reported in
 * the latest assistant message (e.g. "claude-opus-4-6") against modelUsage
 * keys that may carry suffixes like "[1m]". This is reliable across mid-
 * session model changes because the hint reflects the model that produced
 * the just-completed turn.
 *
 * Fallback (no hint): pick the entry with the largest outputTokens. This is
 * unreliable if modelUsage accumulates across the session — a session that
 * started on a secondary model could keep that model "ahead" forever — so
 * callers should always provide the hint when possible.
 */
export function pickPrimaryModelName(
  modelUsage: Record<string, any>,
  assistantModelHint?: string | null,
): string | undefined {
  const keys = Object.keys(modelUsage);
  if (keys.length === 0) return undefined;
  if (assistantModelHint) {
    const hint = assistantModelHint.trim();
    // Exact match wins over the bracketed variant. Otherwise, when both
    // "claude-opus-4-7[1m]" and "claude-opus-4-7" exist (e.g. after a model
    // switch), find() would surface the [1m] entry first via the prefix
    // fallback even though the user is now on the bare model.
    const exact = keys.find((k) => k === hint);
    if (exact) return exact;
    const bracketed = keys.find((k) => k.startsWith(`${hint}[`));
    if (bracketed) return bracketed;
  }
  if (keys.length === 1) return keys[0];
  return keys.reduce((best, key) =>
    (modelUsage[key]?.outputTokens ?? 0) > (modelUsage[best]?.outputTokens ?? 0) ? key : best,
  );
}

export interface ParsedProtocolResult {
  resultText: string;
  usage: Record<string, any>;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  costUsd?: number;
  modelUsageRaw: Record<string, any>;
  primaryModelName?: string;
  contextWindowSize?: number;
  maxOutputTokens?: number;
  isError: boolean;
}

export function buildProtocolSystemReplayEvent(
  sessionId: string,
  msg: CliMessage,
  liveEventVersion: number,
): SessionReplayEvent | null {
  const raw = msg as any;
  const subtype = raw.subtype as string | undefined;

  const metadata: Record<string, any> = {};
  if (subtype === 'api_error') {
    metadata.error = raw.error;
    metadata.retryInMs = raw.retryInMs;
    metadata.retryAttempt = raw.retryAttempt;
    metadata.maxRetries = raw.maxRetries;
  } else if (subtype === 'turn_duration') {
    metadata.durationMs = raw.durationMs;
  } else if (subtype === 'stop_hook_summary') {
    metadata.hookCount = raw.hookCount;
    metadata.hookInfos = raw.hookInfos;
    metadata.hookErrors = raw.hookErrors;
  } else if (subtype === 'compact_boundary') {
    metadata.compactMetadata = raw.compact_metadata || raw.compactMetadata;
  }

  const messageText = raw.content || raw.message?.text || raw.message?.content;
  if (!messageText && !subtype) {
    const rawString = JSON.stringify(msg);
    logger.warn({
      sessionId,
      msgKeys: Object.keys(msg).join(','),
      rawPreview: rawString.length > 300 ? `${rawString.slice(0, 300)}...` : rawString,
    }, 'System message without text or subtype');
    return null;
  }

  const severity: 'info' | 'warning' | 'error' =
    subtype === 'api_error' ? 'error'
    : raw.level === 'error' ? 'error'
    : raw.level === 'warning' ? 'warning'
    : typeof messageText === 'string' && (messageText.toLowerCase().includes('error') || messageText.toLowerCase().includes('failed')) ? 'error'
    : typeof messageText === 'string' && (messageText.toLowerCase().includes('warning') || messageText.toLowerCase().includes('context')) ? 'warning'
    : 'info';

  const event: SessionReplayEvent = {
    v: liveEventVersion,
    type: 'system',
    timestamp: new Date().toISOString(),
    message: typeof messageText === 'string' ? messageText : JSON.stringify(messageText || ''),
    severity,
    subtype,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };

  logger.info({
    sessionId,
    severity,
    subtype,
    message: event.message.substring(0, 50),
  }, 'System message sent');

  return event;
}

export function buildTypedProtocolProgressReplayEvent(
  sessionId: string,
  msg: CliMessage,
  liveEventVersion: number,
): SessionReplayEvent | null {
  const dataType = (msg as any).data?.type;
  if (!dataType || !PROTOCOL_TYPED_PROGRESS_TYPES.includes(dataType)) {
    return null;
  }

  logger.debug({ sessionId, progressType: dataType }, 'Typed progress sent');

  return {
    v: liveEventVersion,
    type: 'progress_hook',
    timestamp: new Date().toISOString(),
    hookEvent: dataType,
    progressType: dataType,
    data: (msg as any).data,
  };
}

export function buildProtocolProgressHookReplayEvent(
  sessionId: string,
  hookEvent: string,
  data: any,
  liveEventVersion: number,
): SessionReplayEvent | null {
  if (!PROTOCOL_RELEVANT_PROGRESS_HOOKS.includes(hookEvent as (typeof PROTOCOL_RELEVANT_PROGRESS_HOOKS)[number])) {
    logger.debug({ sessionId, hookEvent }, 'Ignoring non-relevant hook');
    return null;
  }

  const hookData: Record<string, any> = {};
  if (hookEvent === 'BeforeToolCall' || hookEvent === 'AfterToolCall') {
    hookData.toolName = data.toolName || data.tool_name;
    hookData.step = hookEvent === 'BeforeToolCall' ? 'starting' : 'completed';
  } else if (hookEvent === 'Start') {
    hookData.action = 'Task started';
  } else if (hookEvent === 'Stop') {
    hookData.action = 'Task completed';
  }

  logger.debug({
    sessionId,
    hookEvent,
    dataKeys: Object.keys(hookData),
  }, 'Progress hook sent');

  return {
    v: liveEventVersion,
    type: 'progress_hook',
    timestamp: new Date().toISOString(),
    hookEvent,
    data: hookData,
  };
}

export function buildCompletionPreview(lastAssistantMessage?: string): string {
  const preview = lastAssistantMessage?.substring(0, COMPLETION_PREVIEW_LENGTH) || '';
  return preview + (
    lastAssistantMessage && lastAssistantMessage.length > COMPLETION_PREVIEW_LENGTH
      ? '...'
      : ''
  );
}

export function buildCompletionNotification(
  sessionId: string,
  lastAssistantMessage?: string,
  usage?: NotificationUsage,
): NotificationMessage {
  return {
    type: 'notification',
    sessionId,
    event: 'completed',
    message: TASK_COMPLETED_MESSAGE,
    preview: buildCompletionPreview(lastAssistantMessage),
    usage,
  };
}

export function parseProtocolResult(msg: CliMessage): ParsedProtocolResult {
  const raw = msg as any;
  const usage = raw.usage || msg.message?.usage || {};
  const modelUsageRaw = raw.modelUsage || {};
  const primaryModelName = pickPrimaryModelName(modelUsageRaw);

  return {
    resultText: raw.result || '',
    usage,
    durationMs: raw.duration_ms || msg.message?.duration_ms,
    durationApiMs: raw.duration_api_ms || msg.message?.duration_api_ms,
    numTurns: raw.num_turns || msg.message?.num_turns,
    costUsd: raw.total_cost_usd || msg.message?.total_cost_usd,
    modelUsageRaw,
    primaryModelName,
    contextWindowSize: primaryModelName ? modelUsageRaw[primaryModelName].contextWindow : undefined,
    maxOutputTokens: primaryModelName ? modelUsageRaw[primaryModelName].maxOutputTokens : undefined,
    isError: Boolean(raw.is_error),
  };
}

export function buildModelUsageEntries(
  modelUsageRaw: Record<string, any>,
): ModelUsageEntry[] | undefined {
  const entries = Object.entries(modelUsageRaw).map(([model, raw]) => ({
    model,
    inputTokens: raw?.inputTokens ?? 0,
    outputTokens: raw?.outputTokens ?? 0,
    cacheReadInputTokens: raw?.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: raw?.cacheCreationInputTokens ?? 0,
    webSearchRequests: raw?.webSearchRequests ?? 0,
    costUSD: raw?.costUSD ?? 0,
    contextWindow: raw?.contextWindow,
    maxOutputTokens: raw?.maxOutputTokens,
  }));
  return entries.length > 0 ? entries : undefined;
}

export function buildProtocolResultTextReplayEvent(
  resultText: string,
  hasStreamedText: boolean,
  liveEventVersion: number,
): SessionReplayEvent | null {
  if (typeof resultText !== 'string' || !resultText.trim() || hasStreamedText) {
    return null;
  }

  return {
    v: liveEventVersion,
    type: 'assistant_message_chunk',
    timestamp: new Date().toISOString(),
    content: resultText,
  };
}

export function buildProtocolResultUsage(result: ParsedProtocolResult): NotificationUsage {
  return {
    inputTokens: result.usage.input_tokens || 0,
    outputTokens: result.usage.output_tokens || 0,
    cacheReadTokens: result.usage.cache_read_input_tokens || 0,
    cacheCreationTokens: result.usage.cache_creation_input_tokens || 0,
    cacheCreationEphemeral5m: result.usage.cache_creation?.ephemeral_5m_input_tokens,
    cacheCreationEphemeral1h: result.usage.cache_creation?.ephemeral_1h_input_tokens,
    durationMs: result.durationMs || 0,
    durationApiMs: result.durationApiMs || 0,
    numTurns: result.numTurns || 0,
    costUsd: result.costUsd || 0,
    serviceTier: result.usage.service_tier || undefined,
    inferenceGeo: result.usage.inference_geo || undefined,
    serverToolUse: result.usage.server_tool_use ? {
      webSearchRequests: result.usage.server_tool_use.web_search_requests || 0,
      webFetchRequests: result.usage.server_tool_use.web_fetch_requests || 0,
    } : undefined,
    speed: result.usage.speed || undefined,
    contextWindowSize: result.contextWindowSize || undefined,
    maxOutputTokens: result.maxOutputTokens || undefined,
    modelUsage: buildModelUsageEntries(result.modelUsageRaw),
  };
}
