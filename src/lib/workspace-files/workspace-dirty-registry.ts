/**
 * Which workspace files currently hold unsaved edits.
 *
 * The draft itself lives in the file tab's own state, where the explorer
 * cannot see it — and the explorer is where a delete is confirmed. Deleting a
 * file discards its draft with it (no autosave, no hot exit), so the
 * confirmation has to be able to say so, which means something outside the tab
 * has to know. This is that: a name, nothing more, registered while the buffer
 * is dirty and dropped as soon as it is not.
 */
const dirtyPaths = new Set<string>();

function key(workspaceKey: string, filePath: string): string {
  return `${workspaceKey}\0${filePath}`;
}

export function markWorkspaceFileDirty(workspaceKey: string, filePath: string): void {
  dirtyPaths.add(key(workspaceKey, filePath));
}

export function clearWorkspaceFileDirty(workspaceKey: string, filePath: string): void {
  dirtyPaths.delete(key(workspaceKey, filePath));
}

export function hasUnsavedWorkspaceFileEdits(
  workspaceKey: string | null,
  filePath: string,
): boolean {
  if (!workspaceKey) return false;
  return dirtyPaths.has(key(workspaceKey, filePath));
}
