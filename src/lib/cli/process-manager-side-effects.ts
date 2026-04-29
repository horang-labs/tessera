import * as dbSessions from '../db/sessions';
import logger from '../logger';
import type { PendingPermissionRequest, PendingToolCall, ProcessInfo } from './types';

type ProcessMap = Map<string, ProcessInfo>;

export function updateProviderStateWithRetry(
  sessionId: string,
  providerState: Record<string, unknown>,
): void {
  const doUpdate = (isRetry: boolean) => {
    try {
      dbSessions.updateSession(sessionId, {
        provider_state: JSON.stringify(providerState),
      });
      logger.info('update_provider_state: session updated', {
        sessionId,
        providerState,
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
