import type { Trigger } from './contracts';

export const MAX_LATENESS_MS = 86_400_000;
export function nextScheduledAt(trigger: Trigger, now: number): number | null {
  if (trigger.kind === 'turn-complete') return null;
  if (trigger.kind === 'once') return trigger.at > now ? trigger.at : null;
  return trigger.anchorAt + Math.max(0, Math.floor((now - trigger.anchorAt) / trigger.everyMs) + 1) * trigger.everyMs;
}

export function dueOccurrence(trigger: Trigger, nextDueAt: number | null, now: number, expiresAt: number) {
  if (trigger.kind === 'turn-complete' || nextDueAt === null || nextDueAt > now) return null;
  const coalescedCount = trigger.kind === 'interval' ? Math.floor((now - nextDueAt) / trigger.everyMs) : 0;
  const dueAt = trigger.kind === 'interval' ? nextDueAt + coalescedCount * trigger.everyMs : nextDueAt;
  return {
    occurrenceKey: `${trigger.kind}:${dueAt}`, dueAt,
    deadlineAt: Math.min(dueAt + MAX_LATENESS_MS, expiresAt), coalescedCount,
    nextDueAt: trigger.kind === 'interval' ? dueAt + trigger.everyMs : null,
  };
}
