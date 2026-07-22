import { getCliStatusSnapshot } from '@/lib/cli/connection-checker';
import { cliProviderRegistry } from '../cli/providers/registry';
import { getAgentEnvironment } from '../cli/spawn-cli';
import { processManager } from '../cli/process-manager';
import * as dbSessions from '../db/sessions';
import { sessionHistory } from '../session-history';
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
import { mintPaneToken } from '../terminal/pane-token-registry';
import { buildProviderTerminalLaunch } from '../terminal/provider-launch';
import { resolveTerminalProviderSessionReference } from '../terminal/provider-session-identity';
import { detectTerminalProviders } from '../terminal/provider-detection';
import { SettingsManager } from '../settings/manager';
import { createCodexOverlay } from '../terminal/codex-overlay';
import { createCodexOverlayInWsl } from '../terminal/codex-overlay-wsl';
import { buildClaudeHookSettingsJson } from '../terminal/claude-hook-settings';
import type { HookCommandStyle } from '../terminal/hook-command';
import { getRuntimePlatform } from '../system/runtime-platform';
import { createOpenCodeOverlay } from '../terminal/opencode-overlay';
import { createOpenCodeOverlayInWsl } from '../terminal/opencode-overlay-wsl';
import { createTerminalProviderSessionObserver } from '../terminal/provider-session-observer';
import { getTerminalProviderSessionForTesseraSession } from '../db/terminal-provider-sessions';
import { observeTerminalProviderSession } from '../terminal/provider-session-observation';
import type { TerminalCreateOptions, TerminalLaunchSpec } from '../terminal/types';
import { workspaceFileWatchManager } from '../workspace-files/workspace-file-watch-manager';
import type { ClientMessage, ServerTransportMessage } from './message-types';
import type { CliProvider, ProviderMeta } from '../cli/providers/types';
import {
  clearUnreadFromWebSocket,
  closeSessionFromWebSocket,
  compactSessionFromWebSocket,
  createSessionFromWebSocket,
  resumeSessionFromWebSocket,
  retrySessionFromWebSocket,
  runProcessManagerControlAction,
  sendCommandsListToWebSocketUser,
  sendInteractiveResponseFromWebSocket,
  sendSessionMessageFromWebSocket,
  translateMessageFromWebSocket,
} from './server-session-actions';

type WsSendToUser = (userId: string, message: ServerTransportMessage) => void;
type WsSendToConnection = (connectionId: string, message: ServerTransportMessage) => void;

interface RouteClientTransportMessageOptions {
  connectionId: string;
  message: ClientMessage;
  sendToConnection: WsSendToConnection;
  sendToUser: WsSendToUser;
  userId: string;
}

const SAFE_TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeTerminalIdentity(value: unknown): value is string {
  return typeof value === 'string' && SAFE_TERMINAL_ID.test(value);
}

