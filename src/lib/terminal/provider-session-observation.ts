import logger from '@/lib/logger';
import * as dbSessions from '@/lib/db/sessions';
import { broadcastSessionMutation } from '@/lib/ws/mutation-broadcast';
import type { PaneTokenEntry } from './pane-token-registry';
import type { TerminalProviderSessionIdentity } from './provider-session-identity';
import {
  reconcileTerminalProviderSession,
  type TerminalProviderSessionOrigin,
} from './provider-session-reconciliation';
import { terminalManager } from './shared-terminal-manager';
import type { ProviderHomeIdentity } from '@/lib/cli/providers/provider-home-identity';

/** Applies one provider identity observation to the common PTY session model. */
export function observeTerminalProviderSession(options: {
  pane: PaneTokenEntry;
  identity: TerminalProviderSessionIdentity;
  activation: 'active' | 'background';
  /** True only when provider-owned lineage proves this is a managed child. */
  allowCreate?: boolean;
  origin?: TerminalProviderSessionOrigin;
  /** Where the observed conversation runs, when it left the parent's directory. */
  workDir?: string;
  providerHomeIdentity?: ProviderHomeIdentity;
}): { ignored: boolean; sessionId: string | null } {
  const {
    pane,
    identity,
    activation,
    allowCreate,
    origin,
    workDir,
    providerHomeIdentity,
  } = options;
  const activeSessionId = pane.sessionId
    ? terminalManager.getSessionIdForTerminal(pane.terminalId, pane.userId)
    : null;
  if (!activeSessionId) return { ignored: false, sessionId: pane.sessionId };

  if (activation === 'background') {
    terminalManager.markProviderSessionIdentityBackground(
      pane.terminalId,
      pane.userId,
      identity.providerSessionId,
    );
  }
  const isBackgroundIdentity = activation === 'background'
    || terminalManager.isProviderSessionIdentityBackground(
      pane.terminalId,
      pane.userId,
      identity.providerSessionId,
    );
  if (terminalManager.isProviderSessionIdentityRetired(
    pane.terminalId,
    pane.userId,
    identity.providerSessionId,
  )) {
    logger.debug({
      providerId: pane.providerId,
      providerSessionId: identity.providerSessionId,
      terminalId: pane.terminalId,
    }, 'Retired terminal provider session observation ignored');
    return { ignored: true, sessionId: activeSessionId };
  }

  const reconciliation = reconcileTerminalProviderSession({
    sourceSessionId: activeSessionId,
    identity,
    activation,
    allowCreate,
    ...(origin ? { origin } : {}),
    ...(workDir ? { workDir } : {}),
    ...(providerHomeIdentity ? { providerHomeIdentity } : {}),
  });
  if (reconciliation.kind === 'ignored') {
    return { ignored: true, sessionId: activeSessionId };
  }
  if (reconciliation.kind === 'created') {
    broadcastSessionMutation(pane.userId, {
      kind: 'created',
      projectId: reconciliation.projectId,
      sessionId: reconciliation.sessionId,
      taskId: dbSessions.getSession(reconciliation.sessionId)?.task_id ?? undefined,
    });
  }
  const rebound = !isBackgroundIdentity
    && reconciliation.sessionId !== activeSessionId
    && terminalManager.rebindSession(
      pane.terminalId,
      pane.userId,
      activeSessionId,
      reconciliation.sessionId,
    );
  if (!isBackgroundIdentity && (reconciliation.sessionId === activeSessionId || rebound)) {
    terminalManager.activateProviderSessionIdentity(
      pane.terminalId,
      pane.userId,
      identity.providerSessionId,
      rebound ? reconciliation.previousProviderSessionId : undefined,
    );
  }

  const sessionId = (rebound || (isBackgroundIdentity && reconciliation.sessionId !== activeSessionId))
    ? reconciliation.sessionId
    : activeSessionId;
  if (rebound || (isBackgroundIdentity && reconciliation.sessionId !== activeSessionId)) {
    logger.info({
      providerId: pane.providerId,
      providerSessionId: identity.providerSessionId,
      previousSessionId: reconciliation.previousSessionId,
      sessionId,
      kind: reconciliation.kind,
    }, isBackgroundIdentity
      ? 'Background terminal provider session discovered'
      : 'Terminal provider session reconciled');
  }
  return { ignored: false, sessionId };
}
