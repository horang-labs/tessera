import { v4 as uuidv4 } from 'uuid';
import type { ProviderMeta } from '@/lib/cli/providers/types';
import type { CliStatusEntry } from '@/lib/cli/connection-checker';
import { applySessionReplayEventsToStores } from '@/lib/chat/apply-session-replay-events';
import { restoreSessionReplay } from '@/lib/chat/restore-session-replay';
import {
  finalizeInFlightTurn,
  startTurnInFlight,
  stopTurnInFlight,
} from '@/lib/chat/session-client-effects';
import { serverMessageToReplayEvents } from '@/lib/chat/server-message-to-replay-events';
import { useChatStore } from '@/stores/chat-store';
import { useTerminalSessionStore } from '@/stores/terminal-session-store';
import { useCommandStore } from '@/stores/command-store';
import { useGitPanelStore } from '@/stores/git-panel-store';
import { useNotificationStore } from '@/stores/notification-store';
import { useRateLimitStore } from '@/stores/rate-limit-store';
import { useSessionStore } from '@/stores/session-store';
import { useSessionPrStore } from '@/stores/session-pr-store';
import { useSkillAnalysisStore } from '@/stores/skill-analysis-store';
import { useTaskStore } from '@/stores/task-store';
import { useTabStore } from '@/stores/tab-store';
import { useUsageStore } from '@/stores/usage-store';
import { useCollectionStore } from '@/stores/collection-store';
import { i18n } from '@/lib/i18n';
import type { ServerTransportMessage } from './message-types';
import { getClientId } from './client-id';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { invalidateProviderSessionOptionsClientCache } from '@/hooks/use-provider-session-options';

interface HandleIncomingServerMessageOptions {
  msg: ServerTransportMessage;
  providersListCallbacks: Map<string, (providers: ProviderMeta[]) => void>;
  cliStatusCallbacks: Map<string, (results: CliStatusEntry[] | null) => void>;
  wasReconnect: boolean;
}

