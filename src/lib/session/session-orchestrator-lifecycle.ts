import { v4 as uuidv4 } from 'uuid';
import type { ProcessManager } from '../cli/process-manager';
import { cliProviderRegistry } from '../cli/providers/registry';
import * as dbSessions from '../db/sessions';
import logger from '../logger';
import { sessionHistory } from '../session-history';
import type {
  SessionCreateOptions,
  SessionCreateResult,
  SessionResumeOptions,
  SessionResumeResult,
} from './types';
import { generateDefaultTitle } from './title-generator';

interface ResumeReplayState {
  messages: SessionResumeResult['messages'];
  usage: SessionResumeResult['usage'];
  contextUsage: SessionResumeResult['contextUsage'];
  activeInteractivePrompt: SessionResumeResult['activeInteractivePrompt'];
}

interface CreateSessionWithLifecycleOptions {
  options: SessionCreateOptions;
  processManager: ProcessManager;
  userId: string;
}

interface ResumeSessionWithLifecycleOptions {
  options: SessionResumeOptions;
  processManager: ProcessManager;
  sessionId: string;
  userId: string;
}

export async function createSessionWithLifecycle({
  options,
  processManager,
  userId,
}: CreateSessionWithLifecycleOptions): Promise<SessionCreateResult> {
  const workDir = options.workDir || process.cwd();
  // Resolve provider so that an unknown providerId throws here instead of later at spawn time.
  cliProviderRegistry.getProvider(options.providerId);

  const sessionId = uuidv4();
  const activeProcesses = processManager.getUserProcesses(userId);
  const title = options.title || generateDefaultTitle(activeProcesses.length);
  const createdAt = new Date().toISOString();

  logger.info({ userId, sessionId, title, workDir }, 'Session created (CLI deferred until first message)');

  return {
    sessionId,
    title,
    status: 'starting',
    createdAt,
    cliSessionId: sessionId,
    projectDir: workDir,
    provider: options.providerId,
  };
}

export async function resumeSessionWithLifecycle({
  options,
  processManager,
  sessionId,
  userId,
}: ResumeSessionWithLifecycleOptions): Promise<SessionResumeResult> {
  const session = dbSessions.getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  const providerId = session.provider?.trim();
  if (!providerId) {
    throw new Error(`Session ${sessionId} has no provider`);
  }
  const provider = cliProviderRegistry.getProvider(providerId);
  const threadId = dbSessions.extractThreadId(session.provider_state);
  const workDir = options.workDir || process.cwd();

  // Claude Code: if no Tessera history yet, the CLI has no record of this session.
  // Spawn fresh with --session-id instead of --resume so the CLI doesn't error
  // with "No conversation found". Load history lazily only when needed later.
  let hasTesseraHistory: boolean | null = null;
  let useResume = true;
  if (providerId === 'claude-code') {
    hasTesseraHistory = await sessionHistory.historyExists(sessionId);
    useResume = hasTesseraHistory;
  } else if (providerId === 'codex') {
    hasTesseraHistory = await sessionHistory.historyExists(sessionId);
    if (!threadId && hasTesseraHistory) {
      logger.warn('Codex session has canonical history but no threadId; refusing fresh thread/start', {
        userId,
        sessionId,
      });

      const replayState = await loadReadOnlyReplayState(sessionId);
      return {
        sessionId,
        messages: replayState.messages,
        status: 'read_only',
        usage: replayState.usage,
        contextUsage: replayState.contextUsage,
        activeInteractivePrompt: replayState.activeInteractivePrompt,
      };
    }
    useResume = !!threadId;
  }

  let cliSessionId = await processManager.resumeSession(
    sessionId,
    userId,
    provider,
    workDir,
    options.permissionMode,
    options.model,
    options.reasoningEffort,
    {
      ...(useResume ? { resume: true, threadId } : { resume: false }),
      sessionMode: options.sessionMode,
      accessMode: options.accessMode,
      collaborationMode: options.collaborationMode,
      approvalPolicy: options.approvalPolicy,
      sandboxMode: options.sandboxMode,
    },
  );

  if (hasTesseraHistory === null) {
    hasTesseraHistory = await sessionHistory.historyExists(sessionId);
  }

  if (!cliSessionId && providerId === 'codex' && threadId && !hasTesseraHistory) {
    logger.warn('Codex resume failed without canonical history; retrying with thread/start', {
      userId,
      sessionId,
      threadId,
    });

    cliSessionId = await processManager.resumeSession(
      sessionId,
      userId,
      provider,
      workDir,
      options.permissionMode,
      options.model,
      options.reasoningEffort,
      {
        resume: false,
        sessionMode: options.sessionMode,
        accessMode: options.accessMode,
        collaborationMode: options.collaborationMode,
        approvalPolicy: options.approvalPolicy,
        sandboxMode: options.sandboxMode,
      },
    );
  }

  if (cliSessionId) {
    logger.info({ userId, sessionId }, 'Session resumed (running)');
    return {
      sessionId,
      messages: [],
      status: 'running',
    };
  }

  logger.warn('CLI spawn returned null for resumeSession; falling back to read-only', {
    userId,
    sessionId,
  });

  const replayState = await loadReadOnlyReplayState(sessionId);

  logger.info('Session resumed (read_only)', {
    userId,
    sessionId,
    messageCount: replayState.messages.length,
  });

  return {
    sessionId,
    messages: replayState.messages,
    status: 'read_only',
    usage: replayState.usage,
    contextUsage: replayState.contextUsage,
    activeInteractivePrompt: replayState.activeInteractivePrompt,
  };
}

async function loadReadOnlyReplayState(sessionId: string): Promise<ResumeReplayState> {
  const hasTesseraHistory = await sessionHistory.historyExists(sessionId);
  if (hasTesseraHistory) {
    return sessionHistory.readReplayState(sessionId, { lazyToolOutput: false });
  }

  return {
    messages: [],
    usage: null,
    contextUsage: null,
    activeInteractivePrompt: null,
  };
}
