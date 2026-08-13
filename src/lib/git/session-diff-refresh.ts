import * as dbSessions from '@/lib/db/sessions';
import { resolveGitEnvironment } from '@/lib/git/git-environment';
import logger from '@/lib/logger';
import { syncTaskPr } from '@/lib/github/task-pr-sync';
import { syncSessionPr } from '@/lib/github/session-pr-sync';
import { syncWorktreePr } from '@/lib/github/worktree-pr-sync';
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
 * How many bystander panels are recomputed at once. Each one spawns a handful of
 * Git processes, and a long-lived shared checkout can carry dozens of sessions,
 * so the fan-out is paced rather than released in one burst.
 */
const BYSTANDER_REFRESH_CONCURRENCY = 4;

/**
 * Refresh every session that shares a working directory, not just the one that
 * acted (`docs/design/git-delivery.md` §11). A Git action changes the tree for
 * all of them, and nothing else would tell the others.
 *
 * The acting session gets the full refresh — diff stats, PR state, panel. The
 * others get the panel only: the tree-level probes answer for the whole
 * directory, so repeating them once per session would multiply one commit into
 * one `gh` invocation per session sharing the checkout and re-read a diff the
 * workDir-keyed cache has already recomputed.
 */
export async function refreshWorkDirSessions(
  workDir: string,
  userId: string,
  actingSessionId: string,
): Promise<void> {
  // Isolated, because the acting session is the one most likely to have just
  // lost something the refresh reads — and if it did, that is no reason for
  // every other panel on the tree to keep showing the pre-action state.
  try {
    await refreshSessionDiffState(actingSessionId, userId);
  } catch (error) {
    logger.warn(
      { error, sessionId: actingSessionId, userId, workDir },
      'Failed to refresh the acting session after a git action',
    );
  }

  await refreshSharingSessionPanels(workDir, userId, actingSessionId);
}

async function refreshSharingSessionPanels(
  workDir: string,
  userId: string,
  excludeSessionId?: string,
): Promise<void> {
  const bystanders = dbSessions
    .getActiveSessionIdsSharingWorkDir(workDir)
    .filter((sessionId) => sessionId !== excludeSessionId);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < bystanders.length) {
      const sessionId = bystanders[next++]!;
      try {
        await flushGitPanelRecompute(sessionId, userId);
      } catch (error) {
        // One session's panel failing to recompute must not stop the rest.
        logger.warn(
          { error, sessionId, userId, workDir },
          'Failed to refresh a session sharing the working directory',
        );
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(BYSTANDER_REFRESH_CONCURRENCY, bystanders.length) },
      () => worker(),
    ),
  );
}

/** Refresh the sessionless Worktree caches and every Session sharing its tree. */
export async function refreshWorktreeGitState(
  worktreeId: string,
  workDir: string,
  userId: string,
): Promise<void> {
  await Promise.allSettled([
    flushRecompute(workDir, userId),
    syncWorktreePr(worktreeId, { userId, force: true }),
  ]);
  await refreshSharingSessionPanels(workDir, userId);
}

export function refreshWorktreeGitStateInBackground(
  worktreeId: string,
  workDir: string,
  userId: string,
  reason: string,
): void {
  void refreshWorktreeGitState(worktreeId, workDir, userId).catch((error) => {
    logger.warn(
      { error, worktreeId, workDir, userId, reason },
      'Failed to refresh Worktree git state',
    );
  });
}

/**
 * Fire-and-forget on purpose: the action response must not wait for the refresh
 * (§11), and a refresh that fails must never turn a successful commit into a
 * reported failure — so its own failure is logged and swallowed here.
 */
export function refreshWorkDirSessionsInBackground(
  workDir: string,
  userId: string,
  options: { actingSessionId: string; reason: string },
): void {
  const { actingSessionId, reason } = options;
  void refreshWorkDirSessions(workDir, userId, actingSessionId).catch((error) => {
    logger.warn(
      { error, workDir, userId, reason, actingSessionId },
      'Failed to refresh the sessions sharing a working directory',
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
