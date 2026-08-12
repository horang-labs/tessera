import { sessionHistory } from '@/lib/session-history';
import type { SessionHistoryEvent } from '@/lib/session-replay-types';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableToolParams(event: Extract<SessionHistoryEvent, { type: 'tool_call' }>): Record<string, any> {
  // commandActions and processId are app-server display/runtime metadata. They
  // are absent from the durable rollout's function arguments and therefore
  // cannot participate in provider-history identity.
  const { commandActions: _commandActions, processId: _processId, ...stableParams } = event.toolParams;
  return stableParams;
}

function completedInputTranslations(events: SessionHistoryEvent[]): Map<string, string> {
  const translations = new Map<string, string>();
  for (const event of events) {
    if (
      event.type === 'message_translation'
      && (!event.status || event.status === 'completed')
      && typeof event.content === 'string'
    ) {
      translations.set(event.targetMessageId, event.content);
    }
  }
  return translations;
}

function providerHistoryKey(
  event: SessionHistoryEvent,
  inputTranslations: Map<string, string>,
): string | null {
  if (event.type === 'assistant_message') return `assistant\0${event.content}`;
  if (event.type === 'user_message') {
    const content = (event.messageId && inputTranslations.get(event.messageId))
      ?? (typeof event.content === 'string'
      ? event.content
      : event.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'));
    return `user\0${content}`;
  }
  if (event.type === 'tool_call') {
    return `tool\0${stableJson([
      event.toolUseId ?? '',
      event.toolName,
      event.status,
      stableToolParams(event),
    ])}`;
  }
  return null;
}

/**
 * Select only the provider-owned suffix that Tessera did not already record.
 * Tessera-only thinking/status events may sit between provider events, so the
 * prefix comparison filters those out while retaining conversation and tool
 * boundaries. Including tool boundaries makes an interrupted external turn
 * idempotent even when the transcript ends before another message is written.
 */
export function selectProviderResumeHistorySuffix(
  canonicalEvents: SessionHistoryEvent[],
  providerEvents: SessionHistoryEvent[],
): SessionHistoryEvent[] | null {
  const canonicalInputTranslations = completedInputTranslations(canonicalEvents);
  const providerInputTranslations = completedInputTranslations(providerEvents);
  const canonicalProviderEvents = canonicalEvents.filter(
    (event) => providerHistoryKey(event, canonicalInputTranslations) !== null,
  );
  let providerIndex = 0;

  for (const canonicalEvent of canonicalProviderEvents) {
    while (
      providerIndex < providerEvents.length
      && providerHistoryKey(providerEvents[providerIndex]!, providerInputTranslations) === null
    ) {
      providerIndex += 1;
    }
    const providerEvent = providerEvents[providerIndex];
    if (
      !providerEvent
      || providerHistoryKey(providerEvent, providerInputTranslations)
        !== providerHistoryKey(canonicalEvent, canonicalInputTranslations)
    ) {
      return null;
    }
    providerIndex += 1;
  }

  return providerEvents.slice(providerIndex);
}

export async function mergeProviderResumeHistory(
  sessionId: string,
  providerEvents: SessionHistoryEvent[],
): Promise<{ state: 'merged'; appended: number } | { state: 'diverged' }> {
  const canonicalEvents = await sessionHistory.readEvents(sessionId);
  const suffix = selectProviderResumeHistorySuffix(canonicalEvents, providerEvents);
  if (!suffix) return { state: 'diverged' };
  sessionHistory.recordReplayEvents(sessionId, suffix);
  sessionHistory.flushSession(sessionId);
  return { state: 'merged', appended: suffix.length };
}
