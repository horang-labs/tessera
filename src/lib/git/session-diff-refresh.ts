import * as dbSessions from '@/lib/db/sessions';
import { resolveGitEnvironment } from '@/lib/git/git-environment';
import logger from '@/lib/logger';
import { syncTaskPr } from '@/lib/github/task-pr-sync';
import { syncSessionPr } from '@/lib/github/session-pr-sync';
import { flushGitPanelRecompute } from './git-panel-cache';
import { flushRecompute } from './worktree-diff-stats-cache';

export function getManagedSessionWorkDir(sessionId: string): string | null {
  const session = dbSessions.getSessionWorktreeContext(sessionId);
  // Any session with a work_dir gets live diff recompute (file-watch +
  // per-tool + turn-end), not just worktree-branch-bound ones. Standalone
  // chats working inside a git worktree keep their diff badge up to date the
  // same way. computeWorktreeDiffStats returns null for non-git dirs, so this
  // is safe for plain work_dirs.
  if (!session?.workDir) return null;
  return session.workDir;
}

export function getSessionTaskId(sessionId: string): string | null {
  const session = dbSessions.getSessionWorktreeContext(sessionId);
  return session?.taskId ?? null;
}

export async function refreshSessionDiffState(
  sessionId: string,
  userId: string,
): Promise<void> {
  const session = dbSessions.getSessionWorktreeContext(sessionId);
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

  if (session.workDir) {
    await runOperation(
      'worktree_diff_stats',
      flushRecompute(session.workDir, userId),
    );
  }

  // Run PR sync BEFORE the git-panel recompute so the panel data picks up
  // the freshly-probed PR state in the same broadcast. Otherwise the panel
  // is built from stale prContext/sessionPr cache and the PR-derived
  // github.available / github.reasonCode lag until the next reload.
  if (session.taskId) {
    const agentEnvironment = await resolveGitEnvironment({ userId });
    await runOperation('task_pr_status', syncTaskPr(session.taskId, { agentEnvironment }));
  } else if (session.workDir) {
    const agentEnvironment = await resolveGitEnvironment({ userId });
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

/**
 * Refresh every session that shares a working directory, not just the one that
 * acted (`docs/design/git-delivery.md` §11). A Git action changes the tree for
 * all of them, and nothing else would tell the others.
 *
 * Fire-and-forget on purpose: the action response must not wait for the refresh,
 * and a refresh that fails must never turn a successful commit into a reported
 * failure.
 */
export function refreshWorkDirSessionsInBackground(
  workDir: string,
  userId: string,
  reason: string,
): void {
  for (const session of dbSessions.getSessionsByWorkDir(workDir)) {
    refreshSessionDiffStateInBackground(session.id, userId, reason);
  }
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
