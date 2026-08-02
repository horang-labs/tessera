import * as fs from "fs/promises";
import * as path from "path";
import { getFilesystemPathModule } from "@/lib/filesystem/host-path";
import { isHiddenWorkspaceRelativePath } from "./hidden-workspace-path";

export const MAX_WORKSPACE_FILES = 20000;

export const IGNORED_WORKSPACE_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  ".turbo",
  "coverage",
  ".cache",
  ".vercel",
  ".idea",
  ".vscode",
  "out",
]);

export type WorkspaceFileWalkResult = {
  files: string[];
  /** Subset of `files` reached through a symbolic link, so the UI can mark them. */
  symlinks: string[];
  truncated: boolean;
};

export type WorkspaceDirectoryScanResult = WorkspaceFileWalkResult & {
  /**
   * The scanned directory itself could not be read. The caller has to drop
   * whatever it held for that subtree rather than merge an empty listing.
   */
  missing: boolean;
};

type SymlinkTargetKind = "file" | "other";

type PathModule = typeof path.win32 | typeof path.posix;

export function normalizeWorkspaceRelativePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

/**
 * The directory a workspace-relative path sits in, `""` for the root itself.
 * Watch events are turned into a rescan of this directory rather than being
 * trusted as index contents.
 */
export function workspaceRelativeDirname(relativePath: string): string {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "" : normalized.slice(0, separator);
}

export function isIgnoredWorkspacePath(
  filePath: string,
  stats?: { isDirectory(): boolean },
  options?: { includeHidden?: boolean },
): boolean {
  const normalized = normalizeWorkspaceRelativePath(filePath);
  if (!normalized) return false;

  const parts = normalized.split("/");
  const directoryParts = stats?.isDirectory() ? parts : parts.slice(0, -1);

  // Build/VCS/cache output dirs are always excluded: they hold thousands of
  // files (blowing past MAX_WORKSPACE_FILES) and the WSL inotify bridge relies
  // on this set to skip watching them. The show-hidden toggle never surfaces them.
  if (directoryParts.some((part) => IGNORED_WORKSPACE_DIR_NAMES.has(part))) {
    return true;
  }

  // Other dotfiles (.github, .env, .claude, …) are hidden by default, but the
  // caller can opt in to stream the full list so a client-side toggle can reveal
  // them without a re-scan.
  if (!options?.includeHidden && isHiddenWorkspaceRelativePath(normalized)) {
    return true;
  }
  return false;
}

/**
 * Resolve what a symlink points at. `readdir` reports link types (lstat), so a
 * symlink is never `isFile()`; the target has to be stat'd separately. Returns
 * `"other"` for directories, dangling links, and anything unreadable.
 */
export async function classifySymlinkTarget(absolutePath: string): Promise<SymlinkTargetKind> {
  try {
    const target = await fs.stat(absolutePath);
    return target.isFile() ? "file" : "other";
  } catch {
    return "other";
  }
}

/**
 * Read one directory of the workspace, or its whole subtree.
 *
 * A watch event names a path; it does not describe the state of the tree
 * around it, and the events that never arrive are the ones that matter. A
 * directory created and filled faster than a recursive watch can be registered
 * delivers no creation event for its contents at all — verified against
 * inotify-tools 3.22: `cp -R` into a watched root reports the top directory
 * and its immediate files, but nothing for a nested one. So callers treat an
 * event as an invalidation — "read this directory again" — and this does the
 * reading. Whatever the events missed is found here.
 */
export async function scanWorkspaceDirectory(
  root: string,
  relativeDir: string,
  options?: { limit?: number; recursive?: boolean },
): Promise<WorkspaceDirectoryScanResult> {
  const limit = options?.limit ?? MAX_WORKSPACE_FILES;
  const recursive = options?.recursive ?? true;
  const out: string[] = [];
  const symlinks = new Set<string>();
  let truncated = false;
  let missing = false;
  const pathModule: PathModule = getFilesystemPathModule(root);
  const startRel = normalizeWorkspaceRelativePath(relativeDir);

  async function recurse(absDir: string, relDir: string, isStart: boolean): Promise<void> {
    if (truncated) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      // Only the requested directory going missing is meaningful: it tells the
      // caller to drop that subtree. A descendant that races away mid-walk just
      // contributes nothing.
      if (isStart) missing = true;
      return;
    }

    for (const ent of entries) {
      if (truncated) return;
      const childRel = relDir ? `${relDir}/${ent.name}` : ent.name;
      // Collect dotfiles too — the client filters them via the show-hidden
      // toggle. Only the always-ignored build/VCS dirs are pruned here.
      if (isIgnoredWorkspacePath(childRel, ent, { includeHidden: true })) continue;

      if (ent.isDirectory()) {
        if (recursive) await recurse(pathModule.join(absDir, ent.name), childRel, false);
      } else if (ent.isFile()) {
        out.push(childRel);
        symlinks.delete(childRel);
        if (out.length >= limit) {
          truncated = true;
          return;
        }
      } else if (ent.isSymbolicLink()) {
        // Linked files are listed like any other file: worktree bootstrap
        // scripts routinely link CLAUDE.md/AGENTS.md back to the source
        // checkout, and dropping them makes the tree disagree with the shell.
        // Only file targets are listed — a link to a directory would render as
        // a leaf that cannot be opened, and recursing into it invites traversal
        // loops and paths escaping the workspace root.
        if (await classifySymlinkTarget(pathModule.join(absDir, ent.name)) !== "file") continue;
        out.push(childRel);
        symlinks.add(childRel);
        if (out.length >= limit) {
          truncated = true;
          return;
        }
      }
    }
  }

  const absStart = startRel ? pathModule.join(root, ...startRel.split("/")) : root;
  await recurse(absStart, startRel, true);
  out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return {
    files: out,
    symlinks: out.filter((filePath) => symlinks.has(filePath)),
    missing,
    truncated,
  };
}

export async function walkWorkspaceFiles(root: string): Promise<WorkspaceFileWalkResult> {
  const { files, symlinks, truncated } = await scanWorkspaceDirectory(root, "", {
    limit: MAX_WORKSPACE_FILES,
    recursive: true,
  });
  return { files, symlinks, truncated };
}

export function applyMaxFiles(
  fileSet: Set<string>,
  symlinkSet?: Set<string>,
): WorkspaceFileWalkResult {
  const sorted = Array.from(fileSet)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  const files = sorted.slice(0, MAX_WORKSPACE_FILES);
  return {
    files,
    // Stays a subset of the capped list: a symlink dropped by the cap must not
    // leak into the marker list the client joins against.
    symlinks: symlinkSet?.size ? files.filter((filePath) => symlinkSet.has(filePath)) : [],
    truncated: sorted.length > MAX_WORKSPACE_FILES,
  };
}
