import { usePanelStore } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import {
  buildWorkspaceFileSessionId,
  type WorkspaceFileTabKind,
} from "@/lib/workspace-tabs/special-session";

const WORKSPACE_FILE_TAB_KINDS: WorkspaceFileTabKind[] = ["file", "diff"];

/**
 * Whether a tree operation on `mutatedPath` also lands on `openPath`.
 *
 * Deleting or renaming a folder moves everything under it, so a tab showing a
 * file inside that folder is just as stale as one showing the folder's own
 * path — matching on the path alone would leave those tabs pointed at
 * something that no longer exists.
 */
export function isPathUnderMutation(openPath: string, mutatedPath: string): boolean {
  return openPath === mutatedPath || openPath.startsWith(`${mutatedPath}/`);
}

/**
 * Close every workspace file tab whose path a delete has just removed.
 *
 * A deleted file leaves the tab showing content for a path that is gone; the
 * user gets a stale editor they can still type into. Retiring the surface is
 * what the store already does when a session goes away.
 */
export function closeWorkspaceFileTabsFor(sessionId: string, deletedPath: string): void {
  const tabStore = useTabStore.getState();
  for (const openPath of listOpenWorkspaceFilePaths(sessionId)) {
    if (!isPathUnderMutation(openPath.path, deletedPath)) continue;
    tabStore.retireSessionSurface(
      buildWorkspaceFileSessionId(sessionId, openPath.kind, openPath.path),
    );
  }
}

/**
 * Re-point open tabs after a rename, instead of leaving them dead.
 *
 * The watcher would eventually report the rename as a delete/add pair and the
 * file tab re-points itself off that, but only for a tab that is mounted and
 * subscribed. Doing it here means the tab follows its file whether or not it
 * was the active one, and whether or not the watcher batched the pair.
 */
export function repointWorkspaceFileTabs(
  sessionId: string,
  previousPath: string,
  nextPath: string,
): void {
  const tabStore = useTabStore.getState();
  const panelStore = usePanelStore.getState();

  for (const { kind, path } of listOpenWorkspaceFilePaths(sessionId)) {
    if (!isPathUnderMutation(path, previousPath)) continue;
    const movedPath = nextPath + path.slice(previousPath.length);
    const location = tabStore.findSessionLocation(
      buildWorkspaceFileSessionId(sessionId, kind, path),
    );
    if (!location) continue;
    panelStore.assignSessionInTab(
      location.tabId,
      location.panelId,
      buildWorkspaceFileSessionId(sessionId, kind, movedPath),
    );
  }
}

interface OpenWorkspaceFilePath {
  kind: WorkspaceFileTabKind;
  path: string;
}

/**
 * Every workspace file path this session currently has open, read off the panel
 * layouts rather than off a registry — the panels are the only record of what
 * is on screen.
 */
function listOpenWorkspaceFilePaths(sessionId: string): OpenWorkspaceFilePath[] {
  const panelStore = usePanelStore.getState();
  const found = new Map<string, OpenWorkspaceFilePath>();

  for (const tabData of Object.values(panelStore.tabPanels)) {
    for (const panel of Object.values(tabData.panels)) {
      const openSessionId = panel.sessionId;
      if (!openSessionId) continue;
      for (const kind of WORKSPACE_FILE_TAB_KINDS) {
        const prefix = buildWorkspaceFileSessionId(sessionId, kind, "");
        if (!openSessionId.startsWith(prefix)) continue;
        try {
          const path = decodeURIComponent(openSessionId.slice(prefix.length));
          if (path) found.set(openSessionId, { kind, path });
        } catch {
          // A session id that will not decode names no file we can act on.
        }
      }
    }
  }

  return Array.from(found.values());
}
