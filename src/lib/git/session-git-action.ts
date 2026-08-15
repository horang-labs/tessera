/**
 * Running a Git action *for a session*: resolve where it runs, run it, and make
 * sure every panel pointed at that working directory learns what happened.
 *
 * `git-actions.ts` deliberately knows nothing about sessions or the database, so
 * the two halves meet here rather than in the route handler — the refresh has to
 * hold for every caller of the action, not just the one HTTP entry point.
 */
import { executeGitAction, type GitAction } from './git-actions';
import { resolveSessionGitTarget, resolveWorktreeGitTarget } from './git-panel';
import {
  refreshWorkDirSessionsInBackground,
  refreshWorktreeGitStateInBackground,
} from './session-diff-refresh';
import type { GitActionResult } from '@/types/git';

export async function runSessionGitAction(
  sessionId: string,
  userId: string,
  action: GitAction,
): Promise<GitActionResult> {
  const target = await resolveSessionGitTarget(sessionId, userId);

  try {
    return await executeGitAction(target, action);
  } finally {
    // §11: the refresh runs on success and failure alike — a failed action can
    // still have moved the tree — and the response never waits for it. `finally`
    // rather than a call on the success path, so an action that throws (a
    // rejected file path, a runner that died mid-command) refreshes too.
    refreshWorkDirSessionsInBackground(target.workDir, userId, {
      actingSessionId: sessionId,
      reason: 'git_action',
    });
  }
}

export async function runWorktreeGitAction(
  worktreeId: string,
  userId: string,
  action: GitAction,
): Promise<GitActionResult> {
  const target = await resolveWorktreeGitTarget(worktreeId, userId);
  try {
    return await executeGitAction(target, action);
  } finally {
    refreshWorktreeGitStateInBackground(
      worktreeId,
      target.workDir,
      userId,
      'git_action',
    );
  }
}
