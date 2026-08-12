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
  // These app-server display/runtime fields are absent from the durable
  // rollout's function arguments and cannot participate in Codex history identity.
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

function codexHistoryKey(
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
 * Select only the Codex-owned suffix that Tessera did not already record.
 * Provider-facing translations and durable rollout tool fields form identity;
 * display-only app-server metadata does not.
 */
export function selectCodexResumeHistorySuffix(
  canonicalEvents: SessionHistoryEvent[],
  providerEvents: SessionHistoryEvent[],
): SessionHistoryEvent[] | null {
  const canonicalInputTranslations = completedInputTranslations(canonicalEvents);
  const providerInputTranslations = completedInputTranslations(providerEvents);
  const canonicalProviderEvents = canonicalEvents.filter(
    (event) => codexHistoryKey(event, canonicalInputTranslations) !== null,
  );
  let providerIndex = 0;

  for (const canonicalEvent of canonicalProviderEvents) {
    while (
      providerIndex < providerEvents.length
      && codexHistoryKey(providerEvents[providerIndex]!, providerInputTranslations) === null
    ) {
      providerIndex += 1;
    }
    const providerEvent = providerEvents[providerIndex];
    if (
      !providerEvent
      || codexHistoryKey(providerEvent, providerInputTranslations)
        !== codexHistoryKey(canonicalEvent, canonicalInputTranslations)
    ) {
      return null;
    }
    providerIndex += 1;
  }

  return providerEvents.slice(providerIndex);
}
