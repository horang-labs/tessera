import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { getManagedSessionWorkDir } from '@/lib/git/session-diff-refresh';
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
        state.sendToUser?.(userId, {
          type: 'terminal_session_runtime',
          sessionId,
          terminalId,
          running,
        });
        // 런타임 (재)시작 시 마지막 hook 상태를 재전송해, 이전에 runtime 신호와
        // 어긋난 순서로 도착해 클라이언트가 버렸을 수 있는 상태를 복구한다.
        if (running) {
          const lastState = state.manager.getSessionStateForSession(sessionId, userId);
          if (lastState) state.sendToUser?.(userId, lastState);
        }
      },
      onSessionStateChange: ({ message, userId }) => {
        state.sendToUser?.(userId, message);
      },
      onSessionRuntimeRebound: ({ previousSessionId, sessionId, terminalId, userId }) => {
        state.sendToUser?.(userId, {
          type: 'terminal_session_rebound',
          previousSessionId,
          sessionId,
          terminalId,
        });
      },
    },
  );
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
