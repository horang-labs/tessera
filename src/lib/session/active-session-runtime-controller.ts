export type SessionRuntimeKind = 'gui' | 'pty';

export interface SessionRuntimeCloseFailure {
  runtime: SessionRuntimeKind;
  error: unknown;
}

interface ActiveSessionRuntimeDependencies {
  getGuiSessionIds(userId?: string): Set<string>;
  getPtySessionIds(userId?: string): Set<string>;
  closeGuiSession(sessionId: string): Promise<void>;
  closePtySession(sessionId: string, userId: string): Promise<void>;
}

export function createActiveSessionRuntimeController(dependencies: ActiveSessionRuntimeDependencies) {
  return {
    getActiveSessionIds(userId?: string): Set<string> {
      return new Set([
        ...dependencies.getGuiSessionIds(userId),
        ...dependencies.getPtySessionIds(userId),
      ]);
    },

    async closeSession(sessionId: string, userId?: string): Promise<SessionRuntimeCloseFailure[]> {
      const operations: Array<{ runtime: SessionRuntimeKind; promise: Promise<void> }> = [
        { runtime: 'gui', promise: dependencies.closeGuiSession(sessionId) },
      ];
      if (userId) {
        operations.push({
          runtime: 'pty',
          promise: dependencies.closePtySession(sessionId, userId),
        });
      }
      const results = await Promise.allSettled(operations.map((operation) => operation.promise));

      return results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [{ runtime: operations[index].runtime, error: result.reason }]
          : [],
      );
    },
  };
}
