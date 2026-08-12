import * as dbSessions from '../db/sessions';
import logger from '../logger';
import type { PendingPermissionRequest, PendingToolCall, ProcessInfo } from './types';
import type { ProviderHomeIdentity } from './providers/provider-home-identity';
import { isDatabaseInitialized } from '../db/database';

type ProcessMap = Map<string, ProcessInfo>;

export function updateProviderStateWithRetry(
  sessionId: string,
  providerState: Record<string, unknown>,
): void {
  const doUpdate = (isRetry: boolean) => {
    try {
      const session = dbSessions.getSession(sessionId);
      const nextProviderState = {
        ...parseProviderState(session?.provider_state ?? null),
        ...providerState,
      };
      dbSessions.updateSession(sessionId, {
        provider_state: JSON.stringify(nextProviderState),
      });
      logger.info('update_provider_state: session updated', {
        sessionId,
        providerState: nextProviderState,
      });
    } catch (error) {
      if (!isRetry) {
        logger.warn('update_provider_state: updateSession failed, retrying in 50ms', {
          sessionId,
          error: (error as Error).message,
        });
        setTimeout(() => doUpdate(true), 50);
      } else {
        logger.error('update_provider_state: updateSession retry failed', {
          sessionId,
          error: (error as Error).message,
        });
      }
    }
  };

  doUpdate(false);
}

export async function bindProviderHomeOrThrow(
  sessionId: string,
  identity: ProviderHomeIdentity,
): Promise<void> {
  // Adapter harnesses and provider probes do not necessarily own a Tessera
  // database record. A managed runtime does, and is bound exactly once.
  if (!isDatabaseInitialized()) return;
  const bind = () => {
    if (!dbSessions.getSession(sessionId)) {
      throw new Error(`Managed Session ${sessionId} is unavailable for provider-home binding`);
    }
    dbSessions.bindSessionOriginProviderHome(sessionId, identity);
  };
  try {
    bind();
  } catch (firstError) {
    logger.warn({ sessionId, error: firstError }, 'Provider home binding failed; retrying');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    // The handshake must fail when authority cannot be persisted. Continuing
    // would leave a provider conversation that Tessera cannot safely resume.
    bind();
  }
}

function parseProviderState(providerState: string | null): Record<string, unknown> {
  if (!providerState) {
    return {};
  }

  try {
    const parsed = JSON.parse(providerState);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function setPendingToolCall(
  processes: ProcessMap,
  sessionId: string,
  toolUseId: string,
  pendingToolCall: PendingToolCall,
): void {
  const info = processes.get(sessionId);
  if (!info) {
    return;
  }

  if (!info.pendingToolCalls) {
    info.pendingToolCalls = new Map();
  }

  info.pendingToolCalls.set(toolUseId, pendingToolCall);
}

export function setPendingPermissionRequest(
  processes: ProcessMap,
  sessionId: string,
  toolUseId: string,
  pendingPermissionRequest: PendingPermissionRequest,
): void {
  const info = processes.get(sessionId);
  if (!info) {
    return;
  }

  if (!info.pendingPermissionRequests) {
    info.pendingPermissionRequests = new Map();
  }

  info.pendingPermissionRequests.set(toolUseId, pendingPermissionRequest);
}

export function removePendingToolCall(
  processes: ProcessMap,
  sessionId: string,
  toolUseId: string,
): void {
  processes.get(sessionId)?.pendingToolCalls?.delete(toolUseId);
}

export function removePendingPermissionRequest(
  processes: ProcessMap,
  sessionId: string,
  toolUseId: string,
): void {
  processes.get(sessionId)?.pendingPermissionRequests?.delete(toolUseId);
}
