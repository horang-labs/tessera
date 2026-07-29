import { useCallback } from 'react';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { useI18n } from '@/lib/i18n';
import logger from '@/lib/logger';
import { canRerunPreparation } from '@/lib/projects/preparation-status-policy';
import { toast } from '@/stores/notification-store';
import { useSessionStore } from '@/stores/session-store';
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
 * Asks the server to run a task's preparation script again on the worktree it
 * already has. Reporting the failure is handled here, so callers only decide
 * what to do once it started.
 */
/**
 * Whether a project has a preparation script, as the last projects load saw it.
 * Unknown projects read as false: offering a run that the server would refuse is
 * worse than leaving it out.
 */
export function useProjectHasPreparationScript(projectId: string | undefined): boolean {
  return useSessionStore((state) =>
    Boolean(projectId && state.projects.find(
      (project) => project.encodedDir === projectId,
    )?.hasPreparationScript),
  );
}

export function useWorktreePreparation() {
  const { t } = useI18n();

  const runPreparation = useCallback(async (taskId: string): Promise<boolean> => {
    try {
      const response = await fetchWithClientId(
        `/api/tasks/${encodeURIComponent(taskId)}/preparation`,
        { method: 'POST' },
      );
      if (!response.ok) {
        toast.error(t('task.preparation.rerunFailed'));
        return false;
      }
      return true;
    } catch (error) {
      logger.error({ error, taskId }, 'Preparation run request failed');
      toast.error(t('task.preparation.rerunFailed'));
      return false;
    }
  }, [t]);

  return { runPreparation };
}
