import { useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useI18n } from '@/lib/i18n';
import { useSessionCrud } from '@/hooks/use-session-crud';
import { useTaskStore } from '@/stores/task-store';
import { useSettingsStore } from '@/stores/settings-store';
import { toast } from '@/stores/notification-store';
import logger from '@/lib/logger';
import type { TaskEntity, WorkflowStatus } from '@/types/task-entity';

interface CreateWorktreeSessionOptions {
  projectDir: string;
  parentProjectId?: string;
  providerId: string;
  /** Task title. Worktree sessions are always task-backed. */
  taskTitle: string;
  /**
   * Whether the title was explicitly provided by the user.
   * When false (e.g. caller used an i18n fallback label), the session is
   * persisted with has_custom_title=0 so AI auto-title generation can run.
   * Defaults to true for backward compatibility.
   */
  hasCustomTitle?: boolean;
  /** Collection ID for the new task. */
  collectionId?: string;
  /** Initial workflow status for the new task. */
  workflowStatus?: WorkflowStatus;
  /** Editable slug appended after the configured branch prefix. */
  branchSlug?: string;
  /** Allow server-side suffixes like -2 when the requested slug collides. */
  allowBranchSlugSuffix?: boolean;
  /** Let the caller render inline errors instead of only showing a toast. */
  suppressErrorToast?: boolean;
}

interface CreateWorktreeSessionResult {
  ok: boolean;
  error?: string;
  status?: number;
  code?: string;
  branchName?: string;
  worktreePath?: string;
  sessionId?: string | null;
}

export function useWorktreeSession() {
  const { t } = useI18n();
  const { createSession } = useSessionCrud();
  const branchPrefix = useSettingsStore((state) => state.settings.gitConfig.branchPrefix);

  const createWorktreeSession = useCallback(
    async ({
      projectDir,
      parentProjectId,
      providerId,
      taskTitle,
      hasCustomTitle = true,
      collectionId,
      workflowStatus,
      branchSlug,
      allowBranchSlugSuffix,
      suppressErrorToast = false,
    }: CreateWorktreeSessionOptions): Promise<CreateWorktreeSessionResult> => {
      const projectId = parentProjectId ?? projectDir;
      const isTaskCreation = Boolean(taskTitle);
      const resolvedProviderId = providerId.trim();
      if (!resolvedProviderId) {
        const error = t('errors.providerRequired');
        if (!suppressErrorToast) {
          toast.error(error);
        }
        return { ok: false, error };
      }

      if (!isTaskCreation) {
        const error = t('task.creation.title');
        if (!suppressErrorToast) {
          toast.error(error);
        }
        return { ok: false, error };
      }

      // Pick the bucket key the Kanban/list is actually rendering from.
      // The rest of the app is inconsistent about whether it uses encodedDir
      // or decodedPath; by aligning with the task-store's currentProjectId we
      // ensure the placeholder lands in the bucket the UI subscribes to.
      const storePlaceholderProjectId =
        useTaskStore.getState().currentProjectId ?? projectId;

      // Insert an optimistic placeholder task so the Kanban/list reflects the
      // in-flight creation immediately. The real task replaces it once the
      // server finishes the worktree + task row.
      const tempId = isTaskCreation ? `pending_${uuidv4()}` : null;
      if (tempId && taskTitle) {
        const now = new Date().toISOString();
        const placeholder: TaskEntity = {
          id: tempId,
          projectId: storePlaceholderProjectId,
          title: taskTitle,
          collectionId,
          workflowStatus: workflowStatus ?? 'todo',
          sortOrder: 0,
          sessions: [],
          createdAt: now,
          updatedAt: now,
          isPending: true,
        };
        useTaskStore.getState().addPendingTask(placeholder);
      }

      const removePlaceholder = () => {
        if (tempId) {
          useTaskStore.getState().removePendingTask(tempId, storePlaceholderProjectId);
        }
      };

      try {
        // 1. Create worktree
        const response = await fetch('/api/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectDir,
            branchPrefix,
            branchSlug,
            allowBranchSlugSuffix,
          }),
        });

        const result = await response.json().catch(() => ({})) as {
          branchName?: string;
          code?: string;
          error?: string;
          installUrl?: string;
          worktreePath?: string;
        };

        if (!response.ok || !result.worktreePath || !result.branchName) {
          removePlaceholder();
          const error =
            result.error
            ?? (result.code === 'GIT_NOT_INSTALLED'
              ? 'Git is required to create a managed worktree.'
              : result.code === 'PROJECT_NOT_GIT_REPOSITORY'
                ? 'This project directory is not a Git repository.'
                : t('errors.unknownError'));
          if (!suppressErrorToast) {
            toast.error(error);
          }
          return {
            ok: false,
            error,
            status: response.status,
            code: result.code,
            branchName: result.branchName,
            worktreePath: result.worktreePath,
          };
        }

        // 2. Create task entity. Do not continue with a worktree-backed chat
        // if the task row could not be persisted.
        let createdTaskId: string | null = null;
        if (tempId && taskTitle) {
          try {
            const taskRes = await fetch('/api/tasks', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                projectId,
                title: taskTitle,
                collectionId,
                workflowStatus,
                worktreeBranch: result.branchName,
              }),
            });
            if (taskRes.ok) {
              const taskData = await taskRes.json();
              const realTask: TaskEntity = taskData.task;
              useTaskStore.getState().finalizePendingTask(tempId, realTask);
              createdTaskId = realTask.id;
            } else {
              removePlaceholder();
              logger.warn('Task creation returned non-ok — aborting worktree session creation');
              toast.warning(t('task.creation.taskCreationFailed'));
              return {
                ok: false,
                error: t('task.creation.taskCreationFailed'),
                status: taskRes.status,
              };
            }
          } catch (err) {
            removePlaceholder();
            logger.error({ error: err }, 'Task creation failed — aborting worktree session creation');
            toast.warning(t('task.creation.taskCreationFailed'));
            return {
              ok: false,
              error: t('task.creation.taskCreationFailed'),
            };
          }
        }

        // 3. Create session
        const sessionId = await createSession({
          workDir: result.worktreePath,
          ...(taskTitle && { title: taskTitle, hasCustomTitle }),
          ...(parentProjectId && { parentProjectId }),
          providerId: resolvedProviderId,
          worktreeBranch: result.branchName,
          collectionId,
          ...(createdTaskId && { taskId: createdTaskId }),
        });

        if (!sessionId) {
          return {
            ok: false,
            error: t('errors.createSessionFailed'),
            branchName: result.branchName,
            worktreePath: result.worktreePath,
          };
        }

        if (createdTaskId && sessionId) {
          useTaskStore.getState().loadTasks(projectId);
          const { useSessionStore } = await import('@/stores/session-store');
          useSessionStore.getState().loadProjects();
        }
        return {
          ok: true,
          branchName: result.branchName,
          worktreePath: result.worktreePath,
          sessionId,
        };
      } catch (err) {
        removePlaceholder();
        logger.error({ error: err }, 'Worktree session creation failed');
        const message = err instanceof Error ? err.message : t('errors.unknownError');
        if (!suppressErrorToast) {
          toast.error(message);
        }
        return { ok: false, error: message };
      }
    },
    [branchPrefix, createSession, t]
  );

  return { createWorktreeSession };
}