function terminalInputText(content: Extract<ClientMessage, { type: 'send_message' }>['content']): string {
  if (typeof content === 'string') return content.trim();
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
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
  sendToConnection,
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
  let pendingTerminalReservation: {
    manager: ReturnType<typeof bindTerminalSender>;
    sessionId: string;
    terminalId: string;
  } | null = null;
  if (guardedSessionId && !beginTesseraSessionOperation(guardedSessionId)) {
    sendToUser(userId, {
      type: 'error',
      sessionId: guardedSessionId,
      code: 'session_handed_off_to_terminal',
      message: 'Close the Codex terminal before using this session in Tessera.',
    });
    return;
  }

  if ('terminalId' in message) {
    const invalidTerminal = !isSafeTerminalIdentity(message.terminalId);
    const terminalId = !invalidTerminal ? message.terminalId : 'invalid-terminal';
    const invalidSurface = 'surfaceId' in message && !isSafeTerminalIdentity(message.surfaceId);
    if (invalidTerminal || invalidSurface) {
      sendToConnection(connectionId, {
        type: 'terminal_error',
        terminalId,
        ...('surfaceId' in message && typeof message.surfaceId === 'string'
          ? { surfaceId: message.surfaceId }
          : {}),
        message: 'Invalid terminal identity.',
      });
      return;
    }
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
        executionMode: message.executionMode,
      });
      return;

    case 'close_session':
      bindTerminalSender(sendToConnection).preventSessionOpen(message.sessionId, userId);
      try {
        await bindTerminalSender(sendToConnection).closeSession(message.sessionId, userId);
        await closeSessionFromWebSocket({
          userId,
          sendToUser,
          sessionId: message.sessionId,
          eventType: 'session_closed',
        });
      } finally {
        bindTerminalSender(sendToConnection).allowSessionOpen(message.sessionId, userId);
      }
      return;

    case 'send_message':
      if (
        dbSessions.extractSessionKind(
          dbSessions.getSession(message.sessionId)?.provider_state ?? null,
        ) === 'terminal'
      ) {
        const text = terminalInputText(message.content);
        const submitted = text.length > 0
          && bindTerminalSender(sendToConnection).submitSessionInput(message.sessionId, userId, text);
        if (!submitted) {
          sendToUser(userId, {
            type: 'error',
            requestId: message.requestId,
            sessionId: message.sessionId,
            code: 'terminal_input_unavailable',
            message: text.length > 0
              ? 'The terminal is not running. Open the session and try again.'
              : 'Terminal sessions only accept text input.',
          });
        }
        return;
      }
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
      bindTerminalSender(sendToConnection).preventSessionOpen(message.sessionId, userId);
      try {
        await bindTerminalSender(sendToConnection).closeSession(message.sessionId, userId);
        await closeSessionFromWebSocket({
          userId,
          sendToUser,
          sessionId: message.sessionId,
          eventType: 'session_stopped',
          logMessage: 'Session stopped',
        });
      } finally {
        bindTerminalSender(sendToConnection).allowSessionOpen(message.sessionId, userId);
      }
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

    case 'terminal_create': {
      const structured = message.launch;
      const isStructuredClaude = structured?.providerId === 'claude-code';
      const isStructuredCodex = structured?.providerId === 'codex';
      const isStructuredOpenCode = structured?.providerId === 'opencode';

      if (structured) {
        const session = dbSessions.getSession(structured.sessionId);
        const supportedProvider = isStructuredClaude || isStructuredCodex || isStructuredOpenCode;
        const matchesPersistedSession = session
          && session.provider === structured.providerId
          && dbSessions.extractSessionKind(session.provider_state) === 'terminal';
        if (!supportedProvider || !matchesPersistedSession) {
          sendToConnection(connectionId, {
            type: 'terminal_error',
            terminalId: message.terminalId,
            surfaceId: message.surfaceId,
            message: 'Terminal launch does not match the persisted session provider.',
          });
          return;
        }
      }

      // 보안: 구조화 launch의 sessionId(클라 입력)를 소유 검증 — 남의 세션 resume 차단(codex 동일).
      if (
        (isStructuredClaude || isStructuredCodex || isStructuredOpenCode) && structured
        && !verifyClientSessionAccess(userId, { ...message, sessionId: structured.sessionId }, sendToUser)
      ) {
        return;
      }

      // create/cwd allowlist용 sessionId(기존 동작 유지).
      const sessionId = structured?.sessionId ?? message.sessionId ?? null;
      // 훅 스타일·codex 오버레이 위치는 "CLI가 실제로 도는 런타임"을 따른다 —
      // resolveShellKind와 같은 소스(getAgentEnvironment)라 스폰과 항상 일치한다.
      const agentEnvironment = structured ? await getAgentEnvironment(userId) : 'native';
      const wslTerminalRuntime = getRuntimePlatform() === 'win32' && agentEnvironment === 'wsl';
      const hookCommandStyle: HookCommandStyle =
        getRuntimePlatform() === 'win32' && !wslTerminalRuntime ? 'windows-cmd' : 'posix';
      const manager = bindTerminalSender(sendToConnection);
      const terminalId = sessionId
        ? manager.reserveTerminalId(userId, message.terminalId, sessionId)
        : message.terminalId;
      if (sessionId) pendingTerminalReservation = { manager, sessionId, terminalId };
      const terminalExists = manager.hasOrIsOpening(terminalId, userId, sessionId);
      let launchSpec: TerminalLaunchSpec | undefined;
      let providerId: string | undefined;
      let launchEnv: Record<string, string> | undefined;
      let launchEnvFactory: (() => Promise<Record<string, string> | undefined>) | undefined;
      let launchObserverDisposer: (() => void) | undefined;
      let appearanceChangePolicy: TerminalCreateOptions['appearanceChangePolicy'];
      let resizeScrollbackPolicy: TerminalCreateOptions['resizeScrollbackPolicy'];
      let interruptInputPolicy: TerminalCreateOptions['interruptInputPolicy'];
      let canRestartForAppearance: TerminalCreateOptions['canRestartForAppearance'];
      let terminalProvider: CliProvider | undefined;
      let acquiredHandoff = false;

      if (!terminalExists && isStructuredClaude && structured) {
        providerId = 'claude-code';
        const settingsJson = buildClaudeHookSettingsJson(hookCommandStyle);
        // Claude emits SessionStart as soon as its empty TUI opens, but does not
        // persist a resumable conversation until the first prompt is submitted.
        // Tessera records that prompt synchronously, so canonical history is the
        // resume boundary; a mere prior PTY launch is not.
        const state = dbSessions.getSession(structured.sessionId)?.provider_state ?? null;
        const providerSession = resolveTerminalProviderSessionReference(
          structured.sessionId,
          state,
        );
        const resume = providerSession.nativeFork
          || await sessionHistory.historyExists(structured.sessionId);
        const built = buildProviderTerminalLaunch({
          providerId: 'claude-code',
          sessionId: providerSession.providerSessionId,
          resume,
          // Older persisted native forks predate activation metadata. Claude's
          // native `/fork` artifact is a background daemon and must be attached.
          providerSessionActivation: providerSession.activation
            ?? (providerSession.nativeFork ? 'background' : undefined),
          settingsJson,
        });
        launchSpec = {
          program: built.command,
          args: built.args,
          prefillInput: message.prefillInput,
        };
      } else if (!terminalExists && isStructuredCodex && structured) {
        providerId = 'codex';
        // resume 판정: 이전 SessionStart 훅에서 캡처한 codexSessionId(rollout id)가 있으면 resume.
        const state = dbSessions.getSession(structured.sessionId)?.provider_state ?? null;
        const codexResumeId = dbSessions.extractCodexTerminalSessionId(state);
        const built = buildProviderTerminalLaunch({
          providerId: 'codex',
          sessionId: structured.sessionId,
          resume: !!codexResumeId,
          codexResumeId,
        });
        launchSpec = {
          program: built.command,
          args: built.args,
          prefillInput: message.prefillInput,
        };
        // CODEX_HOME 오버레이 생성(hooks.json 주입) — env로만 자식에 전달.
        // win32+wsl은 게스트 파일시스템 안에 만든다(호스트 오버레이는 게스트 codex가
        // 못 쓴다: 계정 홈 불일치 + Windows 심링크 EPERM). factory로 넘겨 opening
        // 윈도우 안에서 실행한다 — WSL VM 콜드 부팅으로 수십 초 걸릴 수 있어서,
        // 여기서 await하면 close_session 취소도 중복 create 방지도 그 구간을 못
        // 지킨다. 실패는 create()가 terminal_error로 표면화한다 — 조용히 빈
        // CODEX_HOME을 주면 codex가 로그인 화면부터 띄운다.
        launchEnvFactory = async () => {
          try {
            const overlayHome = wslTerminalRuntime
              ? await createCodexOverlayInWsl(terminalId, hookCommandStyle)
              : createCodexOverlay(terminalId, hookCommandStyle);
            // TESSERA_CODEX_HOME: login 셸 profile이 CODEX_HOME을 덮어도 -c 본문의
            // 재단언(terminal-resolver)이 오버레이로 되돌릴 수 있게 원본을 함께 전달.
            return { CODEX_HOME: overlayHome, TESSERA_CODEX_HOME: overlayHome };
          } catch (error) {
            logger.error({ error, terminalId }, 'Failed to prepare the Codex overlay');
            throw new Error(
              `Failed to prepare the Codex overlay: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };
      } else if (!terminalExists && isStructuredOpenCode && structured) {
        providerId = 'opencode';
        const state = dbSessions.getSession(structured.sessionId)?.provider_state ?? null;
        const opencodeResumeId = dbSessions.extractOpenCodeTerminalSessionId(state);
        const built = buildProviderTerminalLaunch({
          providerId: 'opencode',
          sessionId: structured.sessionId,
          resume: !!opencodeResumeId,
          opencodeResumeId,
        });
        launchSpec = {
          program: built.command,
          args: built.args,
          prefillInput: message.prefillInput,
        };

        if (wslTerminalRuntime) {
          // Windows의 세션별 설정 폴더를 /mnt/c로 넘기면 OpenCode가 수천 개의
          // 플러그인 의존성 파일을 매번 DrvFS에 설치한다. WSL 안의 공용 폴더를
          // 준비해 설치 결과를 재사용하고, 반환된 POSIX 경로는 /p 변환 없이 넘긴다.
          launchEnvFactory = async () => {
            try {
              const overlayDir = await createOpenCodeOverlayInWsl();
              return {
                OPENCODE_CONFIG_DIR: overlayDir,
                ...(opencodeResumeId ? { TESSERA_OPENCODE_RESUME_ID: opencodeResumeId } : {}),
              };
            } catch (error) {
              logger.error({ error, terminalId }, 'Failed to prepare the OpenCode WSL overlay');
              throw new Error(
                `Failed to prepare the OpenCode WSL overlay: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          };
        } else {
          try {
            const overlay = createOpenCodeOverlay(terminalId);
            launchObserverDisposer = overlay.dispose;
            launchEnv = {
              OPENCODE_CONFIG_DIR: overlay.configDir,
              ...(opencodeResumeId ? { TESSERA_OPENCODE_RESUME_ID: opencodeResumeId } : {}),
            };
          } catch (error) {
            launchObserverDisposer?.();
            sendToConnection(connectionId, {
              type: 'terminal_error',
              terminalId: message.terminalId,
              surfaceId: message.surfaceId,
              message: error instanceof Error ? error.message : 'Unable to prepare the OpenCode invocation.',
            });
            return;
          }
        }
      } else if (!terminalExists && message.launchIntent) {
        try {
          providerId = message.launchIntent.kind === 'codex-slash' ? 'codex' : 'claude-code';
          launchSpec = await resolveTerminalLaunchIntent({
            intent: message.launchIntent,
            sessionId: message.sessionId,
            terminalId,
            userId,
          });
          acquiredHandoff = Boolean(launchSpec.handoffSessionId);
          if (launchSpec.handoffSessionId) {
            await closeSessionFromWebSocket({
              userId,
              sendToUser,
              sessionId: launchSpec.handoffSessionId,
              eventType: 'session_stopped',
              logMessage: 'Session handed off to Codex terminal',
            });
          }
        } catch (error) {
          if (acquiredHandoff) releaseTerminalHandoffByTerminal(userId, terminalId);
          logger.warn({ error, terminalId }, 'Rejected terminal launch intent');
          sendToConnection(connectionId, {
            type: 'terminal_error',
            terminalId,
            surfaceId: message.surfaceId,
            message: error instanceof TerminalLaunchIntentError
              ? error.message
              : 'Failed to prepare terminal command.',
          });
          return;
        }
      }

      if (!terminalExists && providerId) {
        const provider = cliProviderRegistry.getProvider(providerId);
        terminalProvider = provider;
        appearanceChangePolicy = provider.getTerminalAppearanceChangePolicy();
        resizeScrollbackPolicy = provider.getTerminalResizeScrollbackPolicy();
        interruptInputPolicy = provider.getTerminalInterruptInputPolicy();
        if (appearanceChangePolicy === 'restart' && structured) {
          canRestartForAppearance = () => provider.canResumeTerminalAfterRestart?.(
            dbSessions.getSession(structured.sessionId)?.provider_state ?? null,
          ) ?? false;
        } else if (appearanceChangePolicy === 'restart' && launchSpec?.handoffSessionId) {
          // A handoff intent already validated a stable provider thread id and
          // can safely resolve the same resume recipe again after PTY exit.
          canRestartForAppearance = () => true;
        }
      }

      // paneToken sessionId: slash-fallback은 ambient(chat) id라 상태 오귀속 방지 위해 null.
      const tokenSessionId = (
        isStructuredClaude || isStructuredCodex || isStructuredOpenCode
      ) && structured ? structured.sessionId : null;
      const paneToken = !terminalExists && providerId
        ? mintPaneToken({ terminalId, userId, sessionId: tokenSessionId, providerId })
        : undefined;
      if (!terminalExists && providerId && terminalProvider && paneToken && sessionId) {
        const existingDisposer = launchObserverDisposer;
        const providerSessionObserver = createTerminalProviderSessionObserver({
          provider: terminalProvider,
          currentProviderSessionId: () => {
            const activeSessionId = manager.getSessionIdForTerminal(terminalId, userId)
              ?? sessionId;
            return getTerminalProviderSessionForTesseraSession(activeSessionId)
              ?.provider_session_id;
          },
          onObservation: ({ activation, identity }) => {
            try {
              observeTerminalProviderSession({
                pane: { terminalId, userId, sessionId, providerId },
                identity,
                activation,
              });
            } catch (error) {
              logger.warn({ error, providerId, terminalId },
                'Provider session observation could not be reconciled');
            }
          },
        });
        await providerSessionObserver.ready();
        launchObserverDisposer = () => {
          providerSessionObserver.dispose();
          existingDisposer?.();
        };
      }

      try {
        pendingTerminalReservation = null;
        await manager.create({
          userId,
          connectionId,
          surfaceId: message.surfaceId,
          previewOwnerToken: message.previewOwnerToken,
          terminalId,
          cwd: message.cwd,
          sessionId,
          shellKind: launchSpec ? undefined : message.shellKind,
          cols: message.cols,
          rows: message.rows,
          launchSpec,
          paneToken,
          providerId,
          detectConversationReset: terminalProvider?.detectTerminalConversationReset
            ? (options) => Boolean(
              terminalProvider.detectTerminalConversationReset?.(options),
            )
            : undefined,
          appearanceChangePolicy,
          resizeScrollbackPolicy,
          interruptInputPolicy,
          canRestartForAppearance,
          appearanceRestartIntent: launchSpec?.handoffSessionId ? message.launchIntent : undefined,
          appearance: message.appearance,
          launchEnv,
          launchEnvFactory,
          launchObserverDisposer,
        });
      } catch (error) {
        launchObserverDisposer?.();
        if (acquiredHandoff) releaseTerminalHandoffByTerminal(userId, terminalId);
        throw error;
      }
      return;
    }

    case 'terminal_detach':
      bindTerminalSender(sendToConnection).detach(
        message.terminalId,
        userId,
        connectionId,
        message.surfaceId,
      );
      return;

    case 'terminal_release_preview':
      await bindTerminalSender(sendToConnection).releasePreview(
        message.terminalId,
        userId,
        message.sessionId,
        message.previewOwnerToken,
      );
      return;

    case 'terminal_input':
      bindTerminalSender(sendToConnection).write(
        message.terminalId,
        userId,
        connectionId,
        message.surfaceId,
        message.data,
      );
      return;

    case 'terminal_set_appearance':
      bindTerminalSender(sendToConnection).setAppearance(
        message.terminalId,
        userId,
        connectionId,
        message.surfaceId,
        message.appearance,
      );
      return;

    case 'terminal_resize':
      bindTerminalSender(sendToConnection).resize(
        message.terminalId,
        userId,
        connectionId,
        message.surfaceId,
        message.cols,
        message.rows,
        message.claim,
      );
      return;

    case 'terminal_close':
      await bindTerminalSender(sendToConnection).close(message.terminalId, userId);
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
    if (pendingTerminalReservation) {
      pendingTerminalReservation.manager.releaseTerminalReservation(
        userId,
        pendingTerminalReservation.sessionId,
        pendingTerminalReservation.terminalId,
      );
    }
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
    const providers = await resolveProvidersForUser(userId);
    sendToUser(userId, {
      type: 'providers_list',
      requestId,
      providers,
    });
    logger.info('Providers list sent', {
      userId,
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
    const providers = await resolveProvidersForUser(userId, { force: true });
    sendToUser(userId, {
      type: 'providers_list',
      requestId,
      providers,
    });
    logger.info('Providers refreshed', {
      userId,
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
    const results = await resolveCliStatusesForUser(userId);
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

/**
 * 설정 화면의 CLI 상태 리스트도 실행 모드를 따라간다.
 *  - pty: which-only 감지 결과를 CliStatusEntry 형태로 매핑(버전/auth 정보 없음).
 *  - gui: 기존 풀 프로브(getCliStatusSnapshot) 그대로.
 */
async function resolveCliStatusesForUser(userId: string) {
  const settings = await SettingsManager.load(userId, { silent: true });

  if (settings.agentExecutionMode === 'pty') {
    const agentEnvironment = await getAgentEnvironment(userId);
    const detections = await detectTerminalProviders({ force: true, environment: agentEnvironment });
    return detections.map((detection) => ({
      providerId: detection.providerId,
      environment: agentEnvironment,
      status: detection.installed ? 'connected' as const : 'not_installed' as const,
    }));
  }

  return getCliStatusSnapshot({ force: true, userId });
}

/**
 * 실행 모드별 프로바이더 목록.
 *  - pty: 로그인 셸 which-only 감지(설치 여부만, auth 안 봄) — 어드바이저리.
 *         카탈로그 전부를 노출하고 설치된 것만 connected로 표시한다.
 *  - gui: 기존 version+auth 프로브 그대로(직접 spawn의 전제조건이므로 불변).
 */
async function resolveProvidersForUser(
  userId: string,
  options: { force?: boolean } = {},
): Promise<ProviderMeta[]> {
  const settings = await SettingsManager.load(userId, { silent: true });

  if (settings.agentExecutionMode === 'pty') {
    const detections = await detectTerminalProviders({
      force: options.force,
      environment: await getAgentEnvironment(userId),
    });
    return detections.map((detection) => ({
      id: detection.providerId,
      displayName: resolveProviderDisplayName(detection.providerId),
      available: detection.installed,
      status: detection.installed ? 'connected' as const : 'not_installed' as const,
    }));
  }

  const agentEnvironment = await getAgentEnvironment(userId);
  return checkProviderStatusesForEnvironment(userId, agentEnvironment, options);
}

// getProvider는 미등록 id에 throw하므로 표시명 조회는 fallback으로 감싼다.
function resolveProviderDisplayName(providerId: string): string {
  try {
    return cliProviderRegistry.getProvider(providerId).getDisplayName();
  } catch {
    return providerId;
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