export function handleIncomingServerMessage({
  msg,
  providersListCallbacks,
  cliStatusCallbacks,
  wasReconnect,
}: HandleIncomingServerMessageOptions): { wasReconnect: boolean } {
  const chatStore = useChatStore.getState();
  const sessionStore = useSessionStore.getState();

  switch (msg.type) {
    case 'session_created':
      addCreatedSession(msg, sessionStore);
      return { wasReconnect };

    case 'session_started':
      sessionStore.markSessionRunning(msg.sessionId, msg.sessionId, {
        model: msg.model,
        reasoningEffort: msg.reasoningEffort,
        serviceTier: msg.serviceTier,
        fastMode: msg.fastMode,
        sessionMode: msg.sessionMode,
        accessMode: msg.accessMode,
      });
      return { wasReconnect };

    case 'session_closed':
      sessionStore.removeSession(msg.sessionId);
      useTerminalSessionStore.getState().clearSession(msg.sessionId);
      chatStore.clearSession(msg.sessionId);
      useUsageStore.getState().clearUsage(msg.sessionId);
      useCommandStore.getState().clearSession(msg.sessionId);
      useSessionPrStore.getState().clearSession(msg.sessionId);
      return { wasReconnect };

    case 'session_stopped':
      sessionStore.markSessionStopped(msg.sessionId);
      finalizeInFlightTurn(msg.sessionId, { clearPrompt: true });
      // The session was stopped, so any workflow still flagged running can no
      // longer emit its terminal task_notification — settle it instead of
      // leaving the card spinning forever.
      chatStore.settleRunningWorkflows(msg.sessionId, 'failed');
      chatStore.setTodoSnapshot(msg.sessionId, []);
      sessionStore.setSessionWorkflowRunning(msg.sessionId, false);
      useCommandStore.getState().clearSession(msg.sessionId);
      return { wasReconnect };

    case 'replay_events':
      sessionStore.touchSessionActivity(msg.sessionId, getLatestReplayEventTimestamp(msg.events));
      if (shouldStartTurnFromReplayEvents(sessionStore, msg.sessionId, msg.events)) {
        startTurnInFlight(msg.sessionId);
        sessionStore.updateSessionStatus(msg.sessionId, 'running');
      }
      applySessionReplayEventsToStores(msg.sessionId, msg.events);
      return { wasReconnect };

    case 'notification':
      sessionStore.touchSessionActivity(msg.sessionId);
      handleNotificationMessage(msg, sessionStore.activeSessionId);
      if (msg.event === 'completed') {
        finalizeInFlightTurn(msg.sessionId, { clearPrompt: true });
        sessionStore.updateSessionStatus(msg.sessionId, 'completed');
      } else if (msg.event === 'input_required') {
        stopTurnInFlight(msg.sessionId);
        sessionStore.updateSessionStatus(msg.sessionId, 'running');
      }
      applySessionReplayEventsToStores(
        msg.sessionId,
        serverMessageToReplayEvents(msg),
      );
      return { wasReconnect };

    case 'session_state': {
      // 유령 running 방지는 store의 runtimeExited 마커가 담당한다. 세션 목록의
      // isRunning으로 여기서 드롭하면, 목록이 낡아 있는 동안(HTTP refetch 전)
      // 도착한 진짜 running이 영구 유실된다 — session_state는 hook 이벤트
      // 시점에만 push되고 재전송이 없다.
      const changed = useTerminalSessionStore.getState().applySessionState(msg);
      if (changed && msg.status === 'running') {
        const location = useTabStore.getState().findSessionLocation(msg.sessionId);
        if (location) useTabStore.getState().pinTab(location.tabId);
      }
      if (changed && (msg.status === 'completed' || msg.status === 'input_required')) {
        handleTerminalSessionStateMessage(msg, sessionStore.activeSessionId);
      }
      return { wasReconnect };
    }

    case 'terminal_session_runtime':
      sessionStore.setSessionRunning(msg.sessionId, msg.running);
      if (msg.running) {
        useTerminalSessionStore.getState().markRuntimeStarted(msg.sessionId);
      } else {
        useTerminalSessionStore.getState().markRuntimeStopped(msg.sessionId);
        retireStoppedTerminalSessionSurface(msg.sessionId);
      }
      return { wasReconnect };

    case 'terminal_session_runtime_snapshot': {
      sessionStore.applyTerminalRuntimeSnapshot(msg.activeSessionIds);
      const activeTerminalIds = new Set(msg.activeSessionIds);
      for (const sessionId of msg.activeSessionIds) {
        useTerminalSessionStore.getState().markRuntimeStarted(sessionId);
      }
      // terminal-session-store에 이미 hook 상태가 있는 세션은 세션 목록(projects)
      // 로드 전이라도 snapshot 기준으로 정리한다 — 연결 직후에는 projects가 아직
      // 비어 있어 아래 순회가 아무것도 강등하지 못한다.
      for (const sessionId of Object.keys(useTerminalSessionStore.getState().bySessionId)) {
        if (!activeTerminalIds.has(sessionId)) {
          useTerminalSessionStore.getState().markRuntimeStopped(sessionId);
        }
      }
      for (const project of sessionStore.projects) {
        for (const session of project.sessions) {
          if (session.kind === 'terminal' && !activeTerminalIds.has(session.id)) {
            useTerminalSessionStore.getState().markRuntimeStopped(session.id);
            retireStoppedTerminalSessionSurface(session.id);
          }
        }
      }
      return { wasReconnect };
    }

    case 'interactive_prompt':
      sessionStore.touchSessionActivity(msg.sessionId);
      handleInteractivePromptMessage(msg, sessionStore.activeSessionId);
      return { wasReconnect };

    case 'error': {
      const errRequestId = 'requestId' in msg ? (msg as { requestId?: string }).requestId : undefined;
      if (errRequestId && providersListCallbacks.has(errRequestId)) {
        providersListCallbacks.get(errRequestId)?.([]);
        providersListCallbacks.delete(errRequestId);
      }
      if (errRequestId && cliStatusCallbacks.has(errRequestId)) {
        cliStatusCallbacks.get(errRequestId)?.(null);
        cliStatusCallbacks.delete(errRequestId);
      }
      console.error('WebSocket error:', msg);
      useNotificationStore.getState().showToast(
        msg.message || 'An error occurred',
        'error',
      );
      if (msg.sessionId) {
        stopTurnInFlight(msg.sessionId);
      }
      return { wasReconnect };
    }

    case 'cli_down':
      applySessionReplayEventsToStores(msg.sessionId, serverMessageToReplayEvents(msg));
      finalizeInFlightTurn(msg.sessionId, { clearPrompt: true });
      // The CLI parser now synthesizes a failed workflow_event on exit
      // (protocol-parser.handleProcessExit), which is the durable fix. This
      // in-memory settle is a belt-and-suspenders backup covering the rare case
      // where that event is missed/reordered, so the live view never shows a
      // card spinning past the session's death.
      chatStore.settleRunningWorkflows(msg.sessionId, 'failed');
      chatStore.setTodoSnapshot(msg.sessionId, []);
      sessionStore.setSessionWorkflowRunning(msg.sessionId, false);
      sessionStore.updateSessionStatus(msg.sessionId, 'error');
      chatStore.addMessage(msg.sessionId, {
        id: uuidv4(),
        type: 'text',
        role: 'system',
        content: i18n.t('chat.sessionStopped', { exitCode: msg.exitCode, message: msg.message }),
        timestamp: new Date().toISOString(),
      });
      return { wasReconnect };

    case 'session_history':
      restoreSessionReplay(msg.sessionId, {
        messages: msg.messages,
        usage: msg.usage,
        contextUsage: msg.contextUsage,
        activeInteractivePrompt: msg.activeInteractivePrompt,
        todoSnapshot: msg.todoSnapshot,
      });
      return { wasReconnect };

    case 'session_list':
      return {
        wasReconnect: handleSessionListMessage(msg, wasReconnect),
      };

    case 'unread_cleared':
      sessionStore.clearUnreadCount(msg.sessionId);
      useNotificationStore.getState().markSessionAsRead(msg.sessionId);
      return { wasReconnect };

    case 'rate_limit_update':
      useRateLimitStore.getState().updateRateLimit({
        providerId: msg.providerId,
        windows: msg.windows,
        limitId: msg.limitId,
        limitName: msg.limitName,
        planType: msg.planType,
        updatedAt: msg.updatedAt,
      });
      return { wasReconnect };

    case 'model_config_updated':
      invalidateProviderSessionOptionsClientCache(msg.providerId);
      return { wasReconnect };

    case 'commands_ready':
    case 'commands_list':
      useCommandStore.getState().setCommands(msg.sessionId, msg.commands);
      return { wasReconnect };

    case 'providers_list':
      providersListCallbacks.get(msg.requestId)?.(msg.providers);
      providersListCallbacks.delete(msg.requestId);
      return { wasReconnect };

    case 'cli_status_result':
      cliStatusCallbacks.get(msg.requestId)?.(msg.results);
      cliStatusCallbacks.delete(msg.requestId);
      return { wasReconnect };

    case 'skill_analysis_progress':
      useSkillAnalysisStore.getState().handleProgress(msg);
      return { wasReconnect };

    case 'session_title_updated':
      handleSessionTitleUpdatedMessage(msg);
      return { wasReconnect };

    case 'session_title_generation':
      sessionStore.setGeneratingTitle(msg.sessionId, msg.isGenerating);
      return { wasReconnect };

    case 'worktree_diff_stats':
      sessionStore.applyDiffStatsUpdate(msg.sessionIds, msg.stats ?? null);
      useTaskStore.getState().applyDiffStatsUpdate(msg.taskIds, msg.stats ?? null);
      if (msg.autoPromotedTaskIds?.length) {
        useTaskStore.getState().applyWorkflowStatusPromotions(msg.autoPromotedTaskIds);
        sessionStore.applyWorkflowStatusPromotions(msg.autoPromotedTaskIds);
      }
      return { wasReconnect };

    case 'task_pr_status_update':
      useTaskStore.getState().applyPrStatusUpdate(
        msg.taskId,
        msg.prStatus,
        msg.prUnsupported,
        msg.remoteBranchExists,
      );
      return { wasReconnect };

    case 'session_pr_status_update':
      useSessionPrStore.getState().applyPrStatusUpdate(
        msg.sessionId,
        msg.prStatus,
        msg.prUnsupported,
        msg.remoteBranchExists,
      );
      return { wasReconnect };

    case 'session_mutated':
      if (msg.originClientId && msg.originClientId === getClientId()) {
        return { wasReconnect };
      }
      void useSessionStore.getState().loadProjects();
      if (msg.projectId) {
        void useTaskStore.getState().loadTasks(msg.projectId, { setCurrent: false });
      }
      return { wasReconnect };

    case 'task_mutated':
      if (msg.originClientId && msg.originClientId === getClientId()) {
        return { wasReconnect };
      }
      void useTaskStore.getState().loadTasks(msg.projectId, { setCurrent: false });
      return { wasReconnect };

    case 'collection_mutated':
      if (msg.originClientId && msg.originClientId === getClientId()) {
        return { wasReconnect };
      }
      void useCollectionStore.getState().loadCollections(msg.projectId, { force: true, setCurrent: false });
      return { wasReconnect };

    case 'git_panel_state':
      useGitPanelStore.getState().applyGitPanelData(msg.sessionId, msg.data);
      if (msg.data.diffStats !== undefined) {
        sessionStore.applyDiffStatsUpdate([msg.sessionId], msg.data.diffStats ?? null);
        if (msg.data.taskId) {
          useTaskStore.getState().applyDiffStatsUpdate(
            [msg.data.taskId],
            msg.data.diffStats ?? null,
          );
        }
      }
      return { wasReconnect };

    default:
      return { wasReconnect };
  }
}

