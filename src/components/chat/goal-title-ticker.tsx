'use client';

import { useCallback } from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useTerminalGoalStore } from '@/stores/terminal-goal-store';

/** The objective of the first session here that is working toward a goal. */
function useActiveGoalObjective(sessionIds: readonly string[]): string | null {
  const key = sessionIds.join('\u0000');
  return useTerminalGoalStore(useCallback((state) => {
    for (const sessionId of key ? key.split('\u0000') : []) {
      const goal = state.bySessionId[sessionId];
      if (goal?.status === 'active') return goal.objective;
    }
    return null;
  }, [key]));
}

/**
 * The goal a session is working toward, scrolling past beside its title.
 *
 * `inline` takes only the room the title leaves on its row, so the title
 * never gets shorter because of it; with no room left it hides itself.
 * `line` sits on its own line under a multi-line title (Kanban cards).
 */
export function GoalTitleTicker({
  sessionIds,
  variant,
  className,
}: {
  sessionIds: readonly string[];
  variant: 'inline' | 'line';
  className?: string;
}) {
  const { t } = useI18n();
  const objective = useActiveGoalObjective(sessionIds);
  if (!objective) return null;
  // Same reading speed whatever the length: about five characters a second.
  const seconds = Math.min(60, Math.max(8, objective.length / 5));
  return (
    <span
      className={cn('goal-ticker', variant === 'inline' ? 'min-w-0 flex-1' : 'block', className)}
      title={objective}
      aria-label={`${t('terminalGoal.label')}: ${objective}`}
      data-testid="goal-title-ticker"
    >
      <span
        className="goal-ticker-track"
        aria-hidden="true"
        style={{ ['--goal-ticker-duration' as string]: `${seconds}s` }}
      >
        <span className="goal-ticker-item">{objective}</span>
        <span className="goal-ticker-item">{objective}</span>
      </span>
    </span>
  );
}

/** Whether any of these sessions has a goal the ticker would show. */
export function useHasActiveGoalObjective(sessionIds: readonly string[]): boolean {
  return useActiveGoalObjective(sessionIds) !== null;
}
