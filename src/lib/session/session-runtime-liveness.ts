import type { ProjectGroup, UnifiedSession } from '@/types/chat';

export type SessionRuntimeSource = 'gui' | 'terminal';

interface RuntimeSourceLiveness {
  snapshotActiveIds: Set<string> | null;
  overrides: Record<string, boolean>;
}

export interface SessionRuntimeLiveness {
  gui: RuntimeSourceLiveness;
  terminal: RuntimeSourceLiveness;
}

function createSourceLiveness(): RuntimeSourceLiveness {
  return {
    snapshotActiveIds: null,
    overrides: {},
  };
}

export function createSessionRuntimeLiveness(): SessionRuntimeLiveness {
  return {
    gui: createSourceLiveness(),
    terminal: createSourceLiveness(),
  };
}

export function beginSessionRuntimeConnection(): SessionRuntimeLiveness {
  return createSessionRuntimeLiveness();
}

export function recordSessionRuntimeEvent(
  liveness: SessionRuntimeLiveness,
  source: SessionRuntimeSource,
  sessionId: string,
  running: boolean,
): SessionRuntimeLiveness {
  return {
    ...liveness,
    [source]: {
      ...liveness[source],
      overrides: {
        ...liveness[source].overrides,
        [sessionId]: running,
      },
    },
  };
}

export function recordSessionRuntimeSnapshot(
  liveness: SessionRuntimeLiveness,
  source: SessionRuntimeSource,
  activeSessionIds: readonly string[],
): SessionRuntimeLiveness {
  return {
    ...liveness,
    [source]: {
      snapshotActiveIds: new Set(activeSessionIds),
      overrides: liveness[source].overrides,
    },
  };
}

export function forgetSessionRuntime(
  liveness: SessionRuntimeLiveness,
  sessionId: string,
): SessionRuntimeLiveness {
  let changed = false;
  const next = { ...liveness };

  for (const source of ['gui', 'terminal'] as const) {
    const current = liveness[source];
    const hadOverride = Object.hasOwn(current.overrides, sessionId);
    const wasActive = current.snapshotActiveIds?.has(sessionId) === true;
    if (!hadOverride && !wasActive) continue;

    changed = true;
    const overrides = { ...current.overrides };
    delete overrides[sessionId];
    const snapshotActiveIds = current.snapshotActiveIds
      ? new Set(current.snapshotActiveIds)
      : null;
    snapshotActiveIds?.delete(sessionId);
    next[source] = { snapshotActiveIds, overrides };
  }

  return changed ? next : liveness;
}

function getRuntimeSource(session: Pick<UnifiedSession, 'kind'>): SessionRuntimeSource {
  return session.kind === 'terminal' ? 'terminal' : 'gui';
}

export function resolveSessionRuntimeLiveness(
  session: UnifiedSession,
  liveness: SessionRuntimeLiveness,
): UnifiedSession {
  const source = getRuntimeSource(session);
  const sourceState = liveness[source];
  const override = sourceState.overrides[session.id];
  const running = override !== undefined
    ? override
    : sourceState.snapshotActiveIds !== null
      ? sourceState.snapshotActiveIds.has(session.id)
      : session.isRunning;

  const status = running
    ? 'running'
    : source === 'terminal' || session.status === 'running'
      ? 'stopped'
      : session.status;
  if (session.isRunning === running && session.status === status) return session;

  return {
    ...session,
    isRunning: running,
    hasStarted: running ? true : session.hasStarted,
    status,
    ...(running && source === 'gui'
      ? { tesseraSessionId: session.tesseraSessionId ?? session.id }
      : running
        ? {}
        : { tesseraSessionId: undefined }),
  };
}

export function applySessionRuntimeLiveness(
  projects: ProjectGroup[],
  liveness: SessionRuntimeLiveness,
): ProjectGroup[] {
  let changed = false;
  const nextProjects = projects.map((project) => {
    let projectChanged = false;
    const sessions = project.sessions.map((session) => {
      const nextSession = resolveSessionRuntimeLiveness(session, liveness);
      if (nextSession !== session) projectChanged = true;
      return nextSession;
    });
    if (!projectChanged) return project;
    changed = true;
    return { ...project, sessions };
  });

  return changed ? nextProjects : projects;
}
