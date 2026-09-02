import { useMemo } from 'react';
import { useSubSessionCapStateStore } from '@/stores/sub-session-cap-state-store';
import type { TaskSession } from '@/types/task-entity';

/** Sub-session rows a task shows before the rest collapse behind "show more". */
export const SUB_SESSION_VISIBLE_LIMIT = 5;

/**
 * Caps a task's sub-session list so long-running worktrees don't stretch the
 * card down the whole column. Expansion is keyed by task so a Project change
 * does not reset a list that the user already revealed.
 */
export function useSubSessionCap(taskId: string, sessions: TaskSession[]) {
  const revealed = useSubSessionCapStateStore((state) => state.revealedTaskIds[taskId] ?? false);
  const toggle = useSubSessionCapStateStore((state) => state.toggleRevealed);
  const isCapped = sessions.length > SUB_SESSION_VISIBLE_LIMIT;

  const visibleSessions = useMemo(
    () => (revealed ? sessions : sessions.slice(0, SUB_SESSION_VISIBLE_LIMIT)),
    [sessions, revealed],
  );

  return {
    visibleSessions,
    hiddenCount: sessions.length - visibleSessions.length,
    // Only offer the toggle where it changes something — a task at or under the
    // limit would otherwise show a "show less" that collapses nothing.
    showToggle: isCapped,
    revealed,
    toggle: () => toggle(taskId),
  };
}
