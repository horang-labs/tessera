'use client';

/**
 * The scripts a worktree runs, and what they left behind.
 *
 * One row per script, because a worktree is going to have more than one of
 * them: preparation now, a dev server and an archive script later. The rows
 * differ in a way worth naming — preparation and archive run once and leave a
 * stored log, while a dev server keeps running and has a live one — so a row
 * says which kind it is and the log area follows from that.
 *
 * This is where a run stays reachable after it ends. The sidebar badge is only
 * a pointer here, and a successful run has no badge at all.
 */

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Minus,
  Pencil,
  RefreshCw,
  ScrollText,
} from 'lucide-react';
import { TerminalPanel } from '@/components/terminal/terminal-panel';
import { TabIdContext } from '@/stores/panel-store';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { useI18n } from '@/lib/i18n';
import { useWorktreePreparation } from '@/hooks/use-worktree-preparation';
import logger from '@/lib/logger';
import { getPreparationTerminalId } from '@/lib/projects/preparation-terminal-id';
import { toPlainLogText } from '@/lib/terminal/plain-log-text';
import {
  canRerunPreparation,
  type PreparationStatus,
} from '@/lib/projects/preparation-status-policy';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { cn } from '@/lib/utils';

const PREPARATION_TAB_ID = 'worktree-preparation';
const PREPARATION_PANEL_ID = 'worktree-preparation-panel';

interface StoredPreparation {
  status: PreparationStatus;
  exitCode: number | null;
  output: string | null;
  /** What this run ran, with Tessera's variables already expanded. */
  script: string | null;
}

/**
 * Whether this session's worktree has scripts to show at all.
 *
 * A chat that owns no worktree has nothing to run, so the tab stays away
 * rather than standing there empty.
 */
export function useWorktreeScriptsAvailable(sessionId: string | null): boolean {
  return useTaskStore((state) => {
    if (!sessionId) return false;
    return Boolean(state.getTaskBySessionId(sessionId)?.workDir);
  });
}

export function WorktreeScriptsPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const task = useTaskStore((state) => (
    sessionId ? state.getTaskBySessionId(sessionId) : undefined
  ));

  if (!task) {
    return (
      <p className="px-3 py-4 text-xs text-(--text-muted)" data-testid="worktree-scripts-empty">
        {t('scripts.noWorktree')}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="worktree-scripts-panel">
      <PreparationRow
        taskId={task.id}
        projectId={task.projectId}
        status={task.preparationStatus ?? 'never_run'}
      />
    </div>
  );
}

/**
 * The preparation row: its status, what it printed, and a way to run it again.
 *
 * A run in flight is watched through the terminal the server started for it; a
 * run that has ended has no terminal left, so what it printed is read back
 * from the task. Both live in the same place, which is the point.
 */