function retireStoppedTerminalSessionSurface(sessionId: string): void {
  const session = useSessionStore.getState().getSession(sessionId);
  if (session?.kind !== 'terminal' || session.archived) return;
  useTabStore.getState().retireSessionSurface(sessionId);
}

function replayEventsIndicateActiveTurn(
  events: Extract<ServerTransportMessage, { type: 'replay_events' }>['events'],
): boolean {
  return events.some((event) => {
    switch (event.type) {
      case 'user_message':
      case 'assistant_message':
      case 'assistant_message_chunk':
      case 'thinking_start':
      case 'thinking_delta':
        return true;
      case 'progress_hook':
        return event.hookEvent === 'waiting_for_task' || event.progressType === 'waiting_for_task';
      case 'tool_call':
        return event.status === 'running';
      case 'interactive_prompt_response':
        return true;
      default:
        return false;
    }
  });
}

function getLatestReplayEventTimestamp(
  events: Extract<ServerTransportMessage, { type: 'replay_events' }>['events'],
): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if (!event.timestamp) continue;
    if (!latest || event.timestamp > latest) {
      latest = event.timestamp;
    }
  }
  return latest;
}

function shouldStartTurnFromReplayEvents(
  sessionStore: ReturnType<typeof useSessionStore.getState>,
  sessionId: string,
  events: Extract<ServerTransportMessage, { type: 'replay_events' }>['events'],
): boolean {
  if (!replayEventsIndicateActiveTurn(events)) {
    return false;
  }

  // A completed background session may receive a late replay chunk after the
  // completion notification. Keep the unread notification as the visible state
  // until the user opens or marks the session as read.
  const session = sessionStore.getSession(sessionId);
  if ((session?.unreadCount ?? 0) > 0) {
    return false;
  }

  return true;
}

