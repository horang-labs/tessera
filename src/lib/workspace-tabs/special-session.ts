export const WORKSPACE_EXPLORER_SESSION_PREFIX = "__workspace-explorer__|" as const;
export const WORKSPACE_FILE_SESSION_PREFIX = "__workspace-file__|" as const;

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

export function parseWorkspaceSpecialSessionId(
  sessionId: string,
): WorkspaceExplorerSessionRef | WorkspaceFileSessionRef | null {
  return parseWorkspaceExplorerSessionId(sessionId) ?? parseWorkspaceFileSessionId(sessionId);
}

export function getWorkspaceSpecialSessionTitle(sessionId: string): string | null {
  const explorer = parseWorkspaceExplorerSessionId(sessionId);
  if (explorer) return "Files";

  const file = parseWorkspaceFileSessionId(sessionId);
  if (!file) return null;
  const name = file.path.split("/").pop() || file.path;
  return file.kind === "diff" ? `${name} diff` : name;
}

export function getWorkspaceSpecialSourceSessionId(sessionId: string): string | null {
  return parseWorkspaceSpecialSessionId(sessionId)?.sourceSessionId ?? null;
}
