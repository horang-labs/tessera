'use client';

import { memo, useEffect, useId, useState } from 'react';
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Gauge,
  OctagonPause,
  Pause,
  Timer,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useTerminalGoalHistory } from '@/hooks/use-terminal-goal-history';
import { selectVisibleTerminalGoal, useTerminalGoalStore } from '@/stores/terminal-goal-store';
import type { TerminalGoalSnapshot, TerminalGoalStatus } from '@/types/terminal-goal';
import { formatCompact, formatElapsed } from './terminal-goal-format';
import { TerminalGoalHistoryList } from './terminal-goal-history';

/**
 * The `/goal` a PTY session is pursuing, shown as a strip above the terminal.
 *
 * The TUI owns the screen below, so the goal cannot be drawn inside it. The
 * strip has a fixed height and the details open as an overlay, so the PTY is
 * resized only when a goal appears or is dismissed — never while it updates.
 */

type Tone = 'goal' | 'warning' | 'success' | 'error';

const STATUS_TONE: Record<TerminalGoalStatus, Tone> = {
  active: 'goal',
  paused: 'warning',
  stalled: 'warning',
  blocked: 'warning',
  usage_limited: 'warning',
  budget_limited: 'warning',
  complete: 'success',
  failed: 'error',
};

const TONE_VAR: Record<Tone, string> = {
  goal: 'var(--goal)',
  warning: 'var(--warning)',
  success: 'var(--success)',
  error: 'var(--error)',
};

/**
 * Seconds spent on the goal. Codex reports time used up to `updatedAt` and
 * keeps counting while active; Claude reports a total only once the goal ends.
 */
function goalElapsedSeconds(goal: TerminalGoalSnapshot, now: number): number {
  if (goal.status === 'active') {
    if (goal.elapsedSeconds !== undefined) {
      return goal.elapsedSeconds + Math.max(0, (now - goal.updatedAt) / 1000);
    }
    return (now - goal.setAt) / 1000;
  }
  if (goal.elapsedSeconds !== undefined) return goal.elapsedSeconds;
  return (goal.updatedAt - goal.setAt) / 1000;
}

