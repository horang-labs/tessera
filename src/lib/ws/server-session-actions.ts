import { processManager } from '../cli/process-manager';
import { protocolAdapter } from '../cli/protocol-adapter';
import type { SkillInfo } from '../cli/providers/types';
import type { PendingPermissionRequest, ProcessInfo } from '../cli/types';
import type { AskUserQuestionItem } from '@/types/cli-jsonl-schemas';
import * as dbSessions from '../db/sessions';
import logger from '../logger';
import { sessionOrchestrator } from '../session/session-orchestrator';
import { generateSessionTitle } from '../session/title-generator';
import { sessionHistory } from '../session-history';
import { persistCreatedSessionRecord } from '../session/session-persistence';
import { syncSingleSessionTaskTitleFromSession } from '../task-title-sync';
import { buildCodexSkillContent } from '../chat/build-codex-skill-content';
import { buildUserMessageDisplayContent } from '../chat/build-user-message-display-content';
import { refreshSessionDiffStateInBackground } from '../git/session-diff-refresh';
import type {
  ClientMessage,
  ContentBlock,
  ServerTransportMessage,
  TextContentBlock,
} from './message-types';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';

type WsSendToUser = (userId: string, message: ServerTransportMessage) => void;
type SessionHistoryMessage = Extract<ServerTransportMessage, { type: 'session_history' }>;
type CodexRequestUserInputResult = {
  answers: Record<string, { answers: string[] }>;
};
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type CodexMcpElicitationResult = {
  action: 'accept' | 'decline' | 'cancel';
  content: JsonValue | null;
  _meta: JsonValue | null;
};
type CodexPermissionsRequestResult = {
  permissions: Record<string, unknown>;
  scope: 'turn' | 'session';
};

const CODEX_REQUEST_USER_INPUT_TOOL_NAME = 'CodexRequestUserInput';
const CODEX_MCP_ELICITATION_TOOL_NAME = 'CodexMcpElicitation';
const CODEX_PERMISSIONS_REQUEST_TOOL_NAME = 'CodexPermissionsRequest';

const AUTO_TITLE_PLACEHOLDER_TITLES = new Set([
  'New Task',
  '새 태스크',
  '新しいタスク',
  '新建任务',
]);

type SessionControlRequest = Pick<
  Extract<ClientMessage, { sessionId: string }>,
  'sessionId'
>;

interface SessionActionOptions {
  sendToUser: WsSendToUser;
  userId: string;
}

interface CreateSessionActionOptions extends SessionActionOptions, ProviderRuntimeControls {
  permissionMode?: string;
  providerId: string;
  workDir?: string;
  model?: string;
  reasoningEffort?: string | null;
}

interface CloseSessionActionOptions extends SessionActionOptions {
  eventType: 'session_closed' | 'session_stopped';
  logMessage?: string;
  sessionId: string;
}

interface SendSessionMessageActionOptions extends SessionActionOptions {
  content: string | ContentBlock[];
  displayContent?: string | ContentBlock[];
  sessionId: string;
  skillName?: string;
  /** Composer-side config used only when no CLI process exists yet (first send). */
  spawnConfig?: ProviderRuntimeControls & {
    model?: string;
    reasoningEffort?: string | null;
    permissionMode?: string;
  };
}

interface ResumeSessionActionOptions extends SessionActionOptions, ProviderRuntimeControls {
  permissionMode?: string;
  sessionId: string;
}

interface RetrySessionActionOptions extends SessionActionOptions {
  sessionId: string;
}

interface InteractiveResponseActionOptions extends SessionActionOptions {
  response: string;
  sessionId: string;
  toolUseId: string;
}

interface ProcessManagerControlOptions extends SessionActionOptions {
  action: (sessionId: string) => boolean;
  errorCode: string;
  errorMessage: string;
  logMessage: string;
  sessionId: string;
  logMetadata?: Record<string, unknown>;
}

