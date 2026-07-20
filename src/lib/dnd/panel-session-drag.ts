import {
  PANEL_NODE_DRAG_MIME,
  PANEL_SESSION_DRAG_MIME,
  SESSION_DRAG_MIME,
  WORKSPACE_FILE_DRAG_MIME,
} from '@/types/panel';
import { TASK_DND_MIME, TASK_ENTITY_DND_MIME, TASK_MULTI_DND_MIME } from '@/types/task';
import {
  buildWorkspaceFileSessionId,
  type WorkspaceFileTabKind,
} from '@/lib/workspace-tabs/special-session';

export interface PanelSessionDragPayload {
  tabId: string;
  panelId: string;
  sessionId: string;
}

export interface PanelNodeDragPayload {
  tabId: string;
  panelId: string;
}

export interface WorkspaceFileDragPayload {
  sourceSessionId: string;
  kind: WorkspaceFileTabKind | 'directory';
  path: string;
  /** Host filesystem path — used when the drop target needs an absolute path (e.g. terminal prompt). */
  absolutePath?: string;
}

export function hasWorkspaceFileDragData(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return dataTransfer.types.includes(WORKSPACE_FILE_DRAG_MIME);
}

/**
 * True for drags that only make sense as a path insertion (e.g. directories):
 * they carry the workspace-file payload but no session reference, so panel
 * split/replace must not apply.
 */
export function isPathInsertOnlyDragData(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return hasWorkspaceFileDragData(dataTransfer) &&
    !dataTransfer.types.includes(SESSION_DRAG_MIME);
}

export function isSessionReferenceDragData(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return dataTransfer.types.includes(SESSION_DRAG_MIME) &&
    !hasWorkspaceFileDragData(dataTransfer);
}

/**
 * Add panel-split compatibility to a drag payload when it maps to a concrete session.
 */
export function setPanelSessionDragData(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  dataTransfer.setData(SESSION_DRAG_MIME, sessionId);
  return true;
}

