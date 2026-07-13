import * as fs from "fs/promises";
import * as path from "path";
import { getFilesystemPathModule } from "@/lib/filesystem/host-path";

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
  truncated: boolean;
};

type PathModule = typeof path.win32 | typeof path.posix;

export function normalizeWorkspaceRelativePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

export function isIgnoredWorkspacePath(filePath: string, stats?: { isDirectory(): boolean }): boolean {
  const normalized = normalizeWorkspaceRelativePath(filePath);
  if (!normalized) return false;

  const parts = normalized.split("/");
  const basename = parts[parts.length - 1] ?? "";
  if (basename.startsWith(".") && basename !== ".env.example") {
    return true;
  }

  const directoryParts = stats?.isDirectory() ? parts : parts.slice(0, -1);
  if (directoryParts.some((part) => part.startsWith("."))) {
    return true;
  }
  return directoryParts.some((part) => IGNORED_WORKSPACE_DIR_NAMES.has(part));
}

export async function walkWorkspaceFiles(root: string): Promise<WorkspaceFileWalkResult> {
  const out: string[] = [];
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
      if (isIgnoredWorkspacePath(childRel, ent)) continue;

      if (ent.isDirectory()) {
        await recurse(pathModule.join(absDir, ent.name), childRel);
      } else if (ent.isFile()) {
        out.push(childRel);
        if (out.length >= MAX_WORKSPACE_FILES) {
          truncated = true;
          return;
        }
      }
    }
  }

  await recurse(root, "");
  out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return { files: out, truncated };
}

export function applyMaxFiles(fileSet: Set<string>): WorkspaceFileWalkResult {
  const files = Array.from(fileSet)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return {
    files: files.slice(0, MAX_WORKSPACE_FILES),
    truncated: files.length > MAX_WORKSPACE_FILES,
  };
}
