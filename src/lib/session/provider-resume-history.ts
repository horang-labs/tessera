import { sessionHistory } from '@/lib/session-history';
import type { SessionHistoryEvent } from '@/lib/session-replay-types';

export type SelectProviderResumeHistorySuffix = (
  canonicalEvents: SessionHistoryEvent[],
  providerEvents: SessionHistoryEvent[],
) => SessionHistoryEvent[] | null;

/** Persist a provider-selected history suffix without knowing provider formats. */
export async function mergeProviderResumeHistory(
  sessionId: string,
  providerEvents: SessionHistoryEvent[],
  selectSuffix: SelectProviderResumeHistorySuffix,
): Promise<{ state: 'merged'; appended: number } | { state: 'diverged' }> {
  const canonicalEvents = await sessionHistory.readEvents(sessionId);
  const suffix = selectSuffix(canonicalEvents, providerEvents);
  if (!suffix) return { state: 'diverged' };
  sessionHistory.recordReplayEvents(sessionId, suffix);
  sessionHistory.flushSession(sessionId);
  return { state: 'merged', appended: suffix.length };
}
