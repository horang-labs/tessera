import { getCliStatusSnapshot } from '@/lib/cli/connection-checker';
import { cliProviderRegistry } from '../cli/providers/registry';
import { getAgentEnvironment } from '../cli/spawn-cli';
import { processManager } from '../cli/process-manager';
import * as dbSessions from '../db/sessions';
import logger from '../logger';
import { refreshSessionDiffStateSoon } from '../git/session-diff-refresh';
import { bindTerminalSender } from '../terminal/shared-terminal-manager';
import {
  resolveTerminalLaunchIntent,
  TerminalLaunchIntentError,
} from '../terminal/terminal-launch-intent';
import {
  beginTesseraSessionOperation,
  endTesseraSessionOperation,
  releaseTerminalHandoffByTerminal,
} from '../terminal/terminal-handoff-lock';
import { workspaceFileWatchManager } from '../workspace-files/workspace-file-watch-manager';
import type { ClientMessage, ServerTransportMessage } from './message-types';
import type { ProviderMeta } from '../cli/providers/types';
import {
  clearUnreadFromWebSocket,
  clearSessionGoalFromWebSocket,
  closeSessionFromWebSocket,
  compactSessionFromWebSocket,
  createSessionFromWebSocket,
  refreshSessionGoalFromWebSocket,
  resumeSessionFromWebSocket,
  retrySessionFromWebSocket,
  runProcessManagerControlAction,
  sendCommandsListToWebSocketUser,
  sendInteractiveResponseFromWebSocket,
  sendSessionMessageFromWebSocket,
  setSessionGoalFromWebSocket,
  translateMessageFromWebSocket,
} from './server-session-actions';

type WsSendToUser = (userId: string, message: ServerTransportMessage) => void;