function addCreatedSession(
  msg: Extract<ServerTransportMessage, { type: 'session_created' }>,
  sessionStore: ReturnType<typeof useSessionStore.getState>,
): void {
  const totalSessions = sessionStore.projects.reduce(
    (sum, project) => sum + project.sessions.length,
    0,
  );
  // Session exists in DB but has no backing runtime yet. GUI sessions start on
  // first input; PTY sessions start when their terminal view is first opened.
  sessionStore.addSession({
    id: msg.sessionId,
    title: i18n.t('chat.sessionDefaultTitle', { count: totalSessions + 1 }),
    projectDir: msg.workDir,
    workDir: msg.workDir,
    isRunning: false,
    hasStarted: false,
    status: msg.kind === 'terminal' ? 'stopped' : 'starting',
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    archived: false,
    kind: msg.kind,
    provider: msg.provider,
    model: msg.model,
    reasoningEffort: msg.reasoningEffort,
    serviceTier: msg.serviceTier,
    fastMode: msg.fastMode,
    sessionMode: msg.sessionMode,
    accessMode: msg.accessMode,
    sortOrder: 0,
  });
}

function handleNotificationMessage(
  msg: Extract<ServerTransportMessage, { type: 'notification' }>,
  activeSessionId: string | null,
): void {
  const notificationStore = useNotificationStore.getState();
  const sessionStore = useSessionStore.getState();

  if (msg.sessionId !== activeSessionId) {
    notificationStore.addNotification({
      sessionId: msg.sessionId,
      type: msg.event === 'completed' ? 'completed' : 'input_required',
      preview: msg.preview,
      actions: msg.actions,
    });
    sessionStore.incrementUnreadCount(msg.sessionId);
    return;
  }

  notificationStore.playSound();
}

function handleTerminalSessionStateMessage(
  msg: Extract<ServerTransportMessage, { type: 'session_state' }>,
  activeSessionId: string | null,
): void {
  const notificationStore = useNotificationStore.getState();
  if (msg.sessionId === activeSessionId) {
    notificationStore.playSound();
    return;
  }

  const added = notificationStore.addNotification({
    sessionId: msg.sessionId,
    type: msg.status === 'completed' ? 'completed' : 'input_required',
    preview: msg.preview
      ?? (msg.status === 'completed'
        ? 'Terminal task completed'
        : 'Terminal is waiting for input'),
    dedupKey: msg.stateAt != null
      ? `${msg.sessionId}:${msg.status}:${msg.stateAt}`
      : undefined,
  });
  if (added) useSessionStore.getState().incrementUnreadCount(msg.sessionId);
}

