'use client';

import { useCallback, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { AsyncConfirmDialog } from '@/components/ui/async-confirm-dialog';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { useI18n } from '@/lib/i18n';
import logger from '@/lib/logger';
import { canRerunPreparation } from '@/lib/projects/preparation-status-policy';
import { toast } from '@/stores/notification-store';
import { useSessionStore } from '@/stores/session-store';
import { useLoadedProjectViews } from '@/hooks/use-project-view-workspace-state';
import type { TaskEntity } from '@/types/task-entity';

/**
 * Whether preparation can be offered for a task: its project needs a script,
 * the task needs a worktree to run it in, and no run of its own may be in
 * flight. A project with no script has no preparation at all — no status, no
 * badge, nothing to offer.
 */
export function canPrepareTask(
  task: Pick<TaskEntity, 'worktreeBranch' | 'workDir' | 'preparationStatus'>,
  projectHasScript: boolean,
): boolean {
  return projectHasScript
    && Boolean(task.worktreeBranch && task.workDir)
    && canRerunPreparation(task.preparationStatus ?? 'never_run');
}

/**
 * Whether a project has a preparation script, as the last projects load saw it.
 * Unknown projects read as false: offering a run that the server would refuse is
 * worse than leaving it out.
 */
export function useProjectHasPreparationScript(projectId: string | undefined): boolean {
  const projects = useLoadedProjectViews();
  return Boolean(projectId && projects.find(
    (project) => project.encodedDir === projectId,
  )?.hasPreparationScript);
}

/**
 * Asks the server to run a task's preparation script on the worktree it already
 * has — once the user has said so.
 *
 * The asking is the point. A preparation script copies files in and installs
 * dependencies, so running it over a worktree someone has been working in can
 * put back what they deliberately changed there. That is not something a single
 * click on a small button should be able to do.
 *
 * The dialog comes back as an element for the caller to render, which is what
 * keeps every entry point asking the same question: a surface that offers a run
 * has to place the dialog to get one.
 */
export function useWorktreePreparation() {
  const { t } = useI18n();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);

  const requestPreparation = useCallback((taskId: string) => {
    setPendingTaskId(taskId);
  }, []);

  const cancelPreparation = useCallback(() => {
    setPendingTaskId(null);
  }, []);

  const confirmPreparation = useCallback(async () => {
    const taskId = pendingTaskId;
    if (!taskId) return;
    setPendingTaskId(null);

    try {
      const response = await fetchWithClientId(
        `/api/tasks/${encodeURIComponent(taskId)}/preparation`,
        { method: 'POST' },
      );
      if (!response.ok) toast.error(t('task.preparation.rerunFailed'));
    } catch (error) {
      logger.error({ error, taskId }, 'Preparation run request failed');
      toast.error(t('task.preparation.rerunFailed'));
    }
  }, [pendingTaskId, t]);

  const preparationConfirmDialog = (
    <AsyncConfirmDialog
      open={pendingTaskId !== null}
      onCancel={cancelPreparation}
      onConfirm={confirmPreparation}
      title={t('task.preparation.confirmTitle')}
      icon={AlertTriangle}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('task.preparation.rerun')}
      confirmingLabel={t('task.preparation.rerunning')}
      iconContainerClassName="bg-(--status-warning-bg)"
      iconClassName="text-(--status-warning-text)"
      dialogTestId="preparation-rerun-dialog"
      cancelTestId="preparation-rerun-cancel"
      confirmTestId="preparation-rerun-confirm"
      errorLogLabel="Preparation run error:"
      description={(
        <>
          <p className="text-(--text-primary)">
            {t('task.preparation.confirmDescription')}
          </p>
          <p className="mt-2 text-sm text-(--text-muted)">
            {t('task.preparation.confirmNote')}
          </p>
        </>
      )}
    />
  );

  return { requestPreparation, preparationConfirmDialog };
}
