import type { MemoryTargetKind } from "@/types/memory";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const WORKSPACE_EXPLORER_SESSION_PREFIX = "__workspace-explorer__|" as const;
export const WORKSPACE_FILE_SESSION_PREFIX = "__workspace-file__|" as const;
export const MEMORY_FILE_SESSION_PREFIX = "__memory-file__|" as const;

export type WorkspaceFileTabKind = "file" | "diff";

export interface WorkspaceExplorerSessionRef {
  type: "explorer";
  sourceSessionId: string;
}

export interface WorkspaceFileSessionRef {
  type: "workspace-file";
  sourceSessionId: string;
  kind: WorkspaceFileTabKind;
  path: string;
}

export interface MemoryFileSessionRef {
  type: "memory-file";
  sourceSessionId: string;
  memoryKind: MemoryTargetKind;
  /** Memory file name or provider-relative memory path. */
  fileName: string;
}

export function buildWorkspaceExplorerSessionId(sourceSessionId: string): string {
  return `${WORKSPACE_EXPLORER_SESSION_PREFIX}${encodeURIComponent(sourceSessionId)}`;
}

export function buildWorkspaceFileSessionId(
  sourceSessionId: string,
  kind: WorkspaceFileTabKind,
  filePath: string,
): string {
  return `${WORKSPACE_FILE_SESSION_PREFIX}${encodeURIComponent(sourceSessionId)}|${encodeURIComponent(kind)}|${encodeURIComponent(filePath)}`;
}

export function parseWorkspaceExplorerSessionId(
  sessionId: string,
): WorkspaceExplorerSessionRef | null {
  if (!sessionId.startsWith(WORKSPACE_EXPLORER_SESSION_PREFIX)) return null;
  const encodedSourceSessionId = sessionId.slice(WORKSPACE_EXPLORER_SESSION_PREFIX.length);
  if (!encodedSourceSessionId) return null;
  try {
    return {
      type: "explorer",
      sourceSessionId: decodeURIComponent(encodedSourceSessionId),
    };
  } catch {
    return null;
  }
}

export function parseWorkspaceFileSessionId(
  sessionId: string,
): WorkspaceFileSessionRef | null {
  if (!sessionId.startsWith(WORKSPACE_FILE_SESSION_PREFIX)) return null;
  const parts = sessionId.slice(WORKSPACE_FILE_SESSION_PREFIX.length).split("|");
  const [encodedSourceSessionId, encodedKind, encodedPath] = parts;
  if (!encodedSourceSessionId || !encodedKind || !encodedPath) return null;
  try {
    const kind = decodeURIComponent(encodedKind);
    if (kind !== "file" && kind !== "diff") return null;
    return {
      type: "workspace-file",
      sourceSessionId: decodeURIComponent(encodedSourceSessionId),
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
): WorkspaceExplorerSessionRef | WorkspaceFileSessionRef | MemoryFileSessionRef | null {
  return parseWorkspaceExplorerSessionId(sessionId)
    ?? parseWorkspaceFileSessionId(sessionId)
    ?? parseMemoryFileSessionId(sessionId);
}

export function getWorkspaceSpecialSessionTitle(sessionId: string, t?: Translate): string | null {
  const explorer = parseWorkspaceExplorerSessionId(sessionId);
  if (explorer) return t ? t("gitPanel.tabs.files") : "Files";

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
  if (!file) return null;
  const name = file.path.split("/").pop() || file.path;
  return file.kind === "diff" ? `${name} ${t ? t("gitPanel.tabs.diff") : "diff"}` : name;
}

export function getWorkspaceSpecialSourceSessionId(sessionId: string): string | null {
  return parseWorkspaceSpecialSessionId(sessionId)?.sourceSessionId ?? null;
}
