import type { MemoryTargetKind } from "@/types/memory";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const WORKSPACE_FILE_SESSION_PREFIX = "__workspace-file__|" as const;
export const WORKTREE_FILE_SESSION_PREFIX = "__worktree-file__|" as const;
export const WORKTREE_DIFF_SESSION_PREFIX = "__worktree-diff__|" as const;
export const MEMORY_FILE_SESSION_PREFIX = "__memory-file__|" as const;

export type WorkspaceFileTabKind = "file" | "diff";

export interface WorkspaceFileSessionRef {
  type: "workspace-file";
  sourceSessionId: string;
  /** Stable physical identity when this Session belongs to a Worktree. */
  sourceWorktreeId?: string;
  kind: WorkspaceFileTabKind;
  path: string;
}

export interface WorktreeFileSessionRef {
  type: "worktree-file";
  sourceWorktreeId: string;
  kind: WorkspaceFileTabKind;
  path: string;
}

export type WorkspaceFileRef = WorkspaceFileSessionRef | WorktreeFileSessionRef;

export interface MemoryFileSessionRef {
  type: "memory-file";
  sourceSessionId: string;
  memoryKind: MemoryTargetKind;
  /** Memory file name or provider-relative memory path. */
  fileName: string;
}

export function buildWorkspaceFileSessionId(
  sourceSessionId: string,
  kind: WorkspaceFileTabKind,
  filePath: string,
  sourceWorktreeId?: string | null,
): string {
  if (sourceWorktreeId) {
    return `${WORKSPACE_FILE_SESSION_PREFIX}${encodeURIComponent(sourceSessionId)}|${encodeURIComponent(sourceWorktreeId)}|${encodeURIComponent(kind)}|${encodeURIComponent(filePath)}`;
  }
  return `${WORKSPACE_FILE_SESSION_PREFIX}${encodeURIComponent(sourceSessionId)}|${encodeURIComponent(kind)}|${encodeURIComponent(filePath)}`;
}

export function buildWorktreeFileSessionId(
  sourceWorktreeId: string,
  filePath: string,
  kind: WorkspaceFileTabKind = "file",
): string {
  const prefix = kind === "diff" ? WORKTREE_DIFF_SESSION_PREFIX : WORKTREE_FILE_SESSION_PREFIX;
  return `${prefix}${encodeURIComponent(sourceWorktreeId)}|${encodeURIComponent(filePath)}`;
}

export function parseWorkspaceFileSessionId(
  sessionId: string,
): WorkspaceFileSessionRef | null {
  if (!sessionId.startsWith(WORKSPACE_FILE_SESSION_PREFIX)) return null;
  const parts = sessionId.slice(WORKSPACE_FILE_SESSION_PREFIX.length).split("|");
  const [encodedSourceSessionId, encodedWorktreeOrKind, encodedKindOrPath, encodedPath] = parts;
  const hasWorktreeIdentity = parts.length === 4;
  const encodedWorktreeId = hasWorktreeIdentity ? encodedWorktreeOrKind : null;
  const encodedKind = hasWorktreeIdentity ? encodedKindOrPath : encodedWorktreeOrKind;
  const resolvedEncodedPath = hasWorktreeIdentity ? encodedPath : encodedKindOrPath;
  if (!encodedSourceSessionId || !encodedKind || !resolvedEncodedPath) return null;
  try {
    const kind = decodeURIComponent(encodedKind);
    if (kind !== "file" && kind !== "diff") return null;
    return {
      type: "workspace-file",
      sourceSessionId: decodeURIComponent(encodedSourceSessionId),
      ...(encodedWorktreeId
        ? { sourceWorktreeId: decodeURIComponent(encodedWorktreeId) }
        : {}),
      kind,
      path: decodeURIComponent(resolvedEncodedPath),
    };
  } catch {
    return null;
  }
}

