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

/** Marks the row's name text, which doubles as the double-click-to-rename hotspot. */
export const RENAME_HOTSPOT_ATTR = "data-workspace-row-name";

/**
 * Duck-typed on `closest` rather than `instanceof Element`: this module carries
 * the rules, and the rules are the same whether a real DOM is present or not.
 */
export function isRenameHotspotTarget(target: unknown): boolean {
  const candidate = target as { closest?: (selector: string) => unknown } | null;
  if (!candidate || typeof candidate.closest !== "function") return false;
  return candidate.closest(`[${RENAME_HOTSPOT_ATTR}]`) != null;
}

/** Whether the folder's disclosure should run now, wait, or step aside. */
export type WorkspaceDirToggleTiming = "immediate" | "deferred" | "skip";

/**
 * Chromium's own double-click window, so a deferred toggle cannot fire before
 * the second click of a slow double-click arrives and turns the gesture into a
 * rename.
 */
export const DIR_TOGGLE_DOUBLE_CLICK_MS = 500;

/**
 * A double-click on a folder's name means rename, but each of its two clicks
 * also reaches the row and toggles the disclosure, so the folder collapses and
 * re-expands before the input appears. A click that starts on the name waits
 * out the double-click window; the second click drops the toggle and lets the
 * rename take over. Ported from Orca's `resolveDirToggleTiming`.
 */
export function resolveDirToggleTiming({
  clickCount,
  fromRenameHotspot,
}: {
  clickCount: number;
  fromRenameHotspot: boolean;
}): WorkspaceDirToggleTiming {
  if (!fromRenameHotspot) return "immediate";
  return clickCount > 1 ? "skip" : "deferred";
}

/**
 * Whether a click on a file row should open the file. A file row has nothing
 * to defer — the first click opens a preview, as it always has — so only the
 * second click of a double-click on the name is dropped, leaving that gesture
 * meaning rename and nothing else.
 */
export function shouldOpenOnRowClick({
  clickCount,
  fromRenameHotspot,
}: {
  clickCount: number;
  fromRenameHotspot: boolean;
}): boolean {
  return !(fromRenameHotspot && clickCount > 1);
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
