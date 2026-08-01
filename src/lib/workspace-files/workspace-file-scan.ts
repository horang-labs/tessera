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

type SymlinkTargetKind = "file" | "other";

type PathModule = typeof path.win32 | typeof path.posix;

export function normalizeWorkspaceRelativePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
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

export async function walkWorkspaceFiles(root: string): Promise<WorkspaceFileWalkResult> {
  const out: string[] = [];
  const symlinks = new Set<string>();
  let truncated = false;
  const pathModule: PathModule = getFilesystemPathModule(root);

  async function recurse(absDir: string, relDir: string): Promise<void> {
    if (truncated) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (truncated) return;
      const childRel = relDir ? `${relDir}/${ent.name}` : ent.name;
      // Collect dotfiles too — the client filters them via the show-hidden
      // toggle. Only the always-ignored build/VCS dirs are pruned here.
      if (isIgnoredWorkspacePath(childRel, ent, { includeHidden: true })) continue;

      if (ent.isDirectory()) {
        await recurse(pathModule.join(absDir, ent.name), childRel);
      } else if (ent.isFile()) {
        out.push(childRel);
        symlinks.delete(childRel);
        if (out.length >= MAX_WORKSPACE_FILES) {
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
        if (out.length >= MAX_WORKSPACE_FILES) {
          truncated = true;
          return;
        }
      }
    }
  }

  await recurse(root, "");
  out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return {
    files: out,
    symlinks: out.filter((filePath) => symlinks.has(filePath)),
    truncated,
  };
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
