import { randomUUID } from 'node:crypto';
import * as dbSessions from '@/lib/db/sessions';
import { getDb } from '@/lib/db/database';
import {
  bindTerminalProviderSession,
  getTerminalProviderSession,
  getTerminalProviderSessionForTesseraSession,
} from '@/lib/db/terminal-provider-sessions';
import {
  buildTerminalProviderState,
  readPersistedTerminalProviderSessionId,
  type TerminalProviderSessionActivation,
  type TerminalProviderSessionIdentity,
} from './provider-session-identity';

export type TerminalProviderSessionReconciliationResult = {
  kind: 'ignored' | 'unchanged' | 'existing' | 'created';
  sessionId: string;
  previousSessionId: string;
  previousProviderSessionId?: string;
  projectId?: string;
};

function forkTitle(sourceTitle: string): string {
  const suffix = ' (Fork)';
  return `${sourceTitle.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`;
}

function registerIdentity(
  tesseraSessionId: string,
  identity: TerminalProviderSessionIdentity,
): void {
  bindTerminalProviderSession({
    providerId: identity.providerId,
    providerSessionId: identity.providerSessionId,
    tesseraSessionId,
    transcriptPath: identity.transcriptPath,
  });
}

function createForkSession(
  source: dbSessions.SessionRow,
  identity: TerminalProviderSessionIdentity,
  activation?: TerminalProviderSessionActivation,
): string {
  const sessionId = randomUUID();
  getDb().transaction(() => {
    dbSessions.createSession(sessionId, source.project_id, forkTitle(source.title), source.provider, {
      workDir: source.work_dir ?? undefined,
      worktreeManaged: source.worktree_managed === 1,
      taskId: source.task_id ?? undefined,
      collectionId: source.collection_id ?? undefined,
      model: source.model ?? undefined,
      reasoningEffort: source.reasoning_effort,
      serviceTier: source.service_tier,
      providerState: buildTerminalProviderState(identity, activation),
    });
    dbSessions.updateSession(sessionId, {
      worktree_branch: source.worktree_branch,
      worktree_managed: source.worktree_managed ?? 0,
      chat_workflow_status: source.chat_workflow_status,
    });
    registerIdentity(sessionId, identity);
  })();
  return sessionId;
}

export function reconcileTerminalProviderSession(options: {
  sourceSessionId: string;
  identity: TerminalProviderSessionIdentity;
  activation?: TerminalProviderSessionActivation;
}): TerminalProviderSessionReconciliationResult {
  const { activation, identity, sourceSessionId } = options;
  const source = dbSessions.getSession(sourceSessionId);
  if (
    !source
    || source.deleted === 1
    || source.provider !== identity.providerId
    || dbSessions.extractSessionKind(source.provider_state) !== 'terminal'
  ) {
    return { kind: 'ignored', sessionId: sourceSessionId, previousSessionId: sourceSessionId };
  }

  let sourceBinding = getTerminalProviderSessionForTesseraSession(sourceSessionId);
  if (!sourceBinding) {
    const persistedProviderSessionId = readPersistedTerminalProviderSessionId(source);
    const sourceProviderSessionId = persistedProviderSessionId ?? identity.providerSessionId;
    registerIdentity(sourceSessionId, {
      providerId: identity.providerId,
      providerSessionId: sourceProviderSessionId,
      ...(sourceProviderSessionId === identity.providerSessionId && identity.transcriptPath
        ? { transcriptPath: identity.transcriptPath }
        : {}),
    });
    sourceBinding = getTerminalProviderSessionForTesseraSession(sourceSessionId);
  }

  if (sourceBinding?.provider_session_id === identity.providerSessionId) {
    registerIdentity(sourceSessionId, identity);
    return { kind: 'unchanged', sessionId: sourceSessionId, previousSessionId: sourceSessionId };
  }

  const existing = getTerminalProviderSession(identity.providerId, identity.providerSessionId);
  const existingSession = existing ? dbSessions.getSession(existing.tessera_session_id) : undefined;
  if (existingSession && existingSession.deleted === 0) {
    registerIdentity(existingSession.id, identity);
    return {
      kind: 'existing',
      sessionId: existingSession.id,
      previousSessionId: sourceSessionId,
      previousProviderSessionId: sourceBinding?.provider_session_id,
    };
  }

  const sessionId = createForkSession(source, identity, activation);
  return {
    kind: 'created',
    sessionId,
    previousSessionId: sourceSessionId,
    previousProviderSessionId: sourceBinding?.provider_session_id,
    projectId: source.project_id,
  };
}