/** Re-renders every second while `enabled`. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function GoalStatusGlyph({ status }: { status: TerminalGoalStatus }) {
  if (status === 'active') {
    return <span aria-hidden="true" className="goal-orbit h-3.5 w-3.5 shrink-0" />;
  }
  const className = 'h-3.5 w-3.5 shrink-0';
  const style = { color: TONE_VAR[STATUS_TONE[status]] };
  switch (status) {
    case 'complete':
      return <CircleCheck aria-hidden="true" className={className} style={style} />;
    case 'failed':
      return <CircleX aria-hidden="true" className={className} style={style} />;
    case 'paused':
      return <Pause aria-hidden="true" className={className} style={style} />;
    case 'blocked':
      return <OctagonPause aria-hidden="true" className={className} style={style} />;
    case 'stalled':
      return <TriangleAlert aria-hidden="true" className={className} style={style} />;
    default:
      return <Gauge aria-hidden="true" className={className} style={style} />;
  }
}

export const TerminalGoalBanner = memo(function TerminalGoalBanner({
  sessionId,
}: {
  sessionId: string;
}) {
  const goal = useTerminalGoalStore(selectVisibleTerminalGoal(sessionId));
  if (!goal) return null;
  // Keyed by goal identity so a new goal starts collapsed.
  return <TerminalGoalStrip key={goal.setAt} sessionId={sessionId} goal={goal} />;
});

function TerminalGoalStrip({
  sessionId,
  goal,
}: {
  sessionId: string;
  goal: TerminalGoalSnapshot;
}) {
  const { t, language } = useI18n();
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const dismiss = useTerminalGoalStore((state) => state.dismiss);
  const allHistory = useTerminalGoalHistory(sessionId, expanded);
  // An achieved goal is already in the history; the strip shows it above.
  const history = allHistory.filter((entry) => (
    entry.setAt !== goal.setAt || entry.provider !== goal.provider
  ));
  const isActive = goal.status === 'active';
  const ended = goal.status === 'complete' || goal.status === 'failed';
  const now = useNow(isActive);
  const tone = STATUS_TONE[goal.status];
  const toneColor = TONE_VAR[tone];
  const statusLabel = t(`terminalGoal.status.${goal.status}`);
  const elapsed = formatElapsed(goalElapsedSeconds(goal, now));
  const budgetRatio = goal.tokenBudget && goal.tokensUsed !== undefined
    ? Math.min(1, goal.tokensUsed / goal.tokenBudget)
    : null;
  const tokensLabel = goal.tokensUsed === undefined
    ? null
    : goal.tokenBudget
      ? t('terminalGoal.tokensOfBudget', {
          used: formatCompact(goal.tokensUsed, language),
          budget: formatCompact(goal.tokenBudget, language),
        })
      : t('terminalGoal.tokens', { value: formatCompact(goal.tokensUsed, language) });
  const iterationsLabel = goal.provider === 'claude-code' && goal.iterations
    ? t('terminalGoal.iterations', { count: goal.iterations })
    : null;

  return (
    <div
      className="relative z-20 shrink-0"
      data-testid="terminal-goal-banner"
      data-goal-status={goal.status}
      data-goal-provider={goal.provider}
      style={{ ['--goal-tone' as string]: toneColor }}
    >
      <div
        className={cn(
          'relative flex h-8 items-center gap-2 overflow-hidden border-b px-3 text-xs',
          'border-[color-mix(in_srgb,var(--goal-tone)_22%,var(--chat-header-border))]',
          'bg-[linear-gradient(90deg,color-mix(in_srgb,var(--goal-tone)_13%,var(--chat-bg))_0%,color-mix(in_srgb,var(--goal-tone)_4%,var(--chat-bg))_55%,var(--chat-bg)_100%)]',
        )}
      >
        {isActive && <span aria-hidden="true" className="goal-banner-sheen" />}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={expanded ? t('terminalGoal.collapse') : t('terminalGoal.expand')}
          title={goal.objective}
          onClick={() => setExpanded((value) => !value)}
          data-testid="terminal-goal-toggle"
        >
          <GoalStatusGlyph status={goal.status} />
          <span
            className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: toneColor }}
          >
            {t('terminalGoal.label')}
          </span>
          <span
            className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium leading-4"
            style={{
              color: toneColor,
              backgroundColor: `color-mix(in srgb, ${toneColor} 14%, transparent)`,
            }}
            data-testid="terminal-goal-status"
          >
            {statusLabel}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-(--text-primary)"
            data-testid="terminal-goal-objective"
          >
            {goal.objective}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-2.5 text-(--text-muted) tabular-nums">
          {iterationsLabel && <span className="max-sm:hidden">{iterationsLabel}</span>}
          {tokensLabel && (
            <span className="flex items-center gap-1.5 max-md:hidden" data-testid="terminal-goal-tokens">
              {budgetRatio !== null && (
                <span className="h-1 w-10 overflow-hidden rounded-full bg-(--text-muted)/20">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${budgetRatio * 100}%`, backgroundColor: toneColor }}
                  />
                </span>
              )}
              {tokensLabel}
            </span>
          )}
          <span className="flex items-center gap-1" title={t('terminalGoal.elapsed')} data-testid="terminal-goal-elapsed">
            <Timer aria-hidden="true" className="h-3 w-3" />
            {elapsed}
          </span>
          <button
            type="button"
            className="rounded p-0.5 hover:bg-(--text-muted)/15"
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={expanded ? t('terminalGoal.collapse') : t('terminalGoal.expand')}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')}
            />
          </button>
          {ended && (
            <button
              type="button"
              className="rounded p-0.5 hover:bg-(--text-muted)/15"
              aria-label={t('terminalGoal.dismiss')}
              onClick={() => dismiss(sessionId, goal.setAt)}
              data-testid="terminal-goal-dismiss"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div
          id={detailsId}
          className={cn(
            'absolute inset-x-0 top-full max-h-[min(50vh,22rem)] overflow-y-auto border-b px-4 py-3 text-xs shadow-lg',
            'border-[color-mix(in_srgb,var(--goal-tone)_22%,var(--chat-header-border))] bg-(--chat-bg)',
          )}
          data-testid="terminal-goal-details"
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
            {t('terminalGoal.objective')}
          </div>
          <p className="whitespace-pre-wrap break-words leading-relaxed text-(--text-primary)">
            {goal.objective}
          </p>
          {goal.lastReason && (
            <>
              <div className="mt-3 mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
                {t('terminalGoal.lastReason')}
              </div>
              <p
                className="whitespace-pre-wrap break-words border-l-2 pl-2 leading-relaxed text-(--text-secondary)"
                style={{ borderColor: toneColor }}
              >
                {goal.lastReason}
              </p>
            </>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-(--text-muted) tabular-nums">
            <span style={{ color: toneColor }}>{statusLabel}</span>
            <span>{t('terminalGoal.elapsed')} {elapsed}</span>
            {iterationsLabel && <span>{iterationsLabel}</span>}
            {tokensLabel && <span>{tokensLabel}</span>}
          </div>
          <p className="mt-2 text-[11px] text-(--text-muted)">
            {goal.provider === 'claude-code' ? t('terminalGoal.hintClaude') : t('terminalGoal.hintCodex')}
          </p>
          {history.length > 0 && (
            <>
              <div className="mt-4 mb-2 border-t border-(--chat-header-border) pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
                {t('terminalGoal.history.title')}
              </div>
              <TerminalGoalHistoryList history={history} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
