import { v4 as uuidv4 } from 'uuid';
import type { ProcessManager } from '../cli/process-manager';
import { cliProviderRegistry } from '../cli/providers/registry';
import { getProviderSessionOptions } from '../cli/provider-session-options';
import * as dbSessions from '../db/sessions';
import logger from '../logger';
import { sessionHistory } from '../session-history';
import {
  resolveProviderModelOption,
  resolveProviderReasoningEffort,
} from '../settings/provider-defaults';
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

async function resolveRuntimeModelDefaults(
  providerId: string,
  userId: string,
  options: Pick<SessionResumeOptions, 'model' | 'reasoningEffort'>,
): Promise<Pick<SessionResumeOptions, 'model' | 'reasoningEffort'>> {
  if (providerId !== 'codex' && providerId !== 'opencode') {
    return options;
  }

  if (providerId === 'codex' && options.model && options.reasoningEffort) {
    return options;
  }

  if (providerId === 'opencode' && options.model) {
    return options;
  }

  try {
    const sessionOptions = await getProviderSessionOptions(providerId, userId);
    const requestedModel = options.model;
    const requestedReasoningEffort = options.reasoningEffort;
    const modelOption = resolveProviderModelOption(providerId, sessionOptions, requestedModel);

    if (!modelOption) {
      return options;
    }

    return {
      model: modelOption.value,
      reasoningEffort: resolveProviderReasoningEffort(
        providerId,
        sessionOptions,
        modelOption,
        requestedReasoningEffort,
      ),
    };
  } catch (error) {
    logger.warn({
      providerId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to resolve provider runtime defaults; using supplied options');
    return options;
  }
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
  const opencodeSessionId = dbSessions.extractOpenCodeSessionId(session.provider_state);
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
  } else if (providerId === 'opencode') {
    hasTesseraHistory = await sessionHistory.historyExists(sessionId);
    if (!opencodeSessionId && hasTesseraHistory) {
      logger.warn('OpenCode session has canonical history but no ACP session id; refusing fresh session/new', {
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
    useResume = !!opencodeSessionId;
  }

  // Fall back to the persisted model/effort when the caller didn't supply them.
  // Every resume path converges here (REST resume, WS resume, retry), and the WS
  // path in particular sends no model/effort — without this, a cold resume after
  // the in-memory store is gone would silently drop the session's ultracode/model
  // choice and spawn at the global default.
  const optionsWithPersisted: SessionResumeOptions = {
    ...options,
    model: options.model ?? session.model ?? undefined,
    reasoningEffort: options.reasoningEffort !== undefined
      ? options.reasoningEffort
      : (session.reasoning_effort ?? undefined),
  };

  // Persist a deliberate change (e.g. the user picked a new model/effort before
  // resuming) so it survives the next cold restart too. skipTimestamp keeps the
  // sidebar ordering stable.
  if (
    providerId === 'claude-code'
    && (options.model !== undefined || options.reasoningEffort !== undefined)
  ) {
    dbSessions.updateSession(
      sessionId,
      {
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {}),
      },
      { skipTimestamp: true },
    );
  }

  const runtimeDefaults = await resolveRuntimeModelDefaults(providerId, userId, optionsWithPersisted);

  let cliSessionId = await processManager.resumeSession(
    sessionId,
    userId,
    provider,
    workDir,
    options.permissionMode,
    runtimeDefaults.model,
    runtimeDefaults.reasoningEffort,
    {
      ...(useResume ? { resume: true, threadId } : { resume: false }),
      ...(providerId === 'opencode' && useResume ? { opencodeSessionId } : {}),
      sessionMode: options.sessionMode,
      accessMode: options.accessMode,
      collaborationMode: options.collaborationMode,
      approvalPolicy: options.approvalPolicy,
      sandboxMode: options.sandboxMode,
      serviceTier: options.serviceTier,
      fastMode: options.fastMode,
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
      runtimeDefaults.model,
      runtimeDefaults.reasoningEffort,
      {
        resume: false,
        sessionMode: options.sessionMode,
        accessMode: options.accessMode,
        collaborationMode: options.collaborationMode,
        approvalPolicy: options.approvalPolicy,
        sandboxMode: options.sandboxMode,
        serviceTier: options.serviceTier,
      fastMode: options.fastMode,
      },
    );
  }

  if (!cliSessionId && providerId === 'opencode' && opencodeSessionId && !hasTesseraHistory) {
    logger.warn('OpenCode resume failed without canonical history; retrying with session/new', {
      userId,
      sessionId,
      opencodeSessionId,
    });

    cliSessionId = await processManager.resumeSession(
      sessionId,
      userId,
      provider,
      workDir,
      options.permissionMode,
      runtimeDefaults.model,
      runtimeDefaults.reasoningEffort,
      {
        resume: false,
        sessionMode: options.sessionMode,
        accessMode: options.accessMode,
        collaborationMode: options.collaborationMode,
        approvalPolicy: options.approvalPolicy,
        sandboxMode: options.sandboxMode,
        serviceTier: options.serviceTier,
      fastMode: options.fastMode,
      },
    );
  }

  if (cliSessionId) {
    logger.info({ userId, sessionId }, 'Session resumed (running)');
    return {
      sessionId,
      messages: [],
      status: 'running',
      model: runtimeDefaults.model,
      reasoningEffort: runtimeDefaults.reasoningEffort,
      serviceTier: options.serviceTier,
      fastMode: options.fastMode,
      sessionMode: options.sessionMode,
      accessMode: options.accessMode,
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
