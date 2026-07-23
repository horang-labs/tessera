import { existsSync } from 'fs';

import {
  deleteCodexThread,
  renameCodexThread,
  setCodexThreadArchived,
  type CodexThreadControlContext,
} from '@/lib/cli/providers/codex/thread-control-client';
import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';

interface CodexThreadMutationTarget {
  context: CodexThreadControlContext;
  sessionId: string;
  threadId: string;
}

function getMutationTarget(
  session: dbSessions.SessionRow,
  userId?: string,
): CodexThreadMutationTarget | null {
  if (session.provider !== 'codex') return null;
  const threadId = dbSessions.extractThreadId(session.provider_state);
  if (!threadId) return null;
  const projectWorkDir = dbProjects.getProject(session.project_id)?.decoded_path;
  // The worktree can vanish without worktree_deleted_at being recorded (e.g.
  // removed via a path that skips the DB marker); spawning with a missing cwd
  // fails with ENOENT, so trust the filesystem over the marker.
  const sessionWorkDir = !session.worktree_deleted_at && session.work_dir && existsSync(session.work_dir)
    ? session.work_dir
    : null;
  return {
    sessionId: session.id,
    threadId,
    context: {
      userId,
      workDir: sessionWorkDir ?? projectWorkDir,
    },
  };
}

export async function syncCodexThreadName(
  session: dbSessions.SessionRow,
  name: string,
  userId?: string,
): Promise<void> {
  const target = getMutationTarget(session, userId);
  if (!target) return;
  await renameCodexThread(target.context, target.threadId, name);
}

export async function syncCodexThreadDelete(
  session: dbSessions.SessionRow,
  userId?: string,
): Promise<void> {
  const target = getMutationTarget(session, userId);
  if (!target) return;
  await deleteCodexThread(target.context, target.threadId);
}

/**
 * Applies archive state to all persisted Codex threads. If one RPC fails, the
 * already-completed RPCs are compensated in reverse order before the caller
 * touches local task/session state.
 */
export async function syncCodexThreadsArchived(
  sessions: dbSessions.SessionRow[],
  archived: boolean,
  userId?: string,
): Promise<void> {
  const targets = sessions
    .map((session) => getMutationTarget(session, userId))
    .filter((target): target is CodexThreadMutationTarget => target !== null);
  const completed: CodexThreadMutationTarget[] = [];

  try {
    for (const target of targets) {
      await setCodexThreadArchived(target.context, target.threadId, archived);
      completed.push(target);
    }
  } catch (error) {
    for (const target of completed.reverse()) {
      try {
        await setCodexThreadArchived(target.context, target.threadId, !archived);
      } catch (compensationError) {
        logger.error({
          sessionId: target.sessionId,
          threadId: target.threadId,
          archived,
          error: compensationError,
        }, 'Failed to compensate Codex thread archive mutation');
      }
    }
    throw error;
  }
}
