import { useMemo, useState } from 'react';
import type { TaskSession } from '@/types/task-entity';

/** Sub-session rows a task shows before the rest collapse behind "show more". */
export const SUB_SESSION_VISIBLE_LIMIT = 5;

/**
 * Caps a task's sub-session list so long-running worktrees don't stretch the
 * card down the whole column. Deliberately unpersisted: the cap comes back on
 * remount, which is what keeps the list from creeping back to full height.
 */
export function useSubSessionCap(sessions: TaskSession[]) {
  const [revealed, setRevealed] = useState(false);
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
    toggle: () => setRevealed((current) => !current),
  };
}
