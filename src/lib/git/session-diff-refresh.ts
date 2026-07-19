import * as dbSessions from '@/lib/db/sessions';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import logger from '@/lib/logger';
import { syncTaskPr } from '@/lib/github/task-pr-sync';
import { syncSessionPr } from '@/lib/github/session-pr-sync';
import { flushGitPanelRecompute } from './git-panel-cache';
import { flushRecompute } from './worktree-diff-stats-cache';

export function getManagedSessionWorkDir(sessionId: string): string | null {
  const session = dbSessions.getSession(sessionId);
  // Any session with a work_dir gets live diff recompute (file-watch +
  // per-tool + turn-end), not just worktree-branch-bound ones. Standalone
  // chats working inside a git worktree keep their diff badge up to date the
  // same way. computeWorktreeDiffStats returns null for non-git dirs, so this
  // is safe for plain work_dirs.
  if (!session?.work_dir) return null;
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

  if (session.work_dir) {
    await runOperation(
      'worktree_diff_stats',
      flushRecompute(session.work_dir, userId),
    );
  }

  // Run PR sync BEFORE the git-panel recompute so the panel data picks up
  // the freshly-probed PR state in the same broadcast. Otherwise the panel
  // is built from stale prContext/sessionPr cache and the PR-derived
  // github.available / github.reasonCode lag until the next reload.
  if (session.task_id) {
    const agentEnvironment = await getAgentEnvironment(userId);
    await runOperation('task_pr_status', syncTaskPr(session.task_id, { agentEnvironment }));
  } else if (session.work_dir) {
    const agentEnvironment = await getAgentEnvironment(userId);
    await runOperation('session_pr_status', syncSessionPr(sessionId, { agentEnvironment }));
  }

  await runOperation('git_panel_state', flushGitPanelRecompute(sessionId, userId));
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
