'use client';

import { useMemo } from 'react';
import { useProjectViewSessions } from '@/hooks/use-project-view-workspace-state';
import type { UnifiedSession } from '@/types/chat';

export type SessionKindTarget = string | Pick<UnifiedSession, 'id' | 'kind'>;

export function resolveIsTerminalSession(
  storedKind: UnifiedSession['kind'],
  fallbackKind?: UnifiedSession['kind'],
): boolean {
  return (storedKind ?? fallbackKind) === 'terminal';
}

/** Resolve mixed Session targets once so status hooks share the same GUI/PTY partition. */
export function useSessionKindGroups(
  sessions: readonly SessionKindTarget[],
): { guiIds: string[]; terminalIds: string[] } {
  const targetsKey = JSON.stringify(
    sessions
      .map((session) => typeof session === 'string'
        ? { id: session, kind: undefined }
        : { id: session.id, kind: session.kind })
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  const targets = useMemo(
    () => JSON.parse(targetsKey) as Array<{ id: string; kind?: UnifiedSession['kind'] }>,
    [targetsKey],
  );
  const ids = useMemo(() => targets.map((target) => target.id), [targets]);
  const fallbackKinds = useMemo(
    () => new Map(targets.map((target) => [target.id, target.kind])),
    [targets],
  );

  const resolvedSessions = useProjectViewSessions(ids);
  const kindsById = new Map(resolvedSessions.map((session) => [session.id, session.kind]));
  const terminalIdsKey = ids
    .filter((sessionId) => resolveIsTerminalSession(
      kindsById.get(sessionId),
      fallbackKinds.get(sessionId),
    ))
    .join(',');
  const terminalIds = useMemo(
    () => terminalIdsKey ? terminalIdsKey.split(',') : [],
    [terminalIdsKey],
  );
  const terminalIdSet = useMemo(() => new Set(terminalIds), [terminalIds]);
  const guiIds = useMemo(
    () => ids.filter((sessionId) => !terminalIdSet.has(sessionId)),
    [ids, terminalIdSet],
  );

  return { guiIds, terminalIds };
}
