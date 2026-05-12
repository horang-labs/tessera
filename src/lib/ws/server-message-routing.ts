import { getCliStatusSnapshot } from '@/lib/cli/connection-checker';
import { cliProviderRegistry } from '../cli/providers/registry';
import { getAgentEnvironment } from '../cli/spawn-cli';
import { processManager } from '../cli/process-manager';
import * as dbSessions from '../db/sessions';
import logger from '../logger';
import { refreshSessionDiffStateSoon } from '../git/session-diff-refresh';
import { bindTerminalSender } from '../terminal/shared-terminal-manager';
import type { ClientMessage, ServerTransportMessage } from './message-types';
import type { ProviderMeta } from '../cli/providers/types';
import {
  clearUnreadFromWebSocket,
  closeSessionFromWebSocket,
  createSessionFromWebSocket,
  resumeSessionFromWebSocket,
  retrySessionFromWebSocket,
  runProcessManagerControlAction,
  sendCommandsListToWebSocketUser,
  sendInteractiveResponseFromWebSocket,
  sendSessionMessageFromWebSocket,
} from './server-session-actions';

type WsSendToUser = (userId: string, message: ServerTransportMessage) => void;

interface RouteClientTransportMessageOptions {
  message: ClientMessage;
  sendToUser: WsSendToUser;
  userId: string;
}

export function parseClientTransportMessage(data: Buffer): ClientMessage {
  return JSON.parse(data.toString()) as ClientMessage;
}

export function logReceivedClientTransportMessage(
  userId: string,
  message: ClientMessage,
): void {
  logger.debug({
    userId,
    type: message.type,
    requestId: message.requestId,
  }, 'WebSocket message received');
}

export function verifyClientSessionAccess(
  userId: string,
  message: ClientMessage,
  sendToUser: WsSendToUser,
): boolean {
  if (!('sessionId' in message) || !message.sessionId) {
    return true;
  }

  const info = processManager.getProcess(message.sessionId);
  if (info) {
    if (info.userId !== userId) {
      logger.error({
        sessionId: message.sessionId,
        requestUserId: userId,
        ownerUserId: info.userId,
      }, 'Session ownership violation');
      sendToUser(userId, {
        type: 'error',
        sessionId: message.sessionId,
        code: 'unauthorized',
        message: 'You do not own this session',
      });
      return false;
    }
    return true;
  }

  // No process yet (session just created, not spawned). Accept if the session
  // record exists in DB; reject unknown IDs. DB doesn't track per-user
  // ownership, so for unspawned sessions we trust the authenticated user.
  const session = dbSessions.getSession(message.sessionId);
  if (!session) {
    logger.warn('Session not found', {
      sessionId: message.sessionId,
      messageType: message.type,
    });
    sendToUser(userId, {
      type: 'error',
      sessionId: message.sessionId,
      code: 'session_not_found',
      message: 'Session does not exist',
    });
    return false;
  }

  return true;
}

