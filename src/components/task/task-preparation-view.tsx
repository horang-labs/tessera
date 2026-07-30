'use client';

/**
 * What a preparation badge opens.
 *
 * A run still in flight gets the live terminal, attached to the PTY the server
 * started with no surface — leaving here detaches the surface and leaves the run
 * alone. A run that has ended has no PTY left to attach to, so what it printed
 * is read back from the task instead.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { TerminalPanel } from '@/components/terminal/terminal-panel';
import { TabIdContext } from '@/stores/panel-store';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { useI18n } from '@/lib/i18n';
import { useWorktreePreparation } from '@/hooks/use-worktree-preparation';
import logger from '@/lib/logger';
import { getPreparationTerminalId } from '@/lib/projects/preparation-terminal-id';
import {
  resolvePreparationBadge,
  type PreparationStatus,
} from '@/lib/projects/preparation-status-policy';

const PREPARATION_TAB_ID = 'worktree-preparation';
const PREPARATION_PANEL_ID = 'worktree-preparation-panel';

interface StoredPreparation {
  status: PreparationStatus;
  exitCode: number | null;
  output: string | null;
}

interface TaskPreparationViewProps {
  taskId: string;
  /**
   * The run's status right now. A run that ends while this is open keeps the
   * view open on what it left behind — closing it is the reader's to do.
   */
  status: PreparationStatus;
  onOpenChange: (open: boolean) => void;
}

export function TaskPreparationView({ taskId, status, onOpenChange }: TaskPreparationViewProps) {
  const { t } = useI18n();
  const isRunning = status === 'running';
  const description = isRunning
    ? t('task.preparation.runningDescription')
    : status === 'failed'
      ? t('task.preparation.failedDescription')
      : t('task.preparation.succeededDescription');

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[32rem] max-h-[80vh] w-[min(56rem,92vw)] max-w-none flex-col p-0"
        data-testid="task-preparation-view"
      >
        <div className="px-5 pt-5">
          <DialogHeader onClose={() => onOpenChange(false)}>
            <DialogTitle>{t('task.preparation.title')}</DialogTitle>
            <p className="mt-1 text-xs text-(--text-muted)">{description}</p>
          </DialogHeader>
        </div>

        {isRunning ? (
          <div className="min-h-0 flex-1 overflow-hidden px-5 pb-5">
            <TabIdContext.Provider value={PREPARATION_TAB_ID}>
              <TerminalPanel
                panelId={PREPARATION_PANEL_ID}
                terminalId={getPreparationTerminalId(taskId)}
                terminalSessionId={null}
                surfaceActive
                detachOnUnmount
              />
            </TabIdContext.Provider>
          </div>
        ) : (
          <FinishedRun taskId={taskId} onRerun={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FinishedRun({ taskId, onRerun }: { taskId: string; onRerun: () => void }) {
  const { t } = useI18n();
  const { runPreparation } = useWorktreePreparation();
  const [stored, setStored] = useState<StoredPreparation | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithClientId(
          `/api/tasks/${encodeURIComponent(taskId)}/preparation`,
        );
        if (!response.ok) return;
        const data = await response.json() as { preparation: StoredPreparation };
        if (!cancelled) setStored(data.preparation);
      } catch (error) {
        logger.warn({ error, taskId }, 'Could not read the preparation output');
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  const rerun = useCallback(async () => {
    setIsStarting(true);
    try {
      if (await runPreparation(taskId)) onRerun();
    } finally {
      setIsStarting(false);
    }
  }, [onRerun, runPreparation, taskId]);

  const output = stored?.output?.trim();
  // No exit code on a failed run means no process was ever waited on: the app
  // went away mid-run rather than the script reporting anything.
  const wasInterrupted = stored?.status === 'failed' && stored.exitCode === null;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto px-5">
        <pre className="whitespace-pre-wrap break-words rounded-md bg-(--terminal-bg,--sidebar-hover) p-3 font-mono text-xs leading-relaxed text-(--text-primary)">
          {wasInterrupted
            ? t('task.preparation.interrupted')
            : output || t('task.preparation.noOutput')}
        </pre>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-(--divider) px-5 py-3">
        <span className="text-xs text-(--text-muted)">
          {stored?.exitCode === null || stored?.exitCode === undefined
            ? null
            : t('task.preparation.exitCode', { code: stored.exitCode })}
        </span>
        <button
          type="button"
          onClick={() => void rerun()}
          disabled={isStarting}
          className="inline-flex items-center gap-1.5 rounded-md bg-(--accent) px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          data-testid="task-preparation-rerun"
        >
          {isStarting
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="h-3.5 w-3.5" />}
          {isStarting ? t('task.preparation.rerunning') : t('task.preparation.rerun')}
        </button>
      </div>
    </>
  );
}

/**
 * The badge itself: work in flight, or a failure waiting to be dealt with.
 * A worktree that prepared successfully carries no badge at all.
 *
 * `presentation` is how much of the badge a surface has room for. A dense list
 * row only has space for the icon; a card can carry the words too. Both open
 * the run — a badge that says something is wrong and cannot be pressed leaves
 * the user nowhere to go.
 */
export function TaskPreparationBadge({
  taskId,
  status,
  presentation = 'label',
}: {
  taskId: string;
  status: PreparationStatus | undefined;
  presentation?: 'label' | 'icon';
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);

  const current = status ?? 'never_run';
  const badge = resolvePreparationBadge(current);
  // A run that succeeds while its view is open takes the badge away, but not
  // the view: what the reader opened stays until they close it.
  if (!badge && !isOpen) return null;

  const isRunning = badge === 'running';
  const label = isRunning ? t('task.preparation.preparing') : t('task.preparation.failed');
  const icon = isRunning
    ? <Loader2 className="h-3 w-3 animate-spin" />
    : <AlertTriangle className="h-3 w-3" />;
  const tone = isRunning
    ? 'inline-flex items-center gap-1 text-[0.6875rem] text-(--text-muted)'
    : 'inline-flex items-center gap-1 text-[0.6875rem] text-(--error)';

  return (
    <>
      {badge ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            setIsOpen(true);
          }}
          title={label}
          aria-label={label}
          className={`${tone} ${isRunning ? 'hover:text-(--text-primary)' : 'hover:opacity-80'}`}
          data-testid="task-preparation-badge"
          data-preparation-status={status}
        >
          {icon}
          {presentation === 'label' ? <span>{label}</span> : null}
        </button>
      ) : null}

      {isOpen ? (
        <TaskPreparationView taskId={taskId} status={current} onOpenChange={setIsOpen} />
      ) : null}
    </>
  );
}