interface RouteClientTransportMessageOptions {
  connectionId: string;
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
  connectionId,
  message,
  sendToUser,
  userId,
}: RouteClientTransportMessageOptions): Promise<void> {
  const unguardedSessionMessage = message.type === 'terminal_create'
    || message.type === 'subscribe_workspace_files'
    || message.type === 'unsubscribe_workspace_files'
    || message.type === 'mark_as_read'
    || message.type === 'get_commands';
  const guardedSessionId = !unguardedSessionMessage && 'sessionId' in message
    ? message.sessionId
    : null;
  if (guardedSessionId && !beginTesseraSessionOperation(guardedSessionId)) {
    sendToUser(userId, {
      type: 'error',
      sessionId: guardedSessionId,
      code: 'session_handed_off_to_terminal',
      message: 'Close the Codex terminal before using this session in Tessera.',
    });
    return;
  }

  try {
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
        forceTranslateInput: message.forceTranslateInput,
        messageId: message.messageId,
      });
      return;

    case 'translate_message':
      translateMessageFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        messageId: message.messageId,
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

    case 'compact_session':
      await compactSessionFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        spawnConfig: message.spawnConfig,
        displayContent: message.displayContent,
      });
      return;

    case 'set_session_goal':
      await setSessionGoalFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        spawnConfig: message.spawnConfig,
        update: message.update,
        displayContent: message.displayContent,
      });
      return;

    case 'refresh_session_goal':
      await refreshSessionGoalFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        spawnConfig: message.spawnConfig,
        displayContent: message.displayContent,
      });
      return;

    case 'clear_session_goal':
      await clearSessionGoalFromWebSocket({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        spawnConfig: message.spawnConfig,
        displayContent: message.displayContent,
      });
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
      if (!processManager.getProcess(message.sessionId)) {
        if (message.persist !== false) {
          dbSessions.updateSession(
            message.sessionId,
            { service_tier: message.serviceTier },
            { skipTimestamp: true },
          );
        }
        logger.info({
          sessionId: message.sessionId,
          serviceTier: message.serviceTier,
          persisted: message.persist !== false,
        }, 'Stored service tier for an inactive session');
        return;
      }

      if (!processManager.sendSetServiceTier(message.sessionId, message.serviceTier)) {
        sendToUser(userId, {
          type: 'error',
          sessionId: message.sessionId,
          code: 'set_service_tier_failed',
          message: 'Failed to set service tier',
        });
        return;
      }

      if (message.persist !== false) {
        dbSessions.updateSession(
          message.sessionId,
          { service_tier: message.serviceTier },
          { skipTimestamp: true },
        );
      }
      logger.info({
        sessionId: message.sessionId,
        serviceTier: message.serviceTier,
        persisted: message.persist !== false,
      }, 'Set service tier requested');
      return;

    case 'set_fast_mode':
      runProcessManagerControlAction({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        action: (sessionId) =>
          processManager.sendSetFastMode(sessionId, message.fastMode),
        errorCode: 'set_fast_mode_failed',
        errorMessage: 'Failed to set fast mode',
        logMessage: 'Set fast mode requested',
        logMetadata: { fastMode: message.fastMode },
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
      const terminalManager = bindTerminalSender(sendToUser);
      const launchReservation = message.launchIntent
        ? terminalManager.reserveTerminalLaunch(message.terminalId, userId) ?? undefined
        : undefined;
      if (message.launchIntent && !launchReservation) {
        if (terminalManager.attach(
          message.terminalId,
          userId,
          message.cols,
          message.rows,
        )) {
          return;
        }
        sendToUser(userId, {
          type: 'terminal_error',
          terminalId: message.terminalId,
          message: 'This terminal is already running or starting.',
        });
        return;
      }
      let acquiredHandoff = false;
      try {
        const launchSpec = message.launchIntent
          ? await resolveTerminalLaunchIntent({
              intent: message.launchIntent,
              sessionId: message.sessionId,
              terminalId: message.terminalId,
              userId,
            })
          : undefined;
        acquiredHandoff = Boolean(launchSpec?.handoffSessionId);
        if (launchReservation && !terminalManager.isTerminalLaunchReserved(launchReservation)) {
          throw new TerminalLaunchIntentError(
            'Terminal startup was cancelled.',
            'terminal_cancelled',
          );
        }
        if (launchSpec?.handoffSessionId) {
          await closeSessionFromWebSocket({
            userId,
            sendToUser,
            sessionId: launchSpec.handoffSessionId,
            eventType: 'session_stopped',
            logMessage: 'Session handed off to Codex terminal',
          });
        }
        if (launchReservation && !terminalManager.isTerminalLaunchReserved(launchReservation)) {
          throw new TerminalLaunchIntentError(
            'Terminal startup was cancelled.',
            'terminal_cancelled',
          );
        }
        await terminalManager.create({
          userId,
          terminalId: message.terminalId,
          cwd: launchSpec?.cwd ?? message.cwd,
          sessionId: message.sessionId,
          // Launch intents use the server-side environment; only ordinary raw
          // terminals may accept a client-selected shell.
          shellKind: launchSpec ? undefined : message.shellKind,
          cols: message.cols,
          rows: message.rows,
          launchSpec,
        }, launchReservation);
      } catch (error) {
        if (acquiredHandoff) {
          releaseTerminalHandoffByTerminal(userId, message.terminalId);
        }
        logger.warn({ error, terminalId: message.terminalId }, 'Rejected terminal launch intent');
        sendToUser(userId, {
          type: 'terminal_error',
          terminalId: message.terminalId,
          message: error instanceof TerminalLaunchIntentError
            ? error.message
            : 'Failed to prepare terminal command.',
        });
      } finally {
        if (launchReservation) {
          terminalManager.releaseTerminalLaunchReservation(launchReservation);
        }
      }
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

    case 'subscribe_workspace_files':
      await workspaceFileWatchManager.subscribe({
        connectionId,
        sendToUser,
        sessionId: message.sessionId,
        subscriberId: message.subscriberId,
        userId,
      });
      return;

    case 'unsubscribe_workspace_files':
      workspaceFileWatchManager.unsubscribe({
        connectionId,
        sessionId: message.sessionId,
        subscriberId: message.subscriberId,
      });
      return;

      default:
        logUnknownClientTransportMessage(userId, message);
    }
  } finally {
    if (guardedSessionId) {
      endTesseraSessionOperation(guardedSessionId);
    }
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
