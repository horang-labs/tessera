import { useBoardStore } from '@/stores/board-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTabStore } from '@/stores/tab-store';
import { getRenderedViewMode } from '@/lib/viewport/rendered-view-mode';
import { activateSessionPanel } from '@/lib/session/focus-session-panel';
import { switchToSessionProject } from '@/lib/session/switch-session-project';
import { getSessionOriginProjectId } from '@/lib/projects/origin-project-representation';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import type { UnifiedSession } from '@/types/chat';

export type OpenSessionSurfaceResult =
  | { status: 'opened'; historyLoad?: Promise<void> }
  | { status: 'not_found' }
  | { status: 'blocked' };

/**
 * Show a Session that was named outside the normal sidebar click path — a
 * notification, or the Tessera CLI — on whatever surface the user would see it.
 *
 * The surface is chosen synchronously before any history I/O, so a slower,
 * older load can never overwrite a newer tab or panel selection. When the
 * Session needed a fresh tab, `historyLoad` settles once its history is shown.
 */
export async function openSessionSurface(
  sessionId: string,
  navigation: {
    materializeSession: (sessionId: string) => Promise<UnifiedSession | undefined>;
    viewSession: (session: UnifiedSession) => Promise<void>;
  },
): Promise<OpenSessionSurfaceResult> {
  const session = await navigation.materializeSession(sessionId);
  if (!session) return { status: 'not_found' };

  projectViewWorkspaceState.markSessionRead(sessionId);

  // The Session may live in another project — bring that project into scope first,
  // otherwise it opens in a tab belonging to the project currently on screen.
  if (!switchToSessionProject(getSessionOriginProjectId(session))) return { status: 'blocked' };

  // Kanban peek mode: open the session in the board peek panel instead of a tab
  const boardStore = useBoardStore.getState();
  const peekMode = useSettingsStore.getState().settings.kanbanSessionOpenMode === 'peek';
  // The rendered mode, not the stored one: a phone shows the list, so a peek
  // opened here would have nothing rendering it and the tap would do nothing.
  if (getRenderedViewMode() === 'board' && peekMode) {
    boardStore.openSessionPeek(sessionId);
    return { status: 'opened' };
  }

  // Tab-aware session focus: use findSessionLocation (same as sidebar click handler)
  const tabStore = useTabStore.getState();
  const location = tabStore.findSessionLocation(sessionId);
  if (location) {
    activateSessionPanel(sessionId, { location });
    return { status: 'opened' };
  }

  tabStore.openPreview(sessionId);
  return { status: 'opened', historyLoad: navigation.viewSession(session) };
}
