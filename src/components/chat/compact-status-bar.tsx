'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  COMPACT_PROGRESS_STALE_AFTER_MS,
  COMPACT_PROGRESS_TICK_MS,
  computeCompactProgressPercent,
} from '@/lib/chat/compact-progress';
import { SINGLE_PANEL_CONTENT_SHELL } from './single-panel-shell';

interface CompactStatusBarProps {
  sessionId: string;
  isSinglePanel?: boolean;
}

/**
 * Progress for an in-flight context compaction, docked above the composer next
 * to the workflow and todo bars.
 *
 * Compaction is the one long phase where the CLI goes silent — no assistant
 * text, no tool calls, nothing to show the user that the session is still
 * alive. The bar mirrors the Claude Code TUI: same wording, same time-based
 * curve (see `compact-progress.ts`). It appears when the phase opens and
 * disappears when it closes, so a fast compaction may only ever reach ~15%.
 */
export function CompactStatusBar({ sessionId, isSinglePanel }: CompactStatusBarProps) {
  const { t } = useI18n();
  const startedAt = useChatStore((state) => state.compactingStartedAt.get(sessionId));

  // Only the clock is state; the percentage is derived during render, which
  // keeps the curve monotonic without a second source of truth to reset.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === undefined) return;

    const timer = setInterval(() => {
      // Stop ticking for a phase that was never closed (provider died, or a
      // compaction the CLI silently refused) instead of spinning forever.
      if (Date.now() - startedAt > COMPACT_PROGRESS_STALE_AFTER_MS) {
        clearInterval(timer);
        return;
      }
      setNow(Date.now());
    }, COMPACT_PROGRESS_TICK_MS);

    return () => clearInterval(timer);
  }, [startedAt]);

  if (startedAt === undefined) return null;

  const elapsed = now - startedAt;
  if (elapsed > COMPACT_PROGRESS_STALE_AFTER_MS) return null;

  const percent = computeCompactProgressPercent(elapsed);

  return (
    <div className="pt-1.5" data-testid="compact-status-bar">
      <div className={cn('w-full', isSinglePanel ? SINGLE_PANEL_CONTENT_SHELL : 'px-4')}>
        {/* Sized to its content and left-aligned — this is a transient status
            line, not a card that should span the composer. */}
        <section
          aria-label={t('chat.compactingConversation')}
          className="inline-flex max-w-full items-center gap-2 overflow-hidden rounded-lg border border-(--tool-border) bg-(--tool-bg) px-2.5 py-1.5 shadow-sm"
        >
          <Sparkles className="size-3.5 shrink-0 animate-pulse text-(--accent)" />
          <span className="shrink-0 text-xs font-medium text-(--text-primary)">
            {t('chat.compactingConversation')}
          </span>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            data-testid="compact-status-progress"
            className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-(--text-muted)/20"
          >
            <div
              className="h-full rounded-full bg-(--accent) transition-[width] duration-200 ease-linear"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="shrink-0 tabular-nums text-[10px] text-(--text-muted)">
            {percent}%
          </span>
        </section>
      </div>
    </div>
  );
}
