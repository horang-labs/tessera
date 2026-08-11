import { useBoardStore } from '@/stores/board-store';
import { useTabStore } from '@/stores/tab-store';

/** One lifetime boundary for every materialized or snapshotted Session surface. */
export function getProjectViewOpenSessionIds(): string[] {
  const sessionIds = new Set(useTabStore.getState().getSessionSurfaceIds());
  const board = useBoardStore.getState();
  if (board.peekSessionId) sessionIds.add(board.peekSessionId);
  if (board.peekFileRef) sessionIds.add(board.peekFileRef.sourceSessionId);
  return [...sessionIds];
}

/** Retire a Session everywhere so an inactive Project cannot restore it later. */
export function retireProjectViewSessionSurfaces(sessionId: string): void {
  useTabStore.getState().retireSessionSurface(sessionId);
  useBoardStore.getState().retireSessionPeek(sessionId);
}
