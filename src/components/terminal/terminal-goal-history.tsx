'use client';

import { memo, useEffect, useId, useRef, useState } from 'react';
import { ArrowRightLeft, CircleCheck, CircleX, Eraser, History } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PHONE_TOUCH_TARGET } from '@/lib/ui/touch-target';
import { useTerminalGoalHistory } from '@/hooks/use-terminal-goal-history';
import type { TerminalGoalEnding, TerminalGoalHistoryEntry } from '@/types/terminal-goal';
import { formatCompact, formatElapsed, formatGoalTime } from './terminal-goal-format';

/**
 * Goals a PTY session pursued before the current one, so a handoff or review
 * can see what the session was steered toward. Cleared goals leave the banner
 * at once; this is where they remain.
 */

const ENDING_COLOR: Record<TerminalGoalEnding, string> = {
  complete: 'var(--success)',
  failed: 'var(--error)',
  cleared: 'var(--text-muted)',
  replaced: 'var(--text-muted)',
};

function EndingGlyph({ ending }: { ending: TerminalGoalEnding }) {
  const className = 'h-3.5 w-3.5 shrink-0';
  const style = { color: ENDING_COLOR[ending] };
  switch (ending) {
    case 'complete':
      return <CircleCheck aria-hidden="true" className={className} style={style} />;
    case 'failed':
      return <CircleX aria-hidden="true" className={className} style={style} />;
    case 'cleared':
      return <Eraser aria-hidden="true" className={className} style={style} />;
    default:
      return <ArrowRightLeft aria-hidden="true" className={className} style={style} />;
  }
}

function elapsedOf(entry: TerminalGoalHistoryEntry): number {
  return entry.elapsedSeconds ?? (entry.endedAt - entry.setAt) / 1000;
}

export function TerminalGoalHistoryList({
  history,
  className,
}: {
  history: readonly TerminalGoalHistoryEntry[];
  className?: string;
}) {
  const { t, language } = useI18n();
  return (
    <ol className={cn('flex flex-col gap-2', className)} data-testid="terminal-goal-history">
      {history.map((entry) => (
        <li
          key={`${entry.setAt}-${entry.endedAt}`}
          className="flex gap-2"
          data-goal-ending={entry.ending}
          title={entry.objective}
        >
          <span className="mt-0.5"><EndingGlyph ending={entry.ending} /></span>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 break-words leading-snug text-(--text-primary)">
              {entry.objective}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-(--text-muted) tabular-nums">
              <span style={{ color: ENDING_COLOR[entry.ending] }}>
                {t(`terminalGoal.history.ending.${entry.ending}`)}
              </span>
              <span>{formatGoalTime(entry.endedAt, language)}</span>
              <span>{t('terminalGoal.elapsed')} {formatElapsed(elapsedOf(entry))}</span>
              {entry.provider === 'claude-code' && !!entry.iterations && (
                <span>{t('terminalGoal.iterations', { count: entry.iterations })}</span>
              )}
              {entry.tokensUsed !== undefined && (
                <span>{t('terminalGoal.tokens', { value: formatCompact(entry.tokensUsed, language) })}</span>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

const POPOVER_MAX_WIDTH_REM = 24;
const VIEWPORT_GUTTER_PX = 16;

/**
 * Below the button, right-aligned to it, kept inside the viewport. The width
 * is set here too, in rem so it follows the app font scale.
 */
function popoverPosition(anchor: DOMRect): { top: number; left: number; width: number } {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const width = Math.min(POPOVER_MAX_WIDTH_REM * rem, window.innerWidth - VIEWPORT_GUTTER_PX * 2);
  const left = Math.min(
    Math.max(VIEWPORT_GUTTER_PX, anchor.right - width),
    window.innerWidth - VIEWPORT_GUTTER_PX - width,
  );
  return { top: anchor.bottom + 6, left, width };
}

/**
 * Session-header button for the history. Shown only once the session has an
 * ended goal, so sessions that never used `/goal` gain nothing.
 */
export const TerminalGoalHistoryButton = memo(function TerminalGoalHistoryButton({
  sessionId,
}: {
  sessionId: string;
}) {
  const { t } = useI18n();
  const history = useTerminalGoalHistory(sessionId);
  // The button's rect while open. The popover is fixed-positioned from it and
  // clamped to the viewport: right-aligned to the button it would leave the
  // screen on a phone, where the button sits mid-row.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const open = anchor !== null;
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setAnchor(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAnchor(null);
    };
    const close = () => setAnchor(null);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (!history.length) return null;
  const label = open ? t('terminalGoal.history.close') : t('terminalGoal.history.open');

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setAnchor((value) => (
          value ? null : buttonRef.current?.getBoundingClientRect() ?? null
        ))}
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-controls={popoverId}
        data-testid="terminal-goal-history-button"
        className={cn(
          'flex items-center gap-1 rounded p-0.5 text-(--text-muted) transition-colors',
          'hover:bg-(--sidebar-hover) hover:text-(--goal)',
          open && 'bg-(--sidebar-hover) text-(--goal)',
          PHONE_TOUCH_TARGET,
        )}
      >
        <History className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="text-[10px] leading-none tabular-nums">{history.length}</span>
      </button>
      {anchor && (
        <div
          id={popoverId}
          style={popoverPosition(anchor)}
          className={cn(
            'fixed z-50',
            'max-h-[min(60vh,26rem)] overflow-y-auto rounded-md border px-3 py-2.5 text-xs shadow-lg',
            'border-(--chat-header-border) bg-(--chat-bg)',
          )}
          data-testid="terminal-goal-history-popover"
        >
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
            {t('terminalGoal.history.title')}
          </div>
          <TerminalGoalHistoryList history={history} />
        </div>
      )}
    </div>
  );
});
