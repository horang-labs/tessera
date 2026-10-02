import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { sameSessionSelection } from '@/lib/automation/contracts';
import { AutomationInputError } from '@/lib/automation/input-error';
import { createReservedControlSession } from '@/lib/control/reserved-session';
import { getSession } from '@/lib/db/sessions';
import { getDb } from '@/lib/db/database';
import { broadcastSessionMutation, broadcastTaskMutation } from '@/lib/ws/mutation-broadcast';
import { createAutomationRuntime, readAutomationSessionSelection, readSavedSessionSelection } from '@/lib/automation/runtime-adapter';
import { getAutomationRuntime, installAutomationRuntime } from '@/lib/automation/runtime-bridge';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import logger from '@/lib/logger';
import { recordSessionRuntime } from '@/lib/session/session-runtime-recovery';
import { getManagedSessionWorkDir } from '@/lib/git/session-diff-refresh';
import { forkTerminalSessionForProviderReset } from './provider-session-reset';
import { scheduleRecompute } from '@/lib/git/worktree-diff-stats-cache';
import { workspaceFileWatchManager } from '@/lib/workspace-files/workspace-file-watch-manager';
import { TerminalManager } from './terminal-manager';

type SendToConnection = (connectionId: string, message: ServerTransportMessage) => void;
type SendToUser = (userId: string, message: ServerTransportMessage) => void;

interface SharedTerminalManagerState {
  manager: TerminalManager;
  sendToConnection: SendToConnection | null;
  sendToUser: SendToUser | null;
}

const SHARED_TERMINAL_MANAGER_KEY = Symbol.for('tessera.terminalManager');
const sharedGlobal = globalThis as unknown as Record<symbol, SharedTerminalManagerState | undefined>;

function createSharedState(): SharedTerminalManagerState {
  const state = {} as SharedTerminalManagerState;
  state.sendToConnection = null;
  state.sendToUser = null;
  state.manager = new TerminalManager(
    (connectionId, message) => {
      state.sendToConnection?.(connectionId, message);
    },
    undefined,
    async ({ generation, sessionId, terminalId, userId }) => {
      const workDir = getManagedSessionWorkDir(sessionId);
      if (!workDir) return;

      return workspaceFileWatchManager.subscribeRootChanges({
        listenerId: `terminal:${userId}:${terminalId}:${generation}`,
        root: workDir,
        onChange: (root) => scheduleRecompute(root, userId),
      });
    },
    {
      onSessionRuntimeStateChange: ({ sessionId, terminalId, userId, running }) => {
        recordSessionRuntime({ sessionId, userId, running });
        state.sendToUser?.(userId, {
          type: 'terminal_session_runtime',
          sessionId,
          terminalId,
          running,
        });
        // 런타임 (재)시작 시 마지막 hook 상태를 재전송해, 이전에 runtime 신호와
        // 어긋난 순서로 도착해 클라이언트가 버렸을 수 있는 상태를 복구한다.
        if (running) {
          const workDir = getManagedSessionWorkDir(sessionId);
          if (workDir) scheduleRecompute(workDir, userId);
          const lastState = state.manager.getSessionStateForSession(sessionId, userId);
          if (lastState) state.sendToUser?.(userId, lastState);
        }
      },
      onSessionStateChange: ({ message, userId }) => {
        state.sendToUser?.(userId, message);
      },
      onTerminalConversationReset: ({ terminalId, userId }) => {
        try {
          forkTerminalSessionForProviderReset({ manager: state.manager, terminalId, userId });
        } catch (error) {
          // A reset that cannot be forked must never disturb the PTY: the agent
          // has already reset, and the fork still lands on the next prompt.
          logger.warn({ error, terminalId }, 'Terminal conversation reset fork skipped');
        }
      },
      onSessionRuntimeRebound: ({ previousSessionId, sessionId, terminalId, userId }) => {
        recordSessionRuntime({ sessionId: previousSessionId, userId, running: false });
        recordSessionRuntime({ sessionId, userId, running: true });
        state.sendToUser?.(userId, {
          type: 'terminal_session_rebound',
          previousSessionId,
          sessionId,
          terminalId,
        });
      },
    },
  );
  state.manager.automation.publish = (userId, inputOwnership) => {
    state.sendToUser?.(userId, { type: 'session_input_ownership', ...inputOwnership });
  };
  if (!getAutomationRuntime()) installAutomationRuntime(createAutomationRuntime({
    manager: state.manager,
    autorunProvider: id => cliProviderRegistry.hasProvider(id) ? cliProviderRegistry.getProvider(id).autorun ?? null : null,
    readSelection: async (userId, sessionId) => {
      const selection = await readAutomationSessionSelection(userId, sessionId);
      state.manager.automation.verifyEnvironment(userId, sessionId, await getAgentEnvironment(userId));
      return selection;
    },
    verifySelection: (_userId, sessionId, selection) => {
      if (!sameSessionSelection(selection, readSavedSessionSelection(sessionId))) throw new AutomationInputError('UNSUPPORTED_SELECTION', 'Saved launch selection changed.');
    },
    createSession: (sessionId, target) => {
      // Synchronous callback runs inside the Authority's reservation transaction.
      createReservedControlSession(sessionId, { worktreeId: target.worktreeId, title: target.title, ...target.selection });
    },
    launch: async request => (await import('./shared-provider-launch-module')).providerLaunchModule.launch(request),
    canResume: async sessionId => Boolean(getDb().prepare('SELECT 1 FROM session_runtime_recovery WHERE session_id = ?').get(sessionId))
      && (await import('./shared-provider-launch-module')).providerLaunchModule.canResumeSession(sessionId),
    publishCreated: (userId, sessionId) => {
      const session = getSession(sessionId);
      if (!session) return;
      broadcastSessionMutation(userId, { kind: 'created', projectId: session.project_id, sessionId, taskId: session.task_id ?? undefined });
      if (session.task_id) broadcastTaskMutation(userId, { kind: 'updated', projectId: session.project_id, taskId: session.task_id });
    },
  }));
  return state;
}

const sharedState = sharedGlobal[SHARED_TERMINAL_MANAGER_KEY]
  ?? (sharedGlobal[SHARED_TERMINAL_MANAGER_KEY] = createSharedState());

export const terminalManager = sharedState.manager;

export function bindTerminalSender(sendToConnection: SendToConnection): TerminalManager {
  sharedState.sendToConnection = sendToConnection;
  return terminalManager;
}

export function bindTerminalRuntimeSender(sendToUser: SendToUser): void {
  sharedState.sendToUser = sendToUser;
}