function handleInteractivePromptMessage(
  msg: Extract<ServerTransportMessage, { type: 'interactive_prompt' }>,
  activeSessionId: string | null,
): void {
  stopTurnInFlight(msg.sessionId);
  applySessionReplayEventsToStores(msg.sessionId, serverMessageToReplayEvents(msg));

  if (msg.sessionId === activeSessionId) {
    return;
  }

  const notificationStore = useNotificationStore.getState();
  const isAskUserQuestion = msg.promptType === 'ask_user_question';
  const isPlanApproval = msg.promptType === 'plan_approval';
  notificationStore.addNotification({
    sessionId: msg.sessionId,
    type: isPlanApproval ? 'plan_approval' : isAskUserQuestion ? 'ask_user_question' : 'permission_request',
    preview: isPlanApproval
      ? i18n.t('notifications.planApprovalWaiting')
      : isAskUserQuestion
        ? (msg.data.questions?.[0]?.question ?? i18n.t('notifications.questionWaiting'))
        : i18n.t('notifications.permissionWaiting', { tool: msg.data.toolName ?? 'Tool' }),
  });
  useSessionStore.getState().incrementUnreadCount(msg.sessionId);
}

function handleSessionListMessage(
  msg: Extract<ServerTransportMessage, { type: 'session_list' }>,
  wasReconnect: boolean,
): boolean {
  const generatingSessionIds: string[] = [];
  const titleGeneratingSessionIds = msg.titleGeneratingSessionIds ?? [];
  const chatStore = useChatStore.getState();
  useSessionStore.getState().applyGuiRuntimeSnapshot(
    msg.sessions.map((session) => session.id),
  );
  for (const session of msg.sessions || []) {
    const hasActivePrompt = Boolean(session.activeInteractivePrompt);
    if ('activeInteractivePrompt' in session) {
      chatStore.setActiveInteractivePrompt(session.id, session.activeInteractivePrompt ?? null);
      if (hasActivePrompt) {
        stopTurnInFlight(session.id);
      }
    }
    if ('todoSnapshot' in session) {
      chatStore.setTodoSnapshot(session.id, session.todoSnapshot ?? []);
    }
    if (session.isGenerating && !hasActivePrompt) {
      generatingSessionIds.push(session.id);
    } else if (!hasActivePrompt) {
      stopTurnInFlight(session.id);
    }
  }

  if (generatingSessionIds.length > 0) {
    chatStore.setTurnsInFlight(generatingSessionIds);
  }
  useSessionStore.getState().setGeneratingTitleIds(titleGeneratingSessionIds);

  if (msg.sessions.length > 0 && wasReconnect) {
    useNotificationStore.getState().showToast(
      i18n.t('notifications.runningCliProcesses', { count: msg.sessions.length }),
      'warning',
    );
  }

  return false;
}

function handleSessionTitleUpdatedMessage(
  msg: Extract<ServerTransportMessage, { type: 'session_title_updated' }>,
): void {
  const sessionStore = useSessionStore.getState();
  const previousTitle = msg.previousTitle;
  const nextTitle = msg.title;

  sessionStore.updateSessionTitle(msg.sessionId, nextTitle, msg.hasCustomTitle ?? true);
  useTaskStore.getState().syncLinkedTaskTitle(msg.sessionId, nextTitle);
  if (msg.silent) {
    return;
  }
  useNotificationStore.getState().showToastWithAction(
    `"${nextTitle}"`,
    'success',
    {
      label: 'Undo',
      onClick: () => {
        sessionStore.updateSessionTitle(msg.sessionId, previousTitle, false);
        useTaskStore.getState().syncLinkedTaskTitle(msg.sessionId, previousTitle);
        fetchWithClientId(`/api/sessions/${msg.sessionId}/rename`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: previousTitle }),
        })
          .then((response) => {
            if (!response.ok) {
              throw new Error('rename failed');
            }
          })
          .catch(() => {
            sessionStore.updateSessionTitle(msg.sessionId, nextTitle, true);
            useTaskStore.getState().syncLinkedTaskTitle(msg.sessionId, nextTitle);
            useNotificationStore.getState().showToast('Failed to undo title', 'error');
          });
      },
    },
  );
}
