import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { getManagedSessionWorkDir } from '@/lib/git/session-diff-refresh';
import { scheduleRecompute } from '@/lib/git/worktree-diff-stats-cache';
import { workspaceFileWatchManager } from '@/lib/workspace-files/workspace-file-watch-manager';
import { TerminalManager } from './terminal-manager';

type SendToConnection = (connectionId: string, message: ServerTransportMessage) => void;

interface SharedTerminalManagerState {
  manager: TerminalManager;
  sendToConnection: SendToConnection | null;
}

const SHARED_TERMINAL_MANAGER_KEY = Symbol.for('tessera.terminalManager');
const sharedGlobal = globalThis as unknown as Record<symbol, SharedTerminalManagerState | undefined>;

function createSharedState(): SharedTerminalManagerState {
  const state = {} as SharedTerminalManagerState;
  state.sendToConnection = null;
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
