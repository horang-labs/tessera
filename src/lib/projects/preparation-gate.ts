/**
 * Holds an agent back until the worktree it will work in is ready for it.
 *
 * A CLI reads its instruction files — CLAUDE.md, AGENTS.md — once, at startup.
 * A file copied in afterwards is a file that session never sees, and nothing
 * later puts it into the context. So the `before` stage has to finish before a
 * CLI is spawned, and this is the one place that waits for it.
 *
 * Waiting is polling rather than a subscription: preparation is recorded by
 * whichever process owns the PTY, the status lives in the database, and a poll
 * of an in-process database is cheaper than the machinery a change feed would
 * need to be correct across both.
 */

import { getTaskPreparation } from '@/lib/db/task-preparation';
import { findTaskIdForWorktree } from '@/lib/db/tasks';
import logger from '@/lib/logger';
import { blocksAgentStartup } from './preparation-status-policy';

/** How often the stored status is re-read while an agent is held. */
const POLL_INTERVAL_MS = 250;

/**
 * How long an agent may be held.
 *
 * Long enough for anything anybody would sensibly put in the blocking stage,
 * and short enough that a run which will never end does not take the session
 * with it. On expiry the agent starts regardless: a prompt that is answered
 * late beats one that is never answered at all.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type PreparationWaitOutcome =
  /** Nothing was in the way; no agent was held. */
  | { waited: false }
  /** The blocking stage finished while the agent was held. */
  | { waited: true; result: 'ready' }
  /** It did not finish in time, and the agent was released anyway. */
  | { waited: true; result: 'timedOut' };

export interface PreparationWaitOptions {
  /** The directory the agent will run in, which is what identifies the worktree. */
  workDir: string | null | undefined;
  /** Called once, if and only if the agent is actually held. */
  onWaitStarted?: () => void;
  timeoutMs?: number;
}

/**
 * Wait, if there is anything to wait for, before an agent is spawned.
 *
 * Returns immediately for a working directory that is not a prepared worktree,
 * for a run that has finished either way, and for one whose `before` stage is
 * already done — the `after` stage running is not something to wait for.
 */
export async function waitForPreparationBeforeAgent(
  options: PreparationWaitOptions,
): Promise<PreparationWaitOutcome> {
  const taskId = options.workDir ? findTaskIdForWorktree(options.workDir) : null;
  if (!taskId) return { waited: false };

  const initial = getTaskPreparation(taskId);
  if (!initial || !blocksAgentStartup(initial.status, initial.phase)) {
    return { waited: false };
  }

  options.onWaitStarted?.();
  logger.info(
    { taskId, workDir: options.workDir },
    'Holding the agent until the worktree finishes preparing',
  );

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const current = getTaskPreparation(taskId);
    // A task that disappeared mid-wait has nothing left to prepare for.
    if (!current || !blocksAgentStartup(current.status, current.phase)) {
      return { waited: true, result: 'ready' };
    }
  }

  logger.warn(
    { taskId, workDir: options.workDir },
    'Preparation did not finish in time; starting the agent anyway',
  );
  return { waited: true, result: 'timedOut' };
}
