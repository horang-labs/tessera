'use client';

import { useMemo } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { WorkflowMessage } from '@/types/chat';
import { cn } from '@/lib/utils';
import { SINGLE_PANEL_CONTENT_SHELL } from '../single-panel-shell';
import { WorkflowCard } from './workflow-card';

interface WorkflowStatusBarProps {
  sessionId: string;
  isSinglePanel?: boolean;
}

function recencyKey(w: WorkflowMessage): number {
  return Date.parse(w.endedAt || w.timestamp || '') || 0;
}

/**
 * Sticky dynamic-workflow status, docked directly above the composer so it stays
 * visible while the conversation scrolls. Shows every workflow that is currently
 * running PLUS the single most-recently-finished run (so the latest result stays
 * visible after it completes); older finished runs drop out. Reads workflow cards
 * (accumulated from the CLI `task_*` stream) straight from the chat store.
 */
export function WorkflowStatusBar({ sessionId, isSinglePanel }: WorkflowStatusBarProps) {
  const sessionMessages = useChatStore((s) => s.messages.get(sessionId));
  const dismissedIds = useChatStore((s) => s.dismissedWorkflowTaskIds);
  const dismissWorkflowCard = useChatStore((s) => s.dismissWorkflowCard);

  const workflowsToShow = useMemo(() => {
    const all = (sessionMessages ?? []).filter(
      (m): m is WorkflowMessage => m.type === 'workflow',
    );
    // Running cards: show each one the user hasn't individually dismissed.
    const running = all.filter((w) => w.status === 'running' && !dismissedIds.has(w.taskId));

    // Completed slot: the single most-recently-finished run. Pick it across ALL
    // finished runs (not the dismissed-filtered list) so that dismissing the
    // visible card clears the slot, rather than resurfacing an older finished run
    // that had already dropped out of the bar.
    let lastFinished: WorkflowMessage | null = null;
    for (const w of all) {
      if (w.status === 'running') continue;
      if (!lastFinished || recencyKey(w) >= recencyKey(lastFinished)) lastFinished = w;
    }
    const finished = lastFinished && !dismissedIds.has(lastFinished.taskId) ? lastFinished : null;

    return finished ? [...running, finished] : running;
  }, [sessionMessages, dismissedIds]);

  if (workflowsToShow.length === 0) return null;

  return (
    <div className="pt-1.5">
      <div className={cn('w-full', isSinglePanel ? SINGLE_PANEL_CONTENT_SHELL : 'px-4')}>
        <div className="max-h-[40vh] space-y-1 overflow-y-auto">
          {workflowsToShow.map((wf) => (
            <WorkflowCard
              key={wf.taskId}
              message={wf}
              docked
              defaultCollapsed={wf.status !== 'running'}
              onDismiss={dismissWorkflowCard}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
