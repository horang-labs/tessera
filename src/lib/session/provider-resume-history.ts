import { sessionHistory } from '@/lib/session-history';
import type { SessionHistoryEvent } from '@/lib/session-replay-types';

function providerHistoryKey(event: SessionHistoryEvent): string | null {
  if (event.type === 'assistant_message') return `assistant\0${event.content}`;
  if (event.type === 'user_message') {
    const content = typeof event.content === 'string'
      ? event.content
      : event.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    return `user\0${content}`;
  }
  if (event.type === 'tool_call') {
    return `tool\0${JSON.stringify([
      event.toolUseId ?? '',
      event.toolName,
      event.status,
      event.toolParams,
      event.output ?? '',
      event.error ?? '',
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
  const canonicalProviderEvents = canonicalEvents.filter(
    (event) => providerHistoryKey(event) !== null,
  );
  let providerIndex = 0;

  for (const canonicalEvent of canonicalProviderEvents) {
    while (
      providerIndex < providerEvents.length
      && providerHistoryKey(providerEvents[providerIndex]!) === null
    ) {
      providerIndex += 1;
    }
    const providerEvent = providerEvents[providerIndex];
    if (
      !providerEvent
      || providerHistoryKey(providerEvent) !== providerHistoryKey(canonicalEvent)
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