function PreparationRow({
  taskId,
  projectId,
  status,
}: {
  taskId: string;
  projectId: string;
  status: PreparationStatus;
}) {
  const { t } = useI18n();
  const { requestPreparation, preparationConfirmDialog } = useWorktreePreparation();
  const openSettings = useSettingsStore((state) => state.open);
  const [stored, setStored] = useState<StoredPreparation | null>(null);
  // "Nothing to read yet" and "the run printed nothing" look the same in the
  // stored value and read very differently to someone waiting for a log.
  const [isReading, setIsReading] = useState(true);

  const isRunning = status === 'running';

  // Re-read on every status change: a run records its script as it starts, so
  // this is what puts the script on screen while the run is still going, and
  // what replaces the previous run's log with the one that just finished.
  useEffect(() => {
    let cancelled = false;
    setIsReading(true);
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
      } finally {
        if (!cancelled) setIsReading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [taskId, status]);

  // Stored output is what the PTY emitted, escape sequences and all; without
  // a terminal to read them, they have to be flattened first.
  const output = stored?.output ? toPlainLogText(stored.output) : '';
  // No exit code on a failed run means no process was ever waited on: the app
  // went away mid-run rather than the script reporting anything.
  const wasInterrupted = stored?.status === 'failed' && stored.exitCode === null;
  const canRerun = canRerunPreparation(status);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-(--divider) px-3 py-2">
        <StatusMark status={status} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium text-(--text-primary)">
            {t('scripts.preparation.name')}
          </span>
          <span className="truncate text-[10px] text-(--text-tertiary)">
            {t(`scripts.preparation.status.${status}`)}
            {!isRunning && !isReading && stored?.exitCode !== null && stored?.exitCode !== undefined
              ? ` · ${t('task.preparation.exitCode', { code: stored.exitCode })}`
              : ''}
          </span>
        </div>
        {/* Reading a script and wanting to change it is the same moment, so the
            way to its editor is here rather than back through the menus. */}
        <button
          type="button"
          onClick={() => openSettings({ section: 'project', projectId })}
          title={t('scripts.editScript')}
          aria-label={t('scripts.editScript')}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-(--input-border) text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
          data-testid="worktree-scripts-edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => requestPreparation(taskId)}
          disabled={!canRerun}
          title={t('task.preparation.rerun')}
          aria-label={t('task.preparation.rerun')}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-(--input-border) text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="task-preparation-rerun"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {preparationConfirmDialog}

      {/* Mounted only once there is a script, so the section decides whether to
          open itself against the real thing rather than against nothing. */}
      {stored?.script ? <ScriptSection script={stored.script} /> : null}

      <div className="min-h-0 flex-1 overflow-hidden" data-testid="worktree-scripts-log">
        {isRunning ? (
          <TabIdContext.Provider value={PREPARATION_TAB_ID}>
            <TerminalPanel
              panelId={PREPARATION_PANEL_ID}
              terminalId={getPreparationTerminalId(taskId)}
              terminalSessionId={null}
              surfaceActive
              detachOnUnmount
              // The row above already names the run and reports its status; the
              // panel's own bar would repeat that and add a close button for a
              // process the user did not start.
              showHeader={false}
            />
          </TabIdContext.Provider>
        ) : (
          <div className="h-full overflow-auto p-2">
            <pre className="min-h-full whitespace-pre-wrap break-words rounded-md border border-(--divider) bg-(--input-bg) p-2.5 font-mono text-[11px] leading-relaxed text-(--text-primary)">
              {isReading
                ? t('scripts.readingLog')
                : wasInterrupted
                  ? t('task.preparation.interrupted')
                  : output || t('task.preparation.noOutput')}
            </pre>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * What the run ran, on request.
 *
 * The log alone leaves the reader working backwards from output to guess at
 * the script: a `npm install` that prints a thousand lines buries the copies
 * that followed it, and a run that failed early prints almost nothing at all.
 * The commands are here whole, in order, so the log has something to be read
 * against.
 *
 * Shut until asked for, though. The log is what the panel is open for, and a
 * script unfolded over it costs the reader the thing they came to see — in a
 * column this narrow even a short script wraps into half the panel.
 */
function ScriptSection({ script }: { script: string }) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const lines = script.split('\n').length;

  return (
    <div className="shrink-0 border-b border-(--divider)" data-testid="worktree-scripts-script">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-(--text-muted) transition-colors hover:text-(--text-primary)"
        data-testid="worktree-scripts-script-toggle"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', isOpen && 'rotate-90')} />
        <span className="font-medium">{t('scripts.script')}</span>
        <span className="text-(--text-tertiary)">
          {t('scripts.scriptLines', { count: lines })}
        </span>
      </button>
      {isOpen ? (
        <pre
          className="max-h-44 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[11px] leading-snug text-(--text-secondary)"
          data-testid="worktree-scripts-script-body"
        >
          {script}
        </pre>
      ) : null}
    </div>
  );
}

function StatusMark({ status }: { status: PreparationStatus }) {
  const shared = 'h-3.5 w-3.5 shrink-0';
  switch (status) {
    case 'running':
      return <Loader2 className={cn(shared, 'animate-spin text-(--text-muted)')} />;
    case 'succeeded':
      return <CheckCircle2 className={cn(shared, 'text-(--success)')} />;
    case 'failed':
      return <AlertTriangle className={cn(shared, 'text-(--error)')} />;
    case 'never_run':
      return <Minus className={cn(shared, 'text-(--text-tertiary)')} />;
  }
}

/** The tab's own icon, so the panel does not have to know what a script is. */
export const WorktreeScriptsTabIcon = ScrollText;