export function setPanelTitleDragData(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  payload: PanelSessionDragPayload,
): boolean {
  if (!payload.tabId || !payload.panelId || !payload.sessionId) return false;
  setPanelNodeDragData(dataTransfer, payload);
  setPanelSessionDragData(dataTransfer, payload.sessionId);
  dataTransfer.setData(PANEL_SESSION_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.effectAllowed = 'move';
  return true;
}

export function setPanelNodeDragData(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  payload: PanelNodeDragPayload,
): boolean {
  if (!payload.tabId || !payload.panelId) return false;
  dataTransfer.setData(PANEL_NODE_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.effectAllowed = 'move';
  return true;
}

export function parsePanelNodeDragData(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): PanelNodeDragPayload | null {
  try {
    const raw = dataTransfer.getData(PANEL_NODE_DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PanelNodeDragPayload>;
    if (
      typeof parsed.tabId !== 'string' ||
      typeof parsed.panelId !== 'string' ||
      parsed.tabId.length === 0 ||
      parsed.panelId.length === 0
    ) {
      return null;
    }
    return {
      tabId: parsed.tabId,
      panelId: parsed.panelId,
    };
  } catch {
    return null;
  }
}

export function parsePanelTitleDragData(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): PanelSessionDragPayload | null {
  try {
    const raw = dataTransfer.getData(PANEL_SESSION_DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PanelSessionDragPayload>;
    if (
      typeof parsed.tabId !== 'string' ||
      typeof parsed.panelId !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      parsed.tabId.length === 0 ||
      parsed.panelId.length === 0 ||
      parsed.sessionId.length === 0
    ) {
      return null;
    }
    return {
      tabId: parsed.tabId,
      panelId: parsed.panelId,
      sessionId: parsed.sessionId,
    };
  } catch {
    return null;
  }
}

export function parseWorkspaceFileDragData(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): WorkspaceFileDragPayload | null {
  try {
    const raw = dataTransfer.getData(WORKSPACE_FILE_DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkspaceFileDragPayload>;
    if (
      typeof parsed.sourceSessionId !== 'string' ||
      typeof parsed.kind !== 'string' ||
      typeof parsed.path !== 'string' ||
      parsed.sourceSessionId.length === 0 ||
      (parsed.kind !== 'file' && parsed.kind !== 'diff' && parsed.kind !== 'directory') ||
      parsed.path.length === 0
    ) {
      return null;
    }
    return {
      sourceSessionId: parsed.sourceSessionId,
      kind: parsed.kind,
      path: parsed.path,
      absolutePath: typeof parsed.absolutePath === 'string' && parsed.absolutePath.length > 0
        ? parsed.absolutePath
        : undefined,
    };
  } catch {
    return null;
  }
}

export function getWorkspaceFileDragPath(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): string | null {
  const payload = parseWorkspaceFileDragData(dataTransfer);
  if (payload) return payload.path;

  const textPath = dataTransfer.getData('text/plain');
  return textPath.length > 0 ? textPath : null;
}

/** Absolute host path when the drag source provided one; falls back to the workspace-relative path. */
export function getWorkspaceFileDragAbsolutePath(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): string | null {
  const payload = parseWorkspaceFileDragData(dataTransfer);
  if (payload) return payload.absolutePath ?? payload.path;

  const textPath = dataTransfer.getData('text/plain');
  return textPath.length > 0 ? textPath : null;
}

/**
 * Workspace file/diff views are represented as special session IDs, so they
 * can reuse the existing panel split/replace drop behavior.
 */
export function setWorkspaceFileDragData(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  sourceSessionId: string,
  kind: WorkspaceFileTabKind,
  filePath: string,
  absolutePath?: string | null,
): void {
  const specialSessionId = buildWorkspaceFileSessionId(sourceSessionId, kind, filePath);
  const workspaceFilePayload: WorkspaceFileDragPayload = {
    sourceSessionId,
    kind,
    path: filePath,
    ...(absolutePath ? { absolutePath } : {}),
  };
  setPanelSessionDragData(dataTransfer, specialSessionId);
  dataTransfer.setData(WORKSPACE_FILE_DRAG_MIME, JSON.stringify(workspaceFilePayload));
  dataTransfer.setData('text/plain', filePath);
  dataTransfer.effectAllowed = 'copyMove';
}

/**
 * Directories cannot open as file-viewer panes, so their drag carries no
 * session reference — only the path payload for prompt insertion targets
 * (terminal center drop, composer).
 */
export function setWorkspaceDirectoryDragData(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  sourceSessionId: string,
  directoryPath: string,
  absolutePath?: string | null,
): void {
  const payload: WorkspaceFileDragPayload = {
    sourceSessionId,
    kind: 'directory',
    path: directoryPath,
    ...(absolutePath ? { absolutePath } : {}),
  };
  dataTransfer.setData(WORKSPACE_FILE_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.setData('text/plain', directoryPath);
  // Must stay compatible with the drop zone's dropEffect ('move') — a
  // mismatch makes the browser cancel the drop without firing the event.
  dataTransfer.effectAllowed = 'copyMove';
}

/**
 * Kanban chat cards support both chat-column reorder and panel split.
 */
export function setKanbanChatDragData(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  sessionId: string,
) {
  setPanelSessionDragData(dataTransfer, sessionId);
  dataTransfer.setData(TASK_DND_MIME, sessionId);
  dataTransfer.effectAllowed = 'move';
}

export function getKanbanMultiSessionDragIds(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): string[] {
  try {
    const raw = dataTransfer.getData(TASK_MULTI_DND_MIME);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * Kanban task cards support both board task moves and panel split via the
 * task's primary session.
 */
export function setKanbanTaskDragData(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  taskId: string,
  primarySessionId: string | null | undefined,
) {
  dataTransfer.setData(TASK_ENTITY_DND_MIME, taskId);
  setPanelSessionDragData(dataTransfer, primarySessionId);
  dataTransfer.effectAllowed = 'move';
}
