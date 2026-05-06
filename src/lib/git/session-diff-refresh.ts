import * as dbSessions from '@/lib/db/sessions';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import logger from '@/lib/logger';
import { syncTaskPr } from '@/lib/github/task-pr-sync';
import { flushGitPanelRecompute } from './git-panel-cache';
import { flushRecompute } from './worktree-diff-stats-cache';

export function getManagedSessionWorkDir(sessionId: string): string | null {
  const session = dbSessions.getSession(sessionId);
  if (!session?.work_dir || !session.worktree_branch) return null;
  return session.work_dir;
}

export function getSessionTaskId(sessionId: string): string | null {
  const session = dbSessions.getSession(sessionId);
  return session?.task_id ?? null;
}

export async function refreshSessionDiffState(
  sessionId: string,
  userId: string,
): Promise<void> {
  const session = dbSessions.getSession(sessionId);
  if (!session) return;

  async function runOperation(
    operation: string,
    promise: Promise<unknown>,
  ): Promise<void> {
    try {
      await promise;
    } catch (error) {
      logger.warn(
        { error, operation, sessionId, userId },
        'Session diff refresh operation failed',
      );
    }
  }

  if (session.work_dir && session.worktree_branch) {
    await runOperation(
      'worktree_diff_stats',
      flushRecompute(session.work_dir, userId),
    );
  }

  await runOperation('git_panel_state', flushGitPanelRecompute(sessionId, userId));

  if (session.task_id) {
    const agentEnvironment = await getAgentEnvironment(userId);
    await runOperation('task_pr_status', syncTaskPr(session.task_id, { agentEnvironment }));
  }
}

export function refreshSessionDiffStateInBackground(
  sessionId: string,
  userId: string,
  reason: string,
): void {
  void refreshSessionDiffState(sessionId, userId).catch((error) => {
    logger.warn(
      { error, sessionId, userId, reason },
      'Failed to refresh session diff state',
    );
  });
}

export function refreshSessionDiffStateSoon(
  sessionId: string,
  userId: string,
  reason: string,
  delayMs = 500,
): void {
  setTimeout(() => {
    refreshSessionDiffStateInBackground(sessionId, userId, reason);
  }, delayMs);
}
