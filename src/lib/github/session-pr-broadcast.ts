/**
 * Relays session PR sync updates from the sync service to every connected
 * WebSocket client. Mirrors task-pr-broadcast for sessions that aren't
 * tied to a task.
 */

import logger from '@/lib/logger';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { subscribeSessionPrUpdates } from './session-pr-sync';

type BroadcastFn = (message: ServerTransportMessage) => void;

let unsubscribe: (() => void) | null = null;

export function installSessionPrStatusBroadcast(broadcast: BroadcastFn): void {
  if (unsubscribe) return;
  unsubscribe = subscribeSessionPrUpdates((update) => {
    try {
      broadcast({
        type: 'session_pr_status_update',
        sessionId: update.sessionId,
        prStatus: update.prStatus,
        prStatusKnown: update.prStatusKnown,
        prUnsupported: update.prUnsupported,
        remoteBranchExists: update.remoteBranchExists,
      });
    } catch (err) {
      logger.warn({ err, sessionId: update.sessionId }, 'Failed to broadcast session PR update');
    }
  });
}

export function uninstallSessionPrStatusBroadcast(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
