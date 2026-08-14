import { usePanelStore } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import {
  buildWorktreeFileSessionId,
  buildWorkspaceFileSessionId,
  parseWorktreeFileSessionId,
  parseWorkspaceFileSessionId,
  type WorkspaceFileTabKind,
} from "@/lib/workspace-tabs/special-session";
import type { WorkspaceTarget } from '@/types/worktree';

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
export function closeWorkspaceFileTabsFor(target: WorkspaceTarget, deletedPath: string): void {
  const tabStore = useTabStore.getState();
  for (const openPath of listOpenWorkspaceFilePaths(target)) {
    if (!isPathUnderMutation(openPath.path, deletedPath)) continue;
    tabStore.retireSessionSurface(openPath.sessionId);
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
  target: WorkspaceTarget,
  previousPath: string,
  nextPath: string,
): void {
  const tabStore = useTabStore.getState();
  const panelStore = usePanelStore.getState();

  for (const { kind, path, ref, sessionId } of listOpenWorkspaceFilePaths(target)) {
    if (!isPathUnderMutation(path, previousPath)) continue;
    const movedPath = nextPath + path.slice(previousPath.length);
    const location = tabStore.findSessionLocation(sessionId);
    if (!location) continue;
    const nextSessionId = ref.type === 'workspace-file'
      ? buildWorkspaceFileSessionId(
          ref.sourceSessionId,
          kind,
          movedPath,
          ref.sourceWorktreeId,
        )
      : buildWorktreeFileSessionId(ref.sourceWorktreeId, movedPath, kind);
    panelStore.assignSessionInTab(
      location.tabId,
      location.panelId,
      nextSessionId,
      ref.sourceWorktreeId,
    );
  }
}

interface OpenWorkspaceFilePath {
  kind: WorkspaceFileTabKind;
  path: string;
  ref: NonNullable<ReturnType<typeof parseWorkspaceFileSessionId>>
    | NonNullable<ReturnType<typeof parseWorktreeFileSessionId>>;
  sessionId: string;
}

/**
 * Every workspace file path this session currently has open, read off the panel
 * layouts rather than off a registry — the panels are the only record of what
 * is on screen.
 */
function fileRefMatchesTarget(
  target: WorkspaceTarget,
  ref: OpenWorkspaceFilePath['ref'],
): boolean {
  if (target.kind === 'worktree') {
    return ref.sourceWorktreeId === target.id;
  }
  if (target.worktreeId) {
    return ref.sourceWorktreeId === target.worktreeId;
  }
  return ref.type === 'workspace-file' && ref.sourceSessionId === target.id;
}

function listOpenWorkspaceFilePaths(target: WorkspaceTarget): OpenWorkspaceFilePath[] {
  const panelStore = usePanelStore.getState();
  const found = new Map<string, OpenWorkspaceFilePath>();

  for (const tabData of Object.values(panelStore.tabPanels)) {
    for (const panel of Object.values(tabData.panels)) {
      const openSessionId = panel.sessionId;
      if (!openSessionId) continue;
      const ref = parseWorkspaceFileSessionId(openSessionId)
        ?? parseWorktreeFileSessionId(openSessionId);
      if (!ref || !WORKSPACE_FILE_TAB_KINDS.includes(ref.kind)) continue;
      if (!fileRefMatchesTarget(target, ref)) continue;
      found.set(openSessionId, {
        kind: ref.kind,
        path: ref.path,
        ref,
        sessionId: openSessionId,
      });
    }
  }

  return Array.from(found.values());
}
