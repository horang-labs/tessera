/**
 * Relays task PR sync updates from the sync service to every connected
 * WebSocket client. Matches the diff-stats broadcast pattern but uses a
 * simple global broadcast (PR state is not user-private).
 */

import logger from '@/lib/logger';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { subscribeTaskPrUpdates } from './task-pr-sync';

type BroadcastFn = (message: ServerTransportMessage) => void;

let unsubscribe: (() => void) | null = null;

export function installTaskPrStatusBroadcast(broadcast: BroadcastFn): void {
  if (unsubscribe) return;
  unsubscribe = subscribeTaskPrUpdates((update) => {
    try {
      broadcast({
        type: 'task_pr_status_update',
        taskId: update.taskId,
        prStatus: update.prStatus,
        prUnsupported: update.prUnsupported,
        remoteBranchExists: update.remoteBranchExists,
      });
    } catch (err) {
      logger.warn({ err, taskId: update.taskId }, 'Failed to broadcast task PR update');
    }
  });
}

export function uninstallTaskPrStatusBroadcast(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
