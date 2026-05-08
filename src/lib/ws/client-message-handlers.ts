import { v4 as uuidv4 } from 'uuid';
import type { ProviderMeta } from '@/lib/cli/providers/types';
import type { CliStatusEntry } from '@/lib/cli/connection-checker';
import { applySessionReplayEventsToStores } from '@/lib/chat/apply-session-replay-events';
import { restoreSessionReplay } from '@/lib/chat/restore-session-replay';
import {
  finalizeInFlightTurn,
  stopTurnInFlight,
} from '@/lib/chat/session-client-effects';
import { serverMessageToReplayEvents } from '@/lib/chat/server-message-to-replay-events';
import { useChatStore } from '@/stores/chat-store';
import { useCommandStore } from '@/stores/command-store';
import { useGitPanelStore } from '@/stores/git-panel-store';
import { useNotificationStore } from '@/stores/notification-store';
import { useRateLimitStore } from '@/stores/rate-limit-store';
import { useSessionStore } from '@/stores/session-store';
import { useSessionPrStore } from '@/stores/session-pr-store';
import { useSkillAnalysisStore } from '@/stores/skill-analysis-store';
import { useTaskStore } from '@/stores/task-store';
import { useUsageStore } from '@/stores/usage-store';
import { useCollectionStore } from '@/stores/collection-store';
import { i18n } from '@/lib/i18n';
import type { ServerTransportMessage } from './message-types';
import { getClientId } from './client-id';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';

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
        sessionMode: msg.sessionMode,
        accessMode: msg.accessMode,
      });
      return { wasReconnect };

    case 'session_closed':
      sessionStore.removeSession(msg.sessionId);
      chatStore.clearSession(msg.sessionId);
      useUsageStore.getState().clearUsage(msg.sessionId);
      useCommandStore.getState().clearSession(msg.sessionId);
      useSessionPrStore.getState().clearSession(msg.sessionId);
      return { wasReconnect };

    case 'session_stopped':
      sessionStore.markSessionStopped(msg.sessionId);
      finalizeInFlightTurn(msg.sessionId, { clearPrompt: true });
      useCommandStore.getState().clearSession(msg.sessionId);
      return { wasReconnect };

    case 'replay_events':
      applySessionReplayEventsToStores(msg.sessionId, msg.events);
      return { wasReconnect };

    case 'notification':
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

    case 'interactive_prompt':
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
      });
      return { wasReconnect };

    case 'session_list':
      return {
        wasReconnect: handleSessionListMessage(msg, wasReconnect),
      };

    case 'unread_cleared':
      sessionStore.clearUnreadCount(msg.sessionId);
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

function addCreatedSession(
  msg: Extract<ServerTransportMessage, { type: 'session_created' }>,
  sessionStore: ReturnType<typeof useSessionStore.getState>,
): void {
  const totalSessions = sessionStore.projects.reduce(
    (sum, project) => sum + project.sessions.length,
    0,
  );
  // Session exists in DB but CLI isn't spawned until the first message.
  // isRunning=false reflects the real process state; markSessionRunning flips
  // it to true once the session_started event arrives.
  sessionStore.addSession({
    id: msg.sessionId,
    title: i18n.t('chat.sessionDefaultTitle', { count: totalSessions + 1 }),
    projectDir: msg.workDir,
    isRunning: false,
    status: 'starting',
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    archived: false,
    provider: msg.provider,
    model: msg.model,
    reasoningEffort: msg.reasoningEffort,
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
  for (const session of msg.sessions || []) {
    if (session.isGenerating) {
      generatingSessionIds.push(session.id);
    }
  }

  if (generatingSessionIds.length > 0) {
    useChatStore.getState().setTurnsInFlight(generatingSessionIds);
  }

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

  sessionStore.updateSessionTitle(msg.sessionId, nextTitle, true);
  useTaskStore.getState().syncLinkedTaskTitle(msg.sessionId, nextTitle);
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
