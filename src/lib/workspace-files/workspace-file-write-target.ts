import type * as path from "path";
import { isAbsoluteFilesystemPath } from "@/lib/filesystem/host-path";
import {
  isInsideWorkspacePath,
  resolveWorkspaceReadTarget,
} from "./workspace-file-read-target";

type PathModule = typeof path.win32 | typeof path.posix;

export type WorkspaceWritePathRejection =
  | "empty"
  | "nul"
  | "absolute"
  | "invalid_base"
  | "escapes";

export type WorkspaceWritePathParse =
  | { ok: false; reason: WorkspaceWritePathRejection }
  | { ok: true; normalizedPath: string };

/**
 * Validate a client-supplied workspace-relative path before it reaches the
 * filesystem. Everything here is lexical: it rejects what can never name a
 * file inside the workspace, so the caller only ever realpaths a path that
 * already looks legitimate.
 */
export function parseWorkspaceWritePath(rawPath: string): WorkspaceWritePathParse {
  if (!rawPath.trim()) return { ok: false, reason: "empty" };
  if (rawPath.includes("\0")) return { ok: false, reason: "nul" };

  const requestedPath = rawPath.replace(/\\/g, "/").trim();
  if (isAbsoluteFilesystemPath(requestedPath)) return { ok: false, reason: "absolute" };

  const segments: string[] = [];
  let escaped = false;
  for (const segment of requestedPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        escaped = true;
        break;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (escaped) return { ok: false, reason: "escapes" };
  // Nothing left means the path named the workspace root or a dot segment —
  // a directory, and this route only ever writes files.
  if (segments.length === 0) return { ok: false, reason: "invalid_base" };
  // A trailing separator ("src/") means the caller meant a directory too.
  if (/[\\/]\s*$/.test(rawPath)) return { ok: false, reason: "invalid_base" };

  return { ok: true, normalizedPath: segments.join("/") };
}

export interface WorkspaceWriteTargetInput {
  /** The file name the write lands on, already split off the requested path. */
  baseName: string;
  /** Whether the candidate is itself a symbolic link (lstat); false when it does not exist. */
  candidateIsSymlink: boolean;
  /** The candidate resolved through realpath, or null when it does not exist yet. */
  candidateRealPath: string | null;
  /** The directory the file will live in, already resolved through realpath. */
  parentRealPath: string;
  pathModule: PathModule;
  /** The workspace root, already resolved through realpath. */
  rootRealPath: string;
}

export type WorkspaceWriteTarget =
  | { allowed: false }
  | { allowed: true; absolutePath: string; relativePath: string };

export function resolveWorkspaceWriteTarget(
  input: WorkspaceWriteTargetInput,
): WorkspaceWriteTarget {
  const {
    baseName,
    candidateIsSymlink,
    candidateRealPath,
    parentRealPath,
    pathModule,
    rootRealPath,
  } = input;

  // The parent is checked after realpath, so a linked directory cannot be used
  // to walk out of the workspace — the same rule the read side enforces.
  if (!isInsideWorkspacePath(rootRealPath, parentRealPath, pathModule)) {
    return { allowed: false };
  }

  const absolutePath = pathModule.join(parentRealPath, baseName);

  // A file that already exists is judged by the read rule, so the two sides
  // agree on what "inside the workspace" means: exactly one link is followed,
  // and only when the requested path is itself that link.
  if (candidateRealPath !== null) {
    const target = resolveWorkspaceReadTarget({
      candidatePath: absolutePath,
      candidateIsSymlink,
      pathModule,
      rootRealPath,
      targetRealPath: candidateRealPath,
    });
    if (!target.allowed) return { allowed: false };
    return { allowed: true, absolutePath, relativePath: target.relativePath };
  }

  return {
    allowed: true,
    absolutePath,
    relativePath: pathModule.relative(rootRealPath, absolutePath).split(/[\\/]+/).join("/"),
  };
}
