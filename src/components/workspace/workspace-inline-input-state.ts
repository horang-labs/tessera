/**
 * The rules behind the File Explorer's inline name entry, kept free of React
 * and of the DOM so they can be exercised directly.
 */

/** An inline input that is currently open, and what submitting it means. */
export type WorkspaceInlineInput =
  | { kind: "new-file"; parentPath: string }
  | { kind: "new-folder"; parentPath: string }
  | { kind: "rename"; path: string; name: string; isDirectory: boolean };

/** What a submitted value asks the panel to do. */
export type WorkspaceInlineSubmitIntent =
  | { kind: "create-file"; path: string }
  | { kind: "create-folder"; path: string }
  | { kind: "rename"; path: string; newName: string }
  /** Nothing to ask the server for: close the input and touch no network. */
  | { kind: "cancel" };

export const DIRECTORY_RENAME_DOUBLE_CLICK_MS = 300;

/** Whether two clicks qualify as the deliberately fast folder-rename gesture. */
export function isRapidDirectoryRenameDoubleClick({
  clickCount,
  path,
  previousPath,
  previousTimestamp,
  timestamp,
}: {
  clickCount: number;
  path: string;
  previousPath: string | undefined;
  previousTimestamp: number | undefined;
  timestamp: number;
}): boolean {
  return clickCount === 2
    && previousPath === path
    && previousTimestamp !== undefined
    && timestamp >= previousTimestamp
    && timestamp - previousTimestamp <= DIRECTORY_RENAME_DOUBLE_CLICK_MS;
}

/**
 * A qualified rapid double-click reserves its second click for rename. A slow
 * second click is still an ordinary expand/collapse action even if Chromium
 * groups it into a native `dblclick` gesture.
 */
export function shouldToggleDirectoryOnClick(
  clickCount: number,
  isQualifiedDoubleClick = false,
): boolean {
  return clickCount !== 2 || !isQualifiedDoubleClick;
}

/**
 * Whether a click on a file row should open the file. Chromium dispatches two
 * click events before `dblclick`; only the first may create a tab, regardless
 * of whether the pointer was over the rename hotspot.
 */
export function shouldOpenOnRowClick(clickCount: number): boolean {
  return clickCount === 1;
}

/**
 * The selection an inline rename opens with: the name without its extension,
 * so retyping a name is not retyping ".md" as well. A leading dot is part of
 * the name, not an extension — `.gitignore` selects whole.
 */
export function selectBaseNameRange(name: string): [number, number] {
  const dot = name.lastIndexOf(".");
  return [0, dot > 0 ? dot : name.length];
}

function joinWorkspacePath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

export function resolveInlineSubmitIntent(
  input: WorkspaceInlineInput,
  value: string,
): WorkspaceInlineSubmitIntent {
  const name = value.trim();
  if (!name) return { kind: "cancel" };

  if (input.kind === "rename") {
    // Submitting the name it already has — a blur without an edit, most often —
    // is not a rename, and the server would refuse it as a collision with itself.
    if (name === input.name) return { kind: "cancel" };
    return { kind: "rename", path: input.path, newName: name };
  }

  const path = joinWorkspacePath(input.parentPath, name);
  return input.kind === "new-folder"
    ? { kind: "create-folder", path }
    : { kind: "create-file", path };
}
