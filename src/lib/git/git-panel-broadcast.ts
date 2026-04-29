import logger from '@/lib/logger';
import { protocolAdapter } from '@/lib/cli/protocol-adapter';
import { subscribeGitPanelData } from './git-panel-cache';

let unsubscribe: (() => void) | null = null;

/**
 * Install a listener on the git-panel cache that broadcasts each recomputed
 * state to the users who triggered it. Idempotent.
 */
export function installGitPanelBroadcast(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeGitPanelData((sessionId, data, userIds) => {
    if (!data || userIds.length === 0) return;

    const send = protocolAdapter.getSendToUser();
    if (!send) return;

    for (const userId of userIds) {
      try {
        send(userId, {
          type: 'git_panel_state',
          sessionId,
          data,
        });
      } catch (err) {
        logger.warn(
          { err, userId, sessionId },
          'Failed to broadcast git panel state',
        );
      }
    }
  });
}

export function uninstallGitPanelBroadcast(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
