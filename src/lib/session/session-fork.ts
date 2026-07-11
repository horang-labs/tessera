import { randomUUID } from 'crypto';
import path from 'path';
import { processManager } from '@/lib/cli/process-manager';
import {
  deleteCodexThread,
  forkCodexThread,
  type CodexThreadForkResult,
} from '@/lib/cli/providers/codex/thread-control-client';
import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';
import { cloneSessionHistory, sessionHistory } from '@/lib/session-history';
import { persistCreatedSessionRecord } from '@/lib/session/session-persistence';
import { withExclusiveTesseraSessionOperation } from '@/lib/terminal/terminal-handoff-lock';

const MAX_ACTIVE_SESSIONS = 20;

export interface ForkedSessionResult {
  sessionId: string;
  sourceSessionId: string;
  threadId: string;
  title: string;
  projectDir: string;
  workDir?: string;
  provider: 'codex';
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  taskId?: string;
  collectionId?: string;
  worktreeBranch?: string;
  worktreeManaged: boolean;
  createdAt: string;
}

export class SessionForkError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SessionForkError';
  }
}

function forkTitle(sourceTitle: string): string {
  const suffix = ' (Fork)';
  const maxSourceLength = Math.max(1, 100 - suffix.length);
  return `${sourceTitle.slice(0, maxSourceLength)}${suffix}`;
}

async function assertSourceIdle(sessionId: string): Promise<void> {
  const processInfo = processManager.getProcess(sessionId);
  if (processInfo?.isGenerating) {
    throw new SessionForkError('Wait for the current Codex turn to finish before forking.', 'session_busy');
  }
  if ((processInfo?.pendingPermissionRequests?.size ?? 0) > 0) {
    throw new SessionForkError('Answer the pending Codex prompt before forking.', 'interactive_prompt_pending');
  }
  const replay = await sessionHistory.readReplayState(sessionId, { lazyToolOutput: true });
  if (replay.activeInteractivePrompt) {
    throw new SessionForkError('Answer the pending Codex prompt before forking.', 'interactive_prompt_pending');
  }
}

export async function forkCodexSession(
  userId: string,
  sourceSessionId: string,
): Promise<ForkedSessionResult> {
  return withExclusiveTesseraSessionOperation(sourceSessionId, async () => {
    const source = dbSessions.getSession(sourceSessionId);
    if (!source || source.deleted) {
      throw new SessionForkError('Session not found.', 'session_not_found');
    }
    if (source.provider !== 'codex') {
      throw new SessionForkError('Only Codex sessions can be forked.', 'provider_mismatch');
    }
    if (source.archived) {
      throw new SessionForkError('Restore this session before forking it.', 'session_archived');
    }
    if (processManager.getUserProcesses(userId).length >= MAX_ACTIVE_SESSIONS) {
      throw new SessionForkError('Maximum session limit reached (20 sessions).', 'session_limit_reached');
    }

    const sourceThreadId = dbSessions.extractThreadId(source.provider_state);
    if (!sourceThreadId) {
      throw new SessionForkError('This Codex session has no persisted thread.', 'thread_unavailable');
    }
    await assertSourceIdle(sourceSessionId);
    sessionHistory.flushSession(sourceSessionId);

    const project = dbProjects.getProject(source.project_id);
    const resolvedWorkDir = source.work_dir
      ?? project?.decoded_path
      ?? (path.isAbsolute(source.project_id) ? source.project_id : process.cwd());
    let remoteFork: CodexThreadForkResult | null = null;
    const destinationSessionId = randomUUID();
    let historyCloned = false;
    let sessionPersisted = false;

    try {
      remoteFork = await forkCodexThread(
        { userId, workDir: resolvedWorkDir },
        sourceThreadId,
      );

      historyCloned = await cloneSessionHistory(sourceSessionId, destinationSessionId);
      const title = forkTitle(source.title);
      const persistedProject = persistCreatedSessionRecord({
        sessionId: destinationSessionId,
        providerId: 'codex',
        title,
        hasCustomTitle: true,
        parentProjectId: source.project_id,
        resolvedWorkDir,
        worktreeBranch: source.worktree_branch ?? undefined,
        worktreeManaged: source.worktree_managed === 1,
        taskId: source.task_id ?? undefined,
        collectionId: source.collection_id ?? undefined,
        model: remoteFork.model ?? source.model ?? undefined,
        reasoningEffort: remoteFork.reasoningEffort ?? source.reasoning_effort ?? undefined,
        serviceTier: remoteFork.serviceTier ?? source.service_tier ?? undefined,
        providerState: JSON.stringify({ threadId: remoteFork.threadId }),
      });
      sessionPersisted = true;
      const persisted = dbSessions.getSession(destinationSessionId);
      if (!persisted) {
        throw new Error('Forked session was not persisted.');
      }

      logger.info({
        sourceSessionId,
        destinationSessionId,
        sourceThreadId,
        destinationThreadId: remoteFork.threadId,
        historyCloned,
      }, 'Codex session forked');

      return {
        sessionId: destinationSessionId,
        sourceSessionId,
        threadId: remoteFork.threadId,
        title,
        projectDir: persistedProject.projectId,
        workDir: persisted.work_dir ?? undefined,
        provider: 'codex',
        model: persisted.model ?? undefined,
        reasoningEffort: persisted.reasoning_effort ?? undefined,
        serviceTier: persisted.service_tier ?? undefined,
        taskId: persisted.task_id ?? undefined,
        collectionId: persisted.collection_id ?? undefined,
        worktreeBranch: persisted.worktree_branch ?? undefined,
        worktreeManaged: persisted.worktree_managed === 1,
        createdAt: persisted.created_at,
      };
    } catch (error) {
      if (sessionPersisted) {
        dbSessions.deleteSession(destinationSessionId);
      }
      if (historyCloned || await sessionHistory.historyExists(destinationSessionId)) {
        try {
          await sessionHistory.deleteSession(destinationSessionId);
        } catch (cleanupError) {
          logger.warn({
            sourceSessionId,
            destinationSessionId,
            error: cleanupError,
          }, 'Failed to remove fork history during rollback');
        }
      }
      if (remoteFork) {
        try {
          await deleteCodexThread({ userId, workDir: resolvedWorkDir }, remoteFork.threadId);
        } catch (cleanupError) {
          logger.error({
            sourceSessionId,
            destinationSessionId,
            orphanThreadId: remoteFork.threadId,
            error: cleanupError,
          }, 'Failed to remove orphaned Codex fork');
        }
      }
      throw error;
    }
  });
}