export async function routeClientTransportMessage({
  message,
  sendToUser,
  userId,
}: RouteClientTransportMessageOptions): Promise<void> {
  switch (message.type) {
    case 'create_session':
      await createSessionFromWebSocket({
        userId,
        sendToUser,
        workDir: message.workDir,
        permissionMode: message.permissionMode,
        providerId: message.providerId,
        model: message.model,
        reasoningEffort: message.reasoningEffort,
        serviceTier: message.serviceTier,
        sessionMode: message.sessionMode,
        accessMode: message.accessMode,
        collaborationMode: message.collaborationMode,
        approvalPolicy: message.approvalPolicy,
        sandboxMode: message.sandboxMode,
      });
      return;

    case 'close_session':
      await closeSessionFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        eventType: 'session_closed',
      });
      return;

    case 'send_message':
      await sendSessionMessageFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        content: message.content,
        displayContent: message.displayContent,
        skillName: message.skillName,
        spawnConfig: message.spawnConfig,
      });
      return;

    case 'resume_session':
      await resumeSessionFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        permissionMode: message.permissionMode,
        sessionMode: message.sessionMode,
        accessMode: message.accessMode,
        collaborationMode: message.collaborationMode,
        approvalPolicy: message.approvalPolicy,
        sandboxMode: message.sandboxMode,
        serviceTier: message.serviceTier,
      });
      return;

    case 'retry_session':
      await retrySessionFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
      });
      return;

    case 'interactive_response':
      sendInteractiveResponseFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        toolUseId: message.toolUseId,
        response: message.response,
      });
      return;

    case 'mark_as_read':
      await clearUnreadFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
      });
      return;

    case 'cancel_generation':
      runProcessManagerControlAction({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        action: (sessionId) => processManager.sendInterrupt(sessionId),
        errorCode: 'cancel_failed',
        errorMessage: 'Failed to cancel generation',
        logMessage: 'Cancel generation requested',
      });
      refreshSessionDiffStateSoon(
        message.sessionId,
        userId,
        'cancel_generation requested',
      );
      return;

    case 'set_permission_mode':
      runProcessManagerControlAction({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        action: (sessionId) => processManager.sendSetPermissionMode(sessionId, message.mode, {
          sessionMode: message.sessionMode,
          accessMode: message.accessMode,
          collaborationMode: message.collaborationMode,
          approvalPolicy: message.approvalPolicy,
          sandboxMode: message.sandboxMode,
          serviceTier: message.serviceTier,
        }),
        errorCode: 'set_permission_mode_failed',
        errorMessage: 'Failed to set permission mode',
        logMessage: 'Set permission mode requested',
        logMetadata: {
          mode: message.mode,
          sessionMode: message.sessionMode,
          accessMode: message.accessMode,
        },
      });
      return;

    case 'set_model':
      runProcessManagerControlAction({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        action: (sessionId) => processManager.sendSetModel(sessionId, message.model),
        errorCode: 'set_model_failed',
        errorMessage: 'Failed to set model',
        logMessage: 'Set model requested',
        logMetadata: { model: message.model },
      });
      return;

    case 'set_reasoning_effort':
      runProcessManagerControlAction({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        action: (sessionId) =>
          processManager.sendSetReasoningEffort(sessionId, message.reasoningEffort),
        errorCode: 'set_reasoning_effort_failed',
        errorMessage: 'Failed to set reasoning effort',
        logMessage: 'Set reasoning effort requested',
        logMetadata: { reasoningEffort: message.reasoningEffort },
      });
      return;

    case 'set_service_tier':
      runProcessManagerControlAction({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        action: (sessionId) =>
          processManager.sendSetServiceTier(sessionId, message.serviceTier),
        errorCode: 'set_service_tier_failed',
        errorMessage: 'Failed to set service tier',
        logMessage: 'Set service tier requested',
        logMetadata: { serviceTier: message.serviceTier },
      });
      return;

    case 'stop_session':
      await closeSessionFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        eventType: 'session_stopped',
        logMessage: 'Session stopped',
      });
      return;

    case 'get_commands':
      sendCommandsListToWebSocketUser({
        userId,
        sendToUser,
        sessionId: message.sessionId,
      });
      return;

    case 'list_providers':
      await listProvidersForWebSocketUser(userId, message.requestId, sendToUser);
      return;

    case 'refresh_providers':
      await refreshProvidersForWebSocketUser(userId, message.requestId, sendToUser);
      return;

    case 'check_cli_status':
      await checkCliStatusForWebSocketUser(userId, message.requestId, sendToUser);
      return;

    case 'terminal_create':
      await bindTerminalSender(sendToUser).create({
        userId,
        terminalId: message.terminalId,
        cwd: message.cwd,
        sessionId: message.sessionId,
        shellKind: message.shellKind,
        cols: message.cols,
        rows: message.rows,
      });
      return;

    case 'terminal_input':
      bindTerminalSender(sendToUser).write(message.terminalId, userId, message.data);
      return;

    case 'terminal_resize':
      bindTerminalSender(sendToUser).resize(message.terminalId, userId, message.cols, message.rows);
      return;

    case 'terminal_close':
      bindTerminalSender(sendToUser).close(message.terminalId, userId);
      return;

    default:
      logUnknownClientTransportMessage(userId, message);
  }
}