export function parseWorktreeFileSessionId(
  sessionId: string,
): WorktreeFileSessionRef | null {
  const kind = sessionId.startsWith(WORKTREE_DIFF_SESSION_PREFIX)
    ? "diff"
    : sessionId.startsWith(WORKTREE_FILE_SESSION_PREFIX)
      ? "file"
      : null;
  if (!kind) return null;
  const prefix = kind === "diff" ? WORKTREE_DIFF_SESSION_PREFIX : WORKTREE_FILE_SESSION_PREFIX;
  const [encodedWorktreeId, encodedPath] = sessionId
    .slice(prefix.length)
    .split("|");
  if (!encodedWorktreeId || !encodedPath) return null;
  try {
    return {
      type: "worktree-file",
      sourceWorktreeId: decodeURIComponent(encodedWorktreeId),
      kind,
      path: decodeURIComponent(encodedPath),
    };
  } catch {
    return null;
  }
}

export function buildMemoryFileSessionId(
  sourceSessionId: string,
  memoryKind: MemoryTargetKind,
  fileName: string,
): string {
  return `${MEMORY_FILE_SESSION_PREFIX}${encodeURIComponent(sourceSessionId)}|${encodeURIComponent(memoryKind)}|${encodeURIComponent(fileName)}`;
}

function parseMemoryTargetKind(value: string): MemoryTargetKind | null {
  return value === "memory" || value === "global-guideline" || value === "project-guideline"
    ? value
    : null;
}

export function parseMemoryFileSessionId(
  sessionId: string,
): MemoryFileSessionRef | null {
  if (!sessionId.startsWith(MEMORY_FILE_SESSION_PREFIX)) return null;
  const [encodedSourceSessionId, encodedKind, encodedFileName] = sessionId
    .slice(MEMORY_FILE_SESSION_PREFIX.length)
    .split("|");
  if (!encodedSourceSessionId || !encodedKind || !encodedFileName) return null;
  try {
    const memoryKind = parseMemoryTargetKind(decodeURIComponent(encodedKind));
    if (!memoryKind) return null;
    return {
      type: "memory-file",
      sourceSessionId: decodeURIComponent(encodedSourceSessionId),
      memoryKind,
      fileName: decodeURIComponent(encodedFileName),
    };
  } catch {
    return null;
  }
}

export function parseWorkspaceSpecialSessionId(
  sessionId: string,
): WorkspaceFileRef | MemoryFileSessionRef | null {
  return parseWorkspaceFileSessionId(sessionId)
    ?? parseWorktreeFileSessionId(sessionId)
    ?? parseMemoryFileSessionId(sessionId);
}

export function getWorkspaceSpecialSessionTitle(sessionId: string, t?: Translate): string | null {
  const memory = parseMemoryFileSessionId(sessionId);
  if (memory) {
    const name = memory.fileName.split(/[\\/]/).filter(Boolean).pop() || memory.fileName;
    if (memory.memoryKind === "global-guideline") {
      return `${name} · ${t ? t("memoryPanel.fileTab.globalScope") : "Global"}`;
    }
    if (memory.memoryKind === "project-guideline") {
      return `${name} · ${t ? t("memoryPanel.fileTab.projectScope") : "Project"}`;
    }
    return name;
  }

  const file = parseWorkspaceFileSessionId(sessionId);
  const worktreeFile = parseWorktreeFileSessionId(sessionId);
  if (!file && !worktreeFile) return null;
  const resolvedFile = file ?? worktreeFile!;
  const name = resolvedFile.path.split("/").pop() || resolvedFile.path;
  return resolvedFile.kind === "diff" ? `${name} ${t ? t("gitPanel.tabs.diff") : "diff"}` : name;
}

export function getWorkspaceSpecialSourceSessionId(sessionId: string): string | null {
  const ref = parseWorkspaceSpecialSessionId(sessionId);
  return ref && 'sourceSessionId' in ref ? ref.sourceSessionId : null;
}
