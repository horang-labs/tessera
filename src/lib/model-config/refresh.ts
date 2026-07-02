import type { ServerTransportMessage } from '../ws/message-types';
import logger from '../logger';
import { invalidateProviderSessionOptionsCache } from '../cli/provider-session-options';
import { refreshRemoteModelConfig, type ModelConfigFetchReason } from './remote-config';

// No periodic poll: the remote model config is refreshed (and the usage beacon counted)
// on exactly two triggers — app launch (server.ts) and each Claude session creation
// (session-orchestrator-lifecycle). The reason is sent as X-Tessera-Event so the Worker
// can count launches and sessions separately.

type BroadcastFn = (message: ServerTransportMessage) => void;

let broadcastFn: BroadcastFn | null = null;

export function setModelConfigBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

/**
 * Refresh the remote model config for the given trigger. If the list changed, drop the
 * server-side provider-options cache and notify all connected clients so open model
 * dropdowns re-fetch. Never throws — safe to call fire-and-forget from the session path.
 */
export async function triggerModelConfigRefresh(reason: ModelConfigFetchReason): Promise<void> {
  try {
    const { changed } = await refreshRemoteModelConfig(reason);
    if (changed) {
      invalidateProviderSessionOptionsCache();
      broadcastFn?.({ type: 'model_config_updated', providerId: 'claude-code' });
      logger.info({ reason }, 'Model config updated from remote');
    }
  } catch (error) {
    logger.error({ error, reason }, 'Model config refresh error');
  }
}