async function listProvidersForWebSocketUser(
  userId: string,
  requestId: string,
  sendToUser: WsSendToUser,
): Promise<void> {
  try {
    const agentEnvironment = await getAgentEnvironment(userId);
    const providers = await checkProviderStatusesForEnvironment(userId, agentEnvironment);
    sendToUser(userId, {
      type: 'providers_list',
      requestId,
      providers,
    });
    logger.info('Providers list sent', {
      userId,
      agentEnvironment,
      providerCount: providers.length,
    });
  } catch (err) {
    logger.error('Failed to list providers', {
      userId,
      error: (err as Error).message,
    });
    sendToUser(userId, {
      type: 'error',
      requestId,
      code: 'list_providers_failed',
      message: 'Failed to list providers',
    });
  }
}

async function refreshProvidersForWebSocketUser(
  userId: string,
  requestId: string,
  sendToUser: WsSendToUser,
): Promise<void> {
  try {
    const agentEnvironment = await getAgentEnvironment(userId);
    const providers = await checkProviderStatusesForEnvironment(userId, agentEnvironment, { force: true });
    sendToUser(userId, {
      type: 'providers_list',
      requestId,
      providers,
    });
    logger.info('Providers refreshed', {
      userId,
      agentEnvironment,
      providerCount: providers.length,
    });
  } catch (err) {
    logger.error('Failed to refresh providers', {
      userId,
      error: (err as Error).message,
    });
    sendToUser(userId, {
      type: 'error',
      requestId,
      code: 'refresh_providers_failed',
      message: 'Failed to refresh providers',
    });
  }
}

async function checkCliStatusForWebSocketUser(
  userId: string,
  requestId: string,
  sendToUser: WsSendToUser,
): Promise<void> {
  try {
    const results = await getCliStatusSnapshot({ force: true, userId });
    sendToUser(userId, {
      type: 'cli_status_result',
      requestId,
      results,
    });
    logger.info('CLI status sent', { userId, resultCount: results.length });
  } catch (err) {
    logger.error('Failed to check CLI status', {
      userId,
      error: (err as Error).message,
    });
    sendToUser(userId, {
      type: 'error',
      code: 'check_cli_status_failed',
      message: 'Failed to check CLI status',
      requestId,
    });
  }
}

async function checkProviderStatusesForEnvironment(
  userId: string,
  agentEnvironment: 'native' | 'wsl',
  options: { force?: boolean } = {},
): Promise<ProviderMeta[]> {
  const results = options.force
    ? await getCliStatusSnapshot({ force: true, userId })
    : await getCliStatusSnapshot({ userId });
  const byId = new Map(
    results
      .filter((r) => r.environment === agentEnvironment)
      .map((r) => [r.providerId, r]),
  );

  return cliProviderRegistry.getProviderIds().map((id) => {
    const provider = cliProviderRegistry.getProvider(id);
    const entry = byId.get(id);
    const status = entry?.status ?? 'not_installed';
    return {
      id,
      displayName: provider.getDisplayName(),
      available: status === 'connected',
      status,
      ...(entry?.version ? { version: entry.version } : {}),
    };
  });
}

function logUnknownClientTransportMessage(
  userId: string,
  message: ClientMessage,
): void {
  const rawStr = JSON.stringify(message);
  logger.warn({
    userId,
    type: message.type,
    msgKeys: Object.keys(message).join(','),
    rawPreview: rawStr.length > 300 ? `${rawStr.slice(0, 300)}...` : rawStr,
  }, 'Unknown message type');
}
