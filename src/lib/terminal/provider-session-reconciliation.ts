import { randomUUID } from 'node:crypto';
import { generateDefaultTitle } from '@/lib/session/title-generator';
import * as dbSessions from '@/lib/db/sessions';
import { getDb } from '@/lib/db/database';
import {
  bindTerminalProviderSession,
  getTerminalProviderSession,
  getTerminalProviderSessionForTesseraSession,
} from '@/lib/db/terminal-provider-sessions';
import {
  buildPendingTerminalProviderState,
  buildTerminalProviderState,
  isPendingTerminalProviderSessionState,
  readPersistedTerminalProviderSessionId,
  type TerminalProviderSessionActivation,
  type TerminalProviderSessionIdentity,
} from './provider-session-identity';

/** How the provider's new session came to exist. */
export type TerminalProviderSessionOrigin = 'fork' | 'reset';

export type TerminalProviderSessionReconciliationResult = {
  kind: 'ignored' | 'unchanged' | 'existing' | 'created';
  sessionId: string;
  previousSessionId: string;
  previousProviderSessionId?: string;
  projectId?: string;
};

/**
 * A fork continues the parent conversation, so it inherits the parent's title.
 * A reset (`/clear`, `/new`) starts an empty one and must look like any other
 * new session — a placeholder the first prompt then replaces with a real title.
 */
function childTitle(source: dbSessions.SessionRow, origin: TerminalProviderSessionOrigin): string {
  if (origin === 'reset') {
    return generateDefaultTitle(dbSessions.countActiveSessionsInProject(source.project_id));
  }
  const suffix = ' (Fork)';
  return `${source.title.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`;
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

function createChildSession(
  source: dbSessions.SessionRow,
  origin: TerminalProviderSessionOrigin,
  providerState: string,
  onCreated?: (sessionId: string) => void,
): string {
  const sessionId = randomUUID();
  const title = childTitle(source, origin);
  getDb().transaction(() => {
    dbSessions.createSession(sessionId, source.project_id, title, source.provider, {
      workDir: source.work_dir ?? undefined,
      worktreeManaged: source.worktree_managed === 1,
      taskId: source.task_id ?? undefined,
      collectionId: source.collection_id ?? undefined,
      model: source.model ?? undefined,
      reasoningEffort: source.reasoning_effort,
      serviceTier: source.service_tier,
      providerState,
    });
    dbSessions.updateSession(sessionId, {
      worktree_branch: source.worktree_branch,
      worktree_managed: source.worktree_managed ?? 0,
      chat_workflow_status: source.chat_workflow_status,
    });
    onCreated?.(sessionId);
  })();
  return sessionId;
}

/**
 * Forks a PTY session before the provider has minted the identity for it — the
 * Codex/OpenCode reset case. The child carries no provider session id yet; the
 * first one it observes becomes its own (see reconcilePendingTerminalProviderSession).
 * Returns null when the source has no provider conversation to leave behind.
 */
export function createPendingTerminalProviderSessionFork(
  sourceSessionId: string,
): { sessionId: string; projectId: string } | null {
  const source = dbSessions.getSession(sourceSessionId);
  if (
    !source
    || source.deleted === 1
    || dbSessions.extractSessionKind(source.provider_state) !== 'terminal'
    || isPendingTerminalProviderSessionState(source.provider_state)
  ) return null;
  // Nothing has been said in this PTY yet (no rollout, no hook): resetting an
  // empty conversation must not leave an empty session behind.
  if (
    !getTerminalProviderSessionForTesseraSession(sourceSessionId)
    && !readPersistedTerminalProviderSessionId(source)
  ) return null;

  return {
    sessionId: createChildSession(source, 'reset', buildPendingTerminalProviderState()),
    projectId: source.project_id,
  };
}

/**
 * Resolves the first identity observed by a session that was forked ahead of the
 * provider (see buildPendingTerminalProviderState). Two outcomes only:
 *  - the identity is unowned → this session was waiting for exactly that, adopt it;
 *  - the identity already belongs to another session → the reset the input tracker
 *    predicted never happened, so drop the empty placeholder and hand the PTY back.
 */
function reconcilePendingTerminalProviderSession(
  source: dbSessions.SessionRow,
  identity: TerminalProviderSessionIdentity,
  activation?: TerminalProviderSessionActivation,
): TerminalProviderSessionReconciliationResult {
  const existing = getTerminalProviderSession(identity.providerId, identity.providerSessionId);
  const existingSession = existing ? dbSessions.getSession(existing.tessera_session_id) : undefined;
  if (existingSession && existingSession.deleted === 0 && existingSession.id !== source.id) {
    dbSessions.deleteSession(source.id);
    return {
      kind: 'existing',
      sessionId: existingSession.id,
      previousSessionId: source.id,
    };
  }

  getDb().transaction(() => {
    dbSessions.updateSession(source.id, {
      provider_state: buildTerminalProviderState(identity, activation),
    });
    registerIdentity(source.id, identity);
  })();
  return { kind: 'unchanged', sessionId: source.id, previousSessionId: source.id };
}

export function reconcileTerminalProviderSession(options: {
  sourceSessionId: string;
  identity: TerminalProviderSessionIdentity;
  activation?: TerminalProviderSessionActivation;
  /** Whether the CLI branched the current conversation or started an empty one. */
  origin?: TerminalProviderSessionOrigin;
}): TerminalProviderSessionReconciliationResult {
  const { activation, identity, origin = 'fork', sourceSessionId } = options;
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
  if (!sourceBinding && isPendingTerminalProviderSessionState(source.provider_state)) {
    return reconcilePendingTerminalProviderSession(source, identity, activation);
  }
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

  const sessionId = createChildSession(
    source,
    origin,
    buildTerminalProviderState(identity, activation),
    (created) => registerIdentity(created, identity),
  );
  return {
    kind: 'created',
    sessionId,
    previousSessionId: sourceSessionId,
    previousProviderSessionId: sourceBinding?.provider_session_id,
    projectId: source.project_id,
  };
}