export async function createSessionFromWebSocket({
  permissionMode,
  providerId,
  sendToUser,
  userId,
  workDir,
  model,
  reasoningEffort,
  serviceTier,
  sessionMode,
  accessMode,
  collaborationMode,
  approvalPolicy,
  sandboxMode,
}: CreateSessionActionOptions): Promise<void> {
  try {
    const resolvedProviderId = providerId.trim();
    if (!resolvedProviderId) {
      sendToUser(userId, {
        type: 'error',
        code: 'provider_required',
        message: 'providerId is required to create a session',
      });
      return;
    }

    const result = await sessionOrchestrator.createSession(userId, {
      workDir,
      permissionMode,
      providerId: resolvedProviderId,
      model,
      reasoningEffort,
      serviceTier,
      sessionMode,
      accessMode,
      collaborationMode,
      approvalPolicy,
      sandboxMode,
    });
    const resolvedWorkDir = workDir || process.cwd();

    persistCreatedSessionRecord({
      sessionId: result.sessionId,
      resolvedWorkDir,
      title: result.title,
      providerId: resolvedProviderId,
    });

    sendToUser(userId, {
      type: 'session_created',
      sessionId: result.sessionId,
      status: 'ready',
      workDir: resolvedWorkDir,
      provider: resolvedProviderId,
      ...(permissionMode && { permissionMode: permissionMode as any }),
      ...(model && { model }),
      ...(reasoningEffort !== undefined && { reasoningEffort }),
      ...(serviceTier !== undefined && { serviceTier }),
      ...(sessionMode && { sessionMode }),
      ...(accessMode && { accessMode }),
      ...(collaborationMode && { collaborationMode }),
      ...(approvalPolicy && { approvalPolicy }),
      ...(sandboxMode && { sandboxMode }),
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('Maximum session limit')) {
      sendToUser(userId, {
        type: 'error',
        code: 'session_limit_exceeded',
        message: 'Maximum 20 sessions reached. Please close some sessions.',
      });
      return;
    }
    if (message.includes('unknown provider')) {
      sendToUser(userId, {
        type: 'error',
        code: 'unknown_provider',
        message,
      });
      return;
    }

    logger.error({ userId, error: err }, 'Failed to create session via WebSocket');
    sendToUser(userId, {
      type: 'error',
      code: 'create_session_failed',
      message: `Failed to create session: ${message}`,
    });
  }
}

export async function closeSessionFromWebSocket({
  eventType,
  logMessage,
  sendToUser,
  sessionId,
  userId,
}: CloseSessionActionOptions): Promise<void> {
  await sessionOrchestrator.closeSession(userId, sessionId);

  sendToUser(userId, {
    type: eventType,
    sessionId,
  });

  refreshSessionDiffStateInBackground(sessionId, userId, eventType);

  if (logMessage) {
    logger.info({ userId, sessionId }, logMessage);
  }
}

export function sendCommandsListToWebSocketUser({
  sendToUser,
  sessionId,
  userId,
}: SessionActionOptions & SessionControlRequest): void {
  sendToUser(userId, {
    type: 'commands_list',
    sessionId,
    commands: processManager.getCommands(sessionId),
  });
}

export async function sendSessionMessageFromWebSocket({
  content,
  displayContent,
  sendToUser,
  sessionId,
  skillName,
  spawnConfig,
  userId,
}: SendSessionMessageActionOptions): Promise<void> {
  const contentType =
    typeof content === 'string' ? 'string' : `ContentBlock[${content.length}]`;
  logger.debug({ userId, sessionId, contentType, skillName }, 'WebSocket send_message received');

  // No live process exists yet. Rehydrate via the resume path before delivering
  // the message so persisted provider state remains authoritative.
  if (!processManager.getProcess(sessionId)) {
    const ok = await ensureSessionProcess({ sessionId, userId, sendToUser, spawnConfig });
    if (!ok) return;
  }

  const resolvedDisplayContent = buildUserMessageDisplayContent(
    displayContent ?? content,
    skillName,
  );
  sessionHistory.recordUserMessage(sessionId, resolvedDisplayContent);
  await maybeAutoSetSessionTitle(sessionId, resolvedDisplayContent);

  if (!skillName) {
    processManager.sendMessage(sessionId, content);
    return;
  }

  const processInfo = processManager.getProcess(sessionId);
  if (processInfo?.provider.getProviderId() === 'codex') {
    await sendCodexSkillMessage({
      content,
      processInfo,
      sendToUser,
      sessionId,
      skillName,
      userId,
    });
    return;
  }

  const skillText =
    typeof content === 'string'
      ? content.trim()
      : content
          .filter((block): block is TextContentBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();
  const command = skillText ? `/${skillName} ${skillText}` : `/${skillName}`;
  processManager.sendMessage(sessionId, command);
  logger.info({ sessionId, skillName, command: command.slice(0, 100) }, 'Skill command sent to CLI');
}

/**
 * Ensure a CLI process exists before sending input.
 * For persisted sessions this must use the normal resume path so provider
 * state such as Codex threadId is preserved across server restarts/process loss.
 */
async function ensureSessionProcess({
  sessionId,
  userId,
  sendToUser,
  spawnConfig,
}: {
  sessionId: string;
  userId: string;
  sendToUser: WsSendToUser;
  spawnConfig?: SendSessionMessageActionOptions['spawnConfig'];
}): Promise<boolean> {
  const session = dbSessions.getSession(sessionId);
  if (!session) {
    sendToUser(userId, {
      type: 'error',
      sessionId,
      code: 'session_not_found',
      message: 'Session does not exist',
    });
    return false;
  }

  const providerId = session.provider?.trim();
  if (!providerId) {
    sendToUser(userId, {
      type: 'error',
      sessionId,
      code: 'session_provider_missing',
      message: 'Session has no provider',
    });
    return false;
  }
  const workDir = session.work_dir || process.cwd();

  const result = await sessionOrchestrator.resumeSession(userId, sessionId, {
    workDir,
    permissionMode: spawnConfig?.permissionMode,
    model: spawnConfig?.model,
    reasoningEffort: spawnConfig?.reasoningEffort,
    serviceTier: spawnConfig?.serviceTier,
    sessionMode: spawnConfig?.sessionMode,
    accessMode: spawnConfig?.accessMode,
    collaborationMode: spawnConfig?.collaborationMode,
    approvalPolicy: spawnConfig?.approvalPolicy,
    sandboxMode: spawnConfig?.sandboxMode,
  });

  if (result.status === 'read_only') {
    sendSessionHistoryToUser({
      sendToUser,
      sessionId,
      userId,
      messages: result.messages,
      usage: result.usage,
      contextUsage: result.contextUsage,
      activeInteractivePrompt: result.activeInteractivePrompt,
    });
    sendToUser(userId, {
      type: 'error',
      sessionId,
      code: 'session_resume_failed',
      message: 'Session could not be resumed',
    });
    return false;
  }

  const startedModel = result.model ?? spawnConfig?.model;
  const startedReasoningEffort = result.reasoningEffort !== undefined
    ? result.reasoningEffort
    : spawnConfig?.reasoningEffort;
  const startedServiceTier = result.serviceTier !== undefined
    ? result.serviceTier
    : spawnConfig?.serviceTier;

  sendToUser(userId, {
    type: 'session_started',
    sessionId,
    workDir,
    provider: providerId,
    ...(spawnConfig?.permissionMode && { permissionMode: spawnConfig.permissionMode as any }),
    ...(startedModel && { model: startedModel }),
    ...(startedReasoningEffort !== undefined && { reasoningEffort: startedReasoningEffort }),
    ...(startedServiceTier !== undefined && { serviceTier: startedServiceTier }),
    ...(spawnConfig?.sessionMode && { sessionMode: spawnConfig.sessionMode }),
    ...(spawnConfig?.accessMode && { accessMode: spawnConfig.accessMode }),
    ...(spawnConfig?.collaborationMode && { collaborationMode: spawnConfig.collaborationMode }),
    ...(spawnConfig?.approvalPolicy && { approvalPolicy: spawnConfig.approvalPolicy }),
    ...(spawnConfig?.sandboxMode && { sandboxMode: spawnConfig.sandboxMode }),
  });
  return true;
}

export async function resumeSessionFromWebSocket({
  permissionMode,
  sessionMode,
  accessMode,
  collaborationMode,
  approvalPolicy,
  sandboxMode,
  serviceTier,
  sendToUser,
  sessionId,
  userId,
}: ResumeSessionActionOptions): Promise<void> {
  try {
    const sessionRecord = dbSessions.getSession(sessionId);
    const result = await sessionOrchestrator.resumeSession(userId, sessionId, {
      workDir: sessionRecord?.work_dir || undefined,
      permissionMode,
      sessionMode,
      accessMode,
      collaborationMode,
      approvalPolicy,
      sandboxMode,
      serviceTier,
    });

    if (result.status === 'read_only') {
      sendSessionHistoryToUser({
        sendToUser,
        sessionId,
        userId,
        messages: result.messages,
        usage: result.usage,
        contextUsage: result.contextUsage,
        activeInteractivePrompt: result.activeInteractivePrompt,
      });
      logger.info({ userId, sessionId, messageCount: result.messages.length }, 'Session resumed (read_only)');
      return;
    }

    if (await sessionHistory.historyExists(sessionId)) {
      const replayState = await sessionHistory.readReplayState(sessionId, {
        lazyToolOutput: false,
      });
      sendSessionHistoryToUser({
        sendToUser,
        sessionId,
        userId,
        messages: replayState.messages,
        usage: replayState.usage,
        contextUsage: replayState.contextUsage,
        activeInteractivePrompt: replayState.activeInteractivePrompt,
      });
      logger.info({ userId, sessionId, messageCount: replayState.messages.length }, 'Session resumed');
      return;
    }

    logger.info({ userId, sessionId, messageCount: 0 }, 'Session resumed without canonical history');
  } catch (err) {
    logger.error({ userId, sessionId, error: err }, 'Failed to resume session');
    sendToUser(userId, {
      type: 'error',
      sessionId,
      code: 'resume_failed',
      message: `Failed to resume session: ${(err as Error).message}`,
    });
  }
}

export async function retrySessionFromWebSocket({
  sendToUser,
  sessionId,
  userId,
}: RetrySessionActionOptions): Promise<void> {
  try {
    if (dbSessions.getSession(sessionId)) {
      await resumeSessionFromWebSocket({ sendToUser, sessionId, userId });
      return;
    }

    sendToUser(userId, {
      type: 'error',
      sessionId,
      code: 'session_retry_failed',
      message: 'Cannot retry a session that has not been persisted with a provider',
    });
  } catch (err) {
    logger.error({ userId, sessionId, error: err }, 'Failed to retry session');
    sendToUser(userId, {
      type: 'error',
      sessionId,
      code: 'retry_failed',
      message: 'Failed to retry session',
    });
  }
}

export function sendInteractiveResponseFromWebSocket({
  response,
  sendToUser,
  sessionId,
  toolUseId,
  userId,
}: InteractiveResponseActionOptions): void {
  const info = processManager.getProcess(sessionId);
  if (!info) {
    logger.warn({ sessionId }, 'Cannot send interactive response to non-existent session');
    return;
  }

  const pendingRequest = info.pendingPermissionRequests?.get(toolUseId);
  if (!pendingRequest) {
    const sent = processManager.sendInteractiveResponse(sessionId, toolUseId, response);
    if (!sent) {
      logger.warn({ sessionId, toolUseId }, 'Failed to send interactive response (legacy)');
      return;
    }

    sessionHistory.recordInteractivePromptResponse(sessionId, toolUseId, response);
    logger.info(
      { sessionId, toolUseId, response: response.substring(0, 50) },
      'Interactive response sent (legacy)',
    );
    return;
  }

  if (pendingRequest.toolName === CODEX_REQUEST_USER_INPUT_TOOL_NAME) {
    respondToCodexRequestUserInput({
      processInfo: info,
      pendingRequest,
      response,
      sessionId,
    });
  } else if (pendingRequest.toolName === CODEX_MCP_ELICITATION_TOOL_NAME) {
    respondToCodexMcpElicitation({
      processInfo: info,
      pendingRequest,
      response,
      sessionId,
    });
  } else if (pendingRequest.toolName === CODEX_PERMISSIONS_REQUEST_TOOL_NAME) {
    respondToCodexPermissionsRequest({
      processInfo: info,
      pendingRequest,
      response,
      sessionId,
    });
  } else if (info.provider?.sendApprovalResponse) {
    const decision = response === 'allow' ? 'accept' : 'decline';
    info.provider.sendApprovalResponse(info.process, pendingRequest.requestId, decision);
  } else if (pendingRequest.toolName === 'AskUserQuestion') {
    respondToAskUserQuestion({
      pendingRequest,
      response,
      sessionId,
    });
  } else {
    respondToPermissionRequest({
      pendingRequest,
      response,
      sessionId,
    });
  }

  info.pendingPermissionRequests?.delete(toolUseId);
  sessionHistory.recordInteractivePromptResponse(sessionId, toolUseId, response);

  logger.info({
    sessionId,
    toolUseId,
    requestId: pendingRequest.requestId,
    toolName: pendingRequest.toolName,
    decision:
      pendingRequest.toolName === CODEX_REQUEST_USER_INPUT_TOOL_NAME
        ? response === '__DECLINE__'
          ? 'declined'
          : 'answered'
        : pendingRequest.toolName === CODEX_MCP_ELICITATION_TOOL_NAME
        ? response === '__DECLINE__' || response === 'deny'
          ? 'declined'
          : 'answered'
        : pendingRequest.toolName === CODEX_PERMISSIONS_REQUEST_TOOL_NAME
        ? response === 'allow'
          ? 'approved'
          : 'denied'
        : pendingRequest.toolName === 'AskUserQuestion'
        ? response === '__DECLINE__'
          ? 'declined'
          : 'answered'
        : response,
  }, 'Control_response sent');
}

export async function clearUnreadFromWebSocket({
  sendToUser,
  sessionId,
  userId,
}: SessionActionOptions & SessionControlRequest): Promise<void> {
  try {
    sendToUser(userId, {
      type: 'unread_cleared',
      sessionId,
      unreadCount: 0,
    });

    logger.info({ userId, sessionId }, 'Unread count cleared');
  } catch (err) {
    logger.error({ userId, sessionId, error: err }, 'Mark as read error');
    sendToUser(userId, {
      type: 'error',
      code: 'mark_as_read_failed',
      message: 'Failed to mark as read',
    });
  }
}

export function runProcessManagerControlAction({
  action,
  errorCode,
  errorMessage,
  logMessage,
  logMetadata,
  sendToUser,
  sessionId,
  userId,
}: ProcessManagerControlOptions): void {
  const success = action(sessionId);

  if (!success) {
    sendToUser(userId, {
      type: 'error',
      sessionId,
      code: errorCode,
      message: errorMessage,
    });
  }

  logger.info({ userId, sessionId, success, ...logMetadata }, logMessage);
}

function isAutoTitlePlaceholderTitle(title: string): boolean {
  const normalized = title.trim();
  return normalized.startsWith('Session ') || AUTO_TITLE_PLACEHOLDER_TITLES.has(normalized);
}

async function maybeAutoSetSessionTitle(
  sessionId: string,
  displayContent: string | ContentBlock[],
): Promise<void> {
  try {
    const dbSession = dbSessions.getSession(sessionId);
    if (
      !dbSession ||
      dbSession.has_custom_title ||
      !isAutoTitlePlaceholderTitle(dbSession.title)
    ) {
      return;
    }

    const events = await sessionHistory.readEvents(sessionId);
    const userMessageCount = events.filter((event) => event.type === 'user_message').length;
    if (userMessageCount !== 1) {
      return;
    }

    const titleText =
      typeof displayContent === 'string'
        ? displayContent
        : displayContent
            .filter((block): block is TextContentBlock => block.type === 'text')
            .map((block) => block.text)
            .join(' ');
    const autoTitle = generateSessionTitle(titleText);
    if (autoTitle) {
      dbSessions.updateSession(sessionId, { title: autoTitle }, { skipTimestamp: true });
      syncSingleSessionTaskTitleFromSession(sessionId, autoTitle);
    }
  } catch (err) {
    logger.warn({ sessionId, error: err }, 'Failed to auto-set session title');
  }
}

async function sendCodexSkillMessage({
  content,
  processInfo,
  sendToUser,
  sessionId,
  skillName,
  userId,
}: {
  content: string | ContentBlock[];
  processInfo: ProcessInfo;
  sendToUser: WsSendToUser;
  sessionId: string;
  skillName: string;
  userId: string;
}): Promise<void> {
  const skillSource = processInfo.skillSource;
  if (!skillSource) {
    logger.warn('Codex session has no skillSource; rejecting skill invocation', {
      sessionId,
      skillName,
    });
    sendToUser(userId, {
      type: 'error',
      sessionId,
      code: 'codex_skill_unavailable',
      message: `Codex skill "/${skillName}" is unavailable in this session.`,
    });
    return;
  }

  let skills: SkillInfo[];
  try {
    skills = await skillSource.listSkills();
  } catch (err) {
    logger.error('Failed to list Codex skills; rejecting skill invocation', {
      sessionId,
      skillName,
      error: (err as Error).message,
    });
    sendToUser(userId, {
      type: 'error',
      sessionId,
      code: 'codex_skill_lookup_failed',
      message: `Failed to load Codex skills for "/${skillName}".`,
    });
    return;
  }

  const skill = skills.find((candidate) => candidate.name === skillName);
  if (!skill?.path) {
    logger.warn('Codex skill not found or has no path; rejecting skill invocation', {
      sessionId,
      skillName,
      found: !!skill,
      hasPath: !!skill?.path,
    });
    sendToUser(userId, {
      type: 'error',
      sessionId,
      code: 'codex_skill_not_found',
      message: `Codex skill "/${skillName}" is not available in this session.`,
    });
    return;
  }

  await processManager.sendMessage(
    sessionId,
    buildCodexSkillContent(content, skillName, skill.path),
  );
  logger.info('Codex skill block sent', { sessionId, skillName, skillPath: skill.path });
}

function respondToAskUserQuestion({
  pendingRequest,
  response,
  sessionId,
}: {
  pendingRequest: PendingPermissionRequest;
  response: string;
  sessionId: string;
}): void {
  if (response === '__DECLINE__') {
    protocolAdapter.sendControlResponse(sessionId, pendingRequest.requestId, {
      behavior: 'deny',
      message: 'User declined to answer questions',
    });
    return;
  }

  const questions = (pendingRequest.input.questions || []) as AskUserQuestionItem[];
  protocolAdapter.sendControlResponse(sessionId, pendingRequest.requestId, {
    behavior: 'allow',
    updatedInput: {
      questions,
      answers: transformResponseToAnswers(response, questions),
    },
  });
}

function respondToCodexRequestUserInput({
  processInfo,
  pendingRequest,
  response,
  sessionId,
}: {
  processInfo: ProcessInfo;
  pendingRequest: PendingPermissionRequest;
  response: string;
  sessionId: string;
}): void {
  if (!processInfo.provider.sendJsonRpcResponse) {
    logger.warn({
      sessionId,
      requestId: pendingRequest.requestId,
    }, 'Codex request_user_input cannot be answered without sendJsonRpcResponse');
    return;
  }

  const questions = Array.isArray(pendingRequest.input.questions)
    ? pendingRequest.input.questions as AskUserQuestionItem[]
    : [];

  processInfo.provider.sendJsonRpcResponse(
    processInfo.process,
    pendingRequest.requestId,
    buildCodexRequestUserInputResult(response, questions),
  );
}

function respondToCodexMcpElicitation({
  processInfo,
  pendingRequest,
  response,
  sessionId,
}: {
  processInfo: ProcessInfo;
  pendingRequest: PendingPermissionRequest;
  response: string;
  sessionId: string;
}): void {
  if (!processInfo.provider.sendJsonRpcResponse) {
    logger.warn({
      sessionId,
      requestId: pendingRequest.requestId,
    }, 'Codex MCP elicitation cannot be answered without sendJsonRpcResponse');
    return;
  }

  processInfo.provider.sendJsonRpcResponse(
    processInfo.process,
    pendingRequest.requestId,
    buildCodexMcpElicitationResult(response, pendingRequest.input),
  );
}

function respondToCodexPermissionsRequest({
  processInfo,
  pendingRequest,
  response,
  sessionId,
}: {
  processInfo: ProcessInfo;
  pendingRequest: PendingPermissionRequest;
  response: string;
  sessionId: string;
}): void {
  if (!processInfo.provider.sendJsonRpcResponse) {
    logger.warn({
      sessionId,
      requestId: pendingRequest.requestId,
    }, 'Codex permissions request cannot be answered without sendJsonRpcResponse');
    return;
  }

  processInfo.provider.sendJsonRpcResponse(
    processInfo.process,
    pendingRequest.requestId,
    buildCodexPermissionsRequestResult(response, pendingRequest.input),
  );
}

function respondToPermissionRequest({
  pendingRequest,
  response,
  sessionId,
}: {
  pendingRequest: PendingPermissionRequest;
  response: string;
  sessionId: string;
}): void {
  if (response === 'allow') {
    protocolAdapter.sendControlResponse(sessionId, pendingRequest.requestId, {
      behavior: 'allow',
      updatedInput: pendingRequest.input,
    });
    return;
  }

  protocolAdapter.sendControlResponse(sessionId, pendingRequest.requestId, {
    behavior: 'deny',
    message: 'User denied permission',
  });
}

function buildCodexRequestUserInputResult(
  response: string,
  questions: AskUserQuestionItem[],
): CodexRequestUserInputResult {
  if (response === '__DECLINE__') {
    return { answers: {} };
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(response);
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    // Plain string response is valid for single-question prompts.
  }

  if (!parsed) {
    const question = questions[0];
    if (!question) return { answers: {} };
    return {
      answers: {
        [codexQuestionId(question)]: { answers: [response] },
      },
    };
  }

  const answers: CodexRequestUserInputResult['answers'] = {};
  const headerCounts: Record<string, number> = {};

  for (const question of questions) {
    const count = headerCounts[question.header] || 0;
    const key = count === 0 ? question.header : `${question.header}_${count}`;
    headerCounts[question.header] = count + 1;

    const value = parsed[key];
    if (value === undefined) continue;

    answers[codexQuestionId(question)] = {
      answers: Array.isArray(value) ? value.map(String) : [String(value)],
    };
  }

  return { answers };
}

function buildCodexMcpElicitationResult(
  response: string,
  input: Record<string, any>,
): CodexMcpElicitationResult {
  if (response === '__DECLINE__' || response === 'deny') {
    return { action: 'decline', content: null, _meta: null };
  }

  if (input.mode === 'url') {
    return {
      action: response === 'allow' ? 'accept' : 'decline',
      content: null,
      _meta: null,
    };
  }

  const questions = Array.isArray(input.questions)
    ? input.questions as AskUserQuestionItem[]
    : [];
  const parsed = parsePromptResponseObject(response);
  const content: Record<string, JsonValue> = {};

  questions.forEach((question, index) => {
    const propertyName = codexQuestionId(question);
    const rawValue = parsed
      ? parsed[deduplicatedQuestionHeader(question.header, index, questions)]
      : questions.length === 1
      ? response
      : undefined;

    if (rawValue === undefined) return;

    const propertySchema = getMcpElicitationPropertySchema(input, propertyName);
    const value = coerceMcpElicitationValue(rawValue, propertySchema);
    if (value !== undefined) {
      content[propertyName] = value;
    }
  });

  return {
    action: 'accept',
    content,
    _meta: null,
  };
}

function buildCodexPermissionsRequestResult(
  response: string,
  input: Record<string, any>,
): CodexPermissionsRequestResult {
  if (response !== 'allow') {
    return { permissions: {}, scope: 'turn' };
  }

  return {
    permissions: grantRequestedCodexPermissions(input.permissions),
    scope: 'turn',
  };
}

function codexQuestionId(question: AskUserQuestionItem): string {
  return question.id ?? question.header ?? question.question;
}

function parsePromptResponseObject(response: string): Record<string, unknown> | null {
  try {
    const candidate = JSON.parse(response);
    if (isRecord(candidate)) {
      return candidate;
    }
  } catch {
    // Plain string responses are valid for single-question prompts.
  }
  return null;
}

function deduplicatedQuestionHeader(
  header: string,
  currentIdx: number,
  questions: Array<Pick<AskUserQuestionItem, 'header'>>,
): string {
  let count = 0;
  for (let i = 0; i < currentIdx; i++) {
    if (questions[i].header === header) {
      count++;
    }
  }
  return count === 0 ? header : `${header}_${count}`;
}

function getMcpElicitationPropertySchema(
  input: Record<string, any>,
  propertyName: string,
): Record<string, any> {
  const requestedSchema = isRecord(input.requestedSchema) ? input.requestedSchema : {};
  const properties = isRecord(requestedSchema.properties) ? requestedSchema.properties : {};
  const propertySchema = properties[propertyName];
  return isRecord(propertySchema) ? propertySchema : {};
}

function coerceMcpElicitationValue(
  rawValue: unknown,
  propertySchema: Record<string, any>,
): JsonValue | undefined {
  if (rawValue === undefined) return undefined;

  if (propertySchema.type === 'array') {
    return Array.isArray(rawValue)
      ? rawValue.map((value) => String(value))
      : [String(rawValue)];
  }

  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;

  if (propertySchema.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    return normalized === 'true' || normalized === 'yes' || normalized === 'allow';
  }

  if (propertySchema.type === 'number' || propertySchema.type === 'integer') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return String(value);
    }
    return propertySchema.type === 'integer' ? Math.trunc(parsed) : parsed;
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function grantRequestedCodexPermissions(requested: unknown): Record<string, unknown> {
  if (!isRecord(requested)) return {};

  const permissions: Record<string, unknown> = {};

  if (isRecord(requested.network)) {
    permissions.network = {
      enabled: 'enabled' in requested.network ? requested.network.enabled : null,
    };
  }

  if (isRecord(requested.fileSystem)) {
    const fileSystem: Record<string, unknown> = {};
    if ('read' in requested.fileSystem) {
      fileSystem.read = Array.isArray(requested.fileSystem.read)
        ? requested.fileSystem.read.map(String)
        : null;
    }
    if ('write' in requested.fileSystem) {
      fileSystem.write = Array.isArray(requested.fileSystem.write)
        ? requested.fileSystem.write.map(String)
        : null;
    }
    permissions.fileSystem = fileSystem;
  }

  return permissions;
}

function transformResponseToAnswers(
  response: string,
  questions: Array<Pick<AskUserQuestionItem, 'question' | 'header'>>,
): Record<string, string> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(response);
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    // Plain string response is valid for single-question prompts.
  }

  if (!parsed) {
    return questions.length > 0 ? { [questions[0].question]: response } : {};
  }

  const answers: Record<string, string> = {};
  const headerCounts: Record<string, number> = {};

  for (const question of questions) {
    const count = headerCounts[question.header] || 0;
    const key = count === 0 ? question.header : `${question.header}_${count}`;
    headerCounts[question.header] = count + 1;

    const value = parsed[key];
    if (value === undefined) continue;
    answers[question.question] = Array.isArray(value)
      ? value.join(', ')
      : String(value);
  }

  return answers;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendSessionHistoryToUser({
  activeInteractivePrompt,
  contextUsage,
  messages,
  sendToUser,
  sessionId,
  usage,
  userId,
}: {
  activeInteractivePrompt?: SessionHistoryMessage['activeInteractivePrompt'];
  contextUsage?: SessionHistoryMessage['contextUsage'];
  messages: SessionHistoryMessage['messages'];
  sendToUser: WsSendToUser;
  sessionId: string;
  usage?: SessionHistoryMessage['usage'];
  userId: string;
}): void {
  sendToUser(userId, {
    type: 'session_history',
    sessionId,
    messages,
    usage,
    contextUsage,
    activeInteractivePrompt,
  });
}
