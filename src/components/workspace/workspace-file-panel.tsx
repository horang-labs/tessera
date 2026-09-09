"use client";

import {
  AlertCircle,
  ChevronRight,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Link2,
  LoaderCircle,
  Search,
} from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import {
  useDocumentVisibility,
  useStableWorkspaceFilesSubscriberId,
  useWorkspaceFilesLiveSync,
} from "@/hooks/use-workspace-files-live-sync";
import { useWorkspaceFileList } from "@/hooks/use-workspace-file-list";
import { useProjectViewSession } from "@/hooks/use-project-view-workspace-state";
import { isHiddenWorkspaceRelativePath } from "@/lib/workspace-files/hidden-workspace-path";
import {
  selectExpandedWorkspacePaths,
  useWorkspaceFileViewStore,
} from "@/stores/workspace-file-view-store";
import { useWorkspacePeekStore } from '@/stores/workspace-peek-store';
import {
  openWorkspaceTargetFileTab,
  previewWorkspaceTargetFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
import { resolveWorkspaceTarget, workspaceTargetKey } from '@/types/worktree';
import { setWorkspaceDirectoryDragData, setWorkspaceFileDragData } from "@/lib/dnd/panel-session-drag";
import { toAbsoluteWorkspacePath } from "@/lib/workspace-tabs/file-path-actions";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import {
  WorkspaceDeleteDialog,
  type WorkspaceDeleteRequest,
} from "@/components/workspace/workspace-delete-dialog";
import { WorkspaceInlineInputRow } from "@/components/workspace/workspace-inline-input-row";
import { useWorkspaceInlineInput } from "@/components/workspace/use-workspace-inline-input";
import {
  shouldOpenOnRowClick,
  shouldToggleDirectoryOnClick,
} from "@/components/workspace/workspace-inline-input-state";
import { shouldReloadReselectedWorktree } from "@/components/workspace/workspace-file-panel-refresh";
import {
  createWorkspaceDirectoryRequest,
  createWorkspaceFileRequest,
  deleteWorkspaceEntryRequest,
  renameWorkspaceEntryRequest,
} from "@/lib/workspace-files/workspace-file-mutation-client";
import { hasUnsavedWorkspaceFileEdits } from "@/lib/workspace-files/workspace-dirty-registry";
import {
  closeWorkspaceFileTabsFor,
  isPathUnderMutation,
  repointWorkspaceFileTabs,
} from "@/lib/workspace-tabs/workspace-tab-sync";
import { cn } from "@/lib/utils";
import { telemetryClickAttributes } from "@/lib/telemetry/ui-click";
import { captureTelemetryEvent } from '@/lib/telemetry/client';
import {
  buildWorkspacePathContextMenuState,
  type WorkspacePathContextMenuState,
} from '@/lib/workspace-files/workspace-context-menu-state';

interface WorkspaceFileNode {
  type: "file";
  name: string;
  path: string;
  isSymlink: boolean;
}

interface WorkspaceDirectoryNode {
  type: "directory";
  name: string;
  path: string;
  children: WorkspaceTreeNode[];
}

type WorkspaceTreeNode = WorkspaceDirectoryNode | WorkspaceFileNode;

type PathContextMenuState = WorkspacePathContextMenuState<WorkspaceTreeNode>;

interface MutableDirectoryNode {
  name: string;
  path: string;
  directories: Map<string, MutableDirectoryNode>;
  files: WorkspaceFileNode[];
}

function createMutableDirectory(name: string, path: string): MutableDirectoryNode {
  return {
    name,
    path,
    directories: new Map(),
    files: [],
  };
}

function compareNodeNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function finalizeDirectory(node: MutableDirectoryNode): WorkspaceDirectoryNode {
  const directories = Array.from(node.directories.values())
    .map(finalizeDirectory)
    .sort((a, b) => compareNodeNames(a.name, b.name));
  const files = [...node.files].sort((a, b) => compareNodeNames(a.name, b.name));
  const children: WorkspaceTreeNode[] = [...directories, ...files];

  return {
    type: "directory",
    name: node.name,
    path: node.path,
    children,
  };
}

function ensureDirectory(root: MutableDirectoryNode, directoryPath: string): MutableDirectoryNode {
  let directory = root;
  for (const part of directoryPath.split("/").filter(Boolean)) {
    const childPath = directory.path ? `${directory.path}/${part}` : part;
    let child = directory.directories.get(part);
    if (!child) {
      child = createMutableDirectory(part, childPath);
      directory.directories.set(part, child);
    }
    directory = child;
  }
  return directory;
}

function buildFileTree(
  filePaths: string[],
  symlinkPaths: Set<string>,
  directoryPaths: string[],
): WorkspaceTreeNode[] {
  const root = createMutableDirectory("", "");

  // Folders first and in their own right: one with no files in it appears in no
  // file path, so inferring the tree from `filePaths` alone would hide exactly
  // the folder a user just created.
  for (const directoryPath of directoryPaths) {
    ensureDirectory(root, directoryPath);
  }

  for (const filePath of filePaths) {
    const parts = filePath.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;

    const directory = ensureDirectory(root, parts.join("/"));

    directory.files.push({
      type: "file",
      name: fileName,
      path: filePath,
      isSymlink: symlinkPaths.has(filePath),
    });
  }

  return finalizeDirectory(root).children;
}

function EmptyState({
  title,
  body,
  icon = "file",
}: {
  title: string;
  body: string;
  icon?: "file" | "error";
}) {
  const Icon = icon === "error" ? AlertCircle : FolderTree;
  return (
    <div className="flex h-full items-center justify-center p-5">
      <div className="max-w-[240px] text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-(--divider) bg-(--sidebar-hover)">
          <Icon className="h-5 w-5 text-(--text-muted)" />
        </div>
        <p className="text-sm font-medium text-(--text-primary)">
          {title}
        </p>
        <p className="mt-1 text-xs leading-5 text-(--text-muted)">
          {body}
        </p>
      </div>
    </div>
  );
}

export function WorkspaceFilePanel({
  sessionId,
  worktreeId = null,
}: {
  sessionId: string | null;
  worktreeId?: string | null;
}) {
  const target = useMemo(
    () => resolveWorkspaceTarget(sessionId, worktreeId),
    [sessionId, worktreeId],
  );
  const targetKey = target ? workspaceTargetKey(target) : null;
  const canMutate = target !== null;
  const isDocumentVisible = useDocumentVisibility();
  const peekTarget = useWorkspacePeekStore((state) => state.target);
  const previousPeekTargetRef = useRef(peekTarget);
  const previousFileListTargetKeyRef = useRef(targetKey);
  const subscriberId = useStableWorkspaceFilesSubscriberId("workspace-file-panel");
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<WorkspaceDeleteRequest | null>(null);
  const [contextMenu, setContextMenu] = useState<PathContextMenuState | null>(null);
  const showHiddenFiles = useWorkspaceFileViewStore((state) => state.showHiddenFiles);
  const toggleShowHiddenFiles = useWorkspaceFileViewStore((state) => state.toggleShowHiddenFiles);
  const storedExpandedPaths = useWorkspaceFileViewStore(
    selectExpandedWorkspacePaths(targetKey),
  );
  const expandStoredPath = useWorkspaceFileViewStore((state) => state.expandPath);
  const toggleStoredPath = useWorkspaceFileViewStore((state) => state.toggleExpandedPath);
  const expandedPaths = useMemo(() => new Set(storedExpandedPaths), [storedExpandedPaths]);
  // The sessions/[id]/files route scopes Project View references by projectId;
  // resolve it from canonical workspace state so linked Task-only Sessions can
  // list files too.
  const sessionProjectDir = useProjectViewSession(sessionId)?.projectDir ?? null;
  const {
    directories,
    error,
    files,
    loadedDirectories,
    loadDirectory,
    loadFiles,
    loading,
    loadingDirectories,
    refreshFiles,
    searchFiles,
    searchResult,
    symlinks,
    truncated,
    workDir,
  } = useWorkspaceFileList(
    target,
    sessionProjectDir,
  );

  // A Worktree panel has no Session watcher. Re-selecting its Peek is the
  // explicit signal that the explorer is visible again, so reload instead of
  // carrying a tree snapshot from before a file-tab mutation. Subscribe to the
  // target object, not just its ID: clicking the already-selected Worktree is
  // still a new open event and must refresh this panel.
  useEffect(function reloadReselectedWorktree() {
    const previousTargetKey = previousFileListTargetKeyRef.current;
    const peekChanged = previousPeekTargetRef.current !== peekTarget;
    previousFileListTargetKeyRef.current = targetKey;
    previousPeekTargetRef.current = peekTarget;
    if (!shouldReloadReselectedWorktree({
      currentTargetKey: targetKey,
      isWorktreeTarget: target?.kind === 'worktree',
      peekChanged,
      peekWorktreeId: peekTarget?.worktreeId ?? null,
      previousTargetKey,
      targetId: target?.id ?? null,
    })) return;
    void loadFiles({ silent: true });
  }, [loadFiles, peekTarget, target?.id, target?.kind, targetKey]);

  const expandPath = useCallback((path: string) => {
    if (!targetKey) return;
    expandStoredPath(targetKey, path);
  }, [expandStoredPath, targetKey]);

  const inlineInput = useWorkspaceInlineInput({
    onCreateFile: createFile,
    onCreateFolder: createFolder,
    onExpandParent: expandPath,
    onRefreshFiles: refreshFiles,
    onRename: renameEntry,
    workspaceKey: targetKey,
  });
  const handleExternalRefresh = inlineInput.handleExternalRefresh;
  const skipInitialLiveRefreshRef = useRef(true);
  useEffect(() => {
    skipInitialLiveRefreshRef.current = true;
  }, [targetKey]);
  const handleLiveRefresh = useCallback(() => {
    // The root listing just came from disk before the subscription was allowed
    // to start. Its subscribe-time refresh would duplicate that same shallow
    // request; later reconnects and actual tree changes still refresh normally.
    if (skipInitialLiveRefreshRef.current) {
      skipInitialLiveRefreshRef.current = false;
      return;
    }
    handleExternalRefresh();
  }, [handleExternalRefresh]);

  useWorkspaceFilesLiveSync({
    // Let the shallow root request win the first paint before starting the
    // recursive background watch index on bridged Windows/WSL workspaces.
    enabled: Boolean(sessionId) && isDocumentVisible && !loading,
    // Gated, not passed straight through: a reconcile landing while a name is
    // being typed would take the row it is being typed into.
    onRefresh: handleLiveRefresh,
    sessionId,
    subscriberId,
  });

  const isSearching = query.trim().length > 0;
  useEffect(function loadGlobalSearchResults() {
    const trimmed = query.trim();
    const abortController = new AbortController();
    if (!trimmed) {
      void searchFiles("", { signal: abortController.signal });
      return () => abortController.abort();
    }
    const timer = window.setTimeout(() => {
      void searchFiles(trimmed, { signal: abortController.signal });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      abortController.abort();
    };
  }, [query, searchFiles]);

  const loadedDirectorySet = useMemo(() => new Set(loadedDirectories), [loadedDirectories]);
  const loadingDirectorySet = useMemo(() => new Set(loadingDirectories), [loadingDirectories]);

  // Expansion state is persisted. Restore it one level at a time after the
  // root is visible, never by turning tab entry back into a recursive scan.
  useEffect(function restoreExpandedDirectories() {
    if (loading || isSearching) return;
    const knownDirectories = new Set(directories);
    for (const path of [...storedExpandedPaths].sort((left, right) =>
      left.split("/").length - right.split("/").length)) {
      const parent = path.split("/").slice(0, -1).join("/");
      if (
        knownDirectories.has(path)
        && loadedDirectorySet.has(parent)
        && !loadedDirectorySet.has(path)
        && !loadingDirectorySet.has(path)
      ) {
        void loadDirectory(path, { silent: true });
      }
    }
  }, [
    directories,
    isSearching,
    loadDirectory,
    loadedDirectorySet,
    loading,
    loadingDirectorySet,
    storedExpandedPaths,
  ]);

  const listedFiles = isSearching ? searchResult.files : files;
  const listedDirectories = isSearching ? searchResult.directories : directories;
  const listedSymlinks = isSearching ? searchResult.symlinks : symlinks;
  const listedTruncated = isSearching ? searchResult.truncated : truncated;

  const baseFiles = useMemo(
    () => (showHiddenFiles
      ? listedFiles
      : listedFiles.filter((filePath) => !isHiddenWorkspaceRelativePath(filePath))),
    [listedFiles, showHiddenFiles],
  );
  const visibleFiles = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return baseFiles;
    return baseFiles
      .filter((filePath) => filePath.toLowerCase().includes(trimmed));
  }, [baseFiles, query]);
  const baseDirectories = useMemo(
    () => (showHiddenFiles
      ? listedDirectories
      : listedDirectories.filter((dirPath) => !isHiddenWorkspaceRelativePath(dirPath))),
    [listedDirectories, showHiddenFiles],
  );
  const visibleDirectories = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return baseDirectories;
    // A folder stays visible while its own name matches, or while a matching
    // file needs it as an ancestor — the file rows are nested under it. The
    // ancestors are collected from the matching files once; testing each
    // folder against every file would be the product of the two, on every
    // keystroke, over a tree that can hold twenty thousand entries.
    const ancestors = new Set<string>();
    for (const filePath of visibleFiles) {
      const parts = filePath.split("/");
      let walked = "";
      for (const part of parts.slice(0, -1)) {
        walked = walked ? `${walked}/${part}` : part;
        ancestors.add(walked);
      }
    }
    return baseDirectories.filter((dirPath) =>
      dirPath.toLowerCase().includes(trimmed) || ancestors.has(dirPath));
  }, [baseDirectories, query, visibleFiles]);
  const symlinkPaths = useMemo(() => new Set(listedSymlinks), [listedSymlinks]);
  const fileTree = useMemo(
    () => buildFileTree(visibleFiles, symlinkPaths, visibleDirectories),
    [symlinkPaths, visibleDirectories, visibleFiles],
  );

  // Expand the ancestors, or an entry created inside a collapsed folder appears
  // to have done nothing.
  function expandParentOf(path: string) {
    expandPath(path.split("/").slice(0, -1).join("/"));
  }

  async function createFolder(path: string) {
    if (!target) return;
    try {
      const created = await createWorkspaceDirectoryRequest(target, path);
      expandParentOf(created.path);
      await loadDirectory(created.path.split("/").slice(0, -1).join("/"), {
        silent: true,
        mutation: { kind: "directory", path: created.path, type: "create" },
      });
      void captureTelemetryEvent('workspace_file_action_result', {
        file_action: 'create',
        entry_kind: 'directory',
        result: 'success',
      });
    } catch (error) {
      void captureTelemetryEvent('workspace_file_action_result', {
        file_action: 'create',
        entry_kind: 'directory',
        result: 'failed',
      });
      throw error;
    }
  }

  async function createFile(path: string) {
    if (!target) return;
    try {
      const created = await createWorkspaceFileRequest(target, path);
      expandParentOf(created.path);
      // Creation immediately navigates away to the new file tab. Finish the
      // list reload first so a Worktree panel without a Session watcher does not
      // show a stale tree when the user comes back.
      await loadDirectory(created.path.split("/").slice(0, -1).join("/"), {
        silent: true,
        mutation: { kind: "file", path: created.path, type: "create" },
      });
      setSelectedPath(created.path);
      openWorkspaceTargetFileTab(target, "file", created.path, {
        projectDir: sessionProjectDir,
      });
      void captureTelemetryEvent('workspace_file_action_result', {
        file_action: 'create',
        entry_kind: 'file',
        result: 'success',
      });
    } catch (error) {
      void captureTelemetryEvent('workspace_file_action_result', {
        file_action: 'create',
        entry_kind: 'file',
        result: 'failed',
      });
      throw error;
    }
  }

  async function renameEntry(path: string, newName: string) {
    if (!target) return;
    const kind = directories.includes(path) ? "directory" : "file";
    try {
      const renamed = await renameWorkspaceEntryRequest(target, path, newName);
      repointWorkspaceFileTabs(target, renamed.previousPath, renamed.path);
      if (selectedPath && isPathUnderMutation(selectedPath, renamed.previousPath)) {
        setSelectedPath(renamed.path + selectedPath.slice(renamed.previousPath.length));
      }
      await loadDirectory(renamed.previousPath.split("/").slice(0, -1).join("/"), {
        silent: true,
        mutation: {
          kind,
          path: renamed.path,
          previousPath: renamed.previousPath,
          type: "rename",
        },
      });
      void captureTelemetryEvent('workspace_file_action_result', {
        file_action: 'rename',
        entry_kind: kind,
        result: 'success',
      });
    } catch (error) {
      void captureTelemetryEvent('workspace_file_action_result', {
        file_action: 'rename',
        entry_kind: kind,
        result: 'failed',
      });
      throw error;
    }
  }

  async function deleteEntry(request: WorkspaceDeleteRequest) {
    if (!target) return;
    try {
      await deleteWorkspaceEntryRequest(target, request.path, {
        recursive: request.kind === "directory",
      });
      // The tab has to go with the file: leaving it open shows an editable buffer
      // for a path that no longer exists.
      closeWorkspaceFileTabsFor(target, request.path);
      if (selectedPath && isPathUnderMutation(selectedPath, request.path)) {
        setSelectedPath(null);
      }
      await loadDirectory(request.path.split("/").slice(0, -1).join("/"), {
        silent: true,
        mutation: { kind: request.kind, path: request.path, type: "delete" },
      });
      void captureTelemetryEvent('workspace_file_action_result', {
        file_action: 'delete',
        entry_kind: request.kind,
        result: 'success',
      });
    } catch (error) {
      void captureTelemetryEvent('workspace_file_action_result', {
        file_action: 'delete',
        entry_kind: request.kind,
        result: 'failed',
      });
      throw error;
    }
  }

  function toggleDirectory(path: string) {
    if (!targetKey) return;
    if (
      !isSearching
      && !expandedPaths.has(path)
      && !loadedDirectorySet.has(path)
      && !loadingDirectorySet.has(path)
    ) {
      void loadDirectory(path);
    }
    toggleStoredPath(targetKey, path);
  }

  /**
   * Toggle on the first click with no double-click delay. Chromium marks the
   * second click with detail > 1, so it is dropped instead of toggling back.
  */
  function handleDirectoryClick(event: MouseEvent, path: string) {
    if (!shouldToggleDirectoryOnClick(event.detail)) return;
    toggleDirectory(path);
  }

  /** Named apart from the hook's `startRename` to keep row event handling local. */
  function beginRename(node: WorkspaceTreeNode) {
    if (!canMutate) return;
    inlineInput.startRename({
      isDirectory: node.type === "directory",
      name: node.name,
      path: node.path,
    });
  }

  /**
   * Every action a row offers lives here. Hanging four icons off each row on
   * hover is what a toolbar does, not what a file explorer does — the tree is
   * the name, and the actions are one right-click away.
   */
  function openRowContextMenu(
    event: MouseEvent,
    node: WorkspaceTreeNode,
    absolutePath: string | null,
  ) {
    const nextContextMenu = buildWorkspacePathContextMenuState({
      absolutePath,
      canOpenFile: true,
      node,
      x: event.clientX,
      y: event.clientY,
    });
    if (!nextContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(nextContextMenu);
  }

  /** Right-click past the last row: the actions that need no row. */
  function openBackgroundContextMenu(event: MouseEvent) {
    const rootPath = toAbsoluteWorkspacePath(workDir, "");
    const nextContextMenu = buildWorkspacePathContextMenuState<WorkspaceTreeNode>({
      absolutePath: rootPath,
      canOpenFile: false,
      node: null,
      x: event.clientX,
      y: event.clientY,
    });
    if (!nextContextMenu) return;
    event.preventDefault();
    setContextMenu(nextContextMenu);
  }

  /** A folder takes its contents with it; a file may take an unsaved draft. */
  function deleteRequestFor(node: WorkspaceTreeNode): WorkspaceDeleteRequest {
    if (node.type === "directory") return { kind: "directory", path: node.path };
    return {
      kind: "file",
      path: node.path,
      dirty: hasUnsavedWorkspaceFileEdits(targetKey, node.path),
    };
  }

  /** A new entry goes inside a folder, or beside the file that was clicked. */
  function newEntryParentFor(node: WorkspaceTreeNode | null): string {
    if (!node) return "";
    if (node.type === "directory") return node.path;
    return node.path.split("/").slice(0, -1).join("/");
  }

  function beginNewEntry(kind: "file" | "folder", parentPath: string) {
    if (!canMutate) return;
    inlineInput.startNew(kind, parentPath);
  }

  function renderInlineInputRow(depth: number) {
    const input = inlineInput.input;
    if (!input) return null;
    // Re-pointing a tab remounts it on the new path, so the draft goes with the
    // old one. The delete confirmation says so; the rename has to as well.
    const hint = input.kind === "rename"
      && hasUnsavedWorkspaceFileEdits(targetKey, input.path)
      ? "This file has unsaved edits, and they are discarded by the rename."
      : null;
    return (
      <WorkspaceInlineInputRow
        error={inlineInput.error}
        hint={hint}
        indent={8 + depth * 12}
        input={input}
        onCancel={inlineInput.cancel}
        onSubmit={inlineInput.submit}
        submitting={inlineInput.submitting}
      />
    );
  }

  function renderTreeNode(node: WorkspaceTreeNode, depth: number): ReactNode {
    const paddingLeft = 8 + depth * 12;

    if (node.type === "directory") {
      const expanded = isSearching || expandedPaths.has(node.path);
      const directoryLoading = loadingDirectorySet.has(node.path);
      const FolderIcon = expanded ? FolderOpen : Folder;
      const absolutePath = toAbsoluteWorkspacePath(workDir, node.path);
      const children = (
        <>
          {inlineInput.newEntryParent === node.path ? renderInlineInputRow(depth + 1) : null}
          {node.children.map((child) => renderTreeNode(child, depth + 1))}
        </>
      );

      // Renaming replaces the row itself rather than putting an input inside the
      // disclosure button — a control nested in a control is invalid HTML and
      // unreachable to a screen reader. The subtree stays where it was.
      if (inlineInput.isRenaming(node.path)) {
        return (
          <div key={`dir:${node.path}`} className="flex flex-col">
            {renderInlineInputRow(depth)}
            {expanded ? children : null}
          </div>
        );
      }

      return (
        <div key={`dir:${node.path}`} className="flex flex-col">
          <div className="group flex min-w-0 items-center transition-colors hover:bg-(--sidebar-hover)">
          <button
            type="button"
            {...telemetryClickAttributes("files.directory.toggle", "files_panel")}
            onClick={(event) => handleDirectoryClick(event, node.path)}
            onKeyDown={(event) => {
              if (!canMutate || event.key !== "F2") return;
              event.preventDefault();
              beginRename(node);
            }}
            onContextMenu={(event) => openRowContextMenu(event, node, absolutePath)}
            onDragStart={(event) => {
              if (!sessionId) return;
              setWorkspaceDirectoryDragData(event.dataTransfer, sessionId, node.path, absolutePath);
            }}
            draggable={Boolean(sessionId)}
            className="flex min-w-0 flex-1 items-center gap-1.5 border-l-2 border-l-transparent py-1.5 pr-2 text-left text-(--text-secondary) transition-colors group-hover:text-(--text-primary)"
            style={{ paddingLeft }}
            title={node.path}
            aria-expanded={expanded}
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-(--text-muted) transition-transform",
                expanded && "rotate-90",
              )}
            />
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-(--text-muted) group-hover:text-(--text-primary)" />
            <span
              // The double-click-to-rename target is the name text alone.
              onDoubleClick={(event) => {
                if (!canMutate) return;
                event.stopPropagation();
                beginRename(node);
              }}
              className="min-w-0 flex-1 truncate font-mono text-[11px]"
            >
              {node.name}
            </span>
            {directoryLoading ? (
              <LoaderCircle className="h-3 w-3 shrink-0 animate-spin text-(--text-muted)" />
            ) : null}
          </button>
          </div>
          {expanded ? children : null}
        </div>
      );
    }

    const isSelected = node.path === selectedPath;
    const absolutePath = toAbsoluteWorkspacePath(workDir, node.path);

    if (inlineInput.isRenaming(node.path)) {
      return <div key={`file:${node.path}`}>{renderInlineInputRow(depth)}</div>;
    }

    return (
      <div
        key={`file:${node.path}`}
        className={cn(
          "group relative border-l-2 transition-colors",
          isSelected
            ? "border-l-(--accent) bg-(--accent)/10 text-(--text-primary)"
            : "border-l-transparent text-(--text-secondary) hover:bg-(--sidebar-hover) hover:text-(--text-primary)",
        )}
        style={{ paddingLeft: paddingLeft + 19 }}
        onContextMenu={(event) => {
          setSelectedPath(node.path);
          openRowContextMenu(event, node, absolutePath);
        }}
      >
        <button
          type="button"
          {...telemetryClickAttributes("files.file.open", "files_panel")}
          onClick={(event) => {
            setSelectedPath(node.path);
            if (!target) return;
            // A browser double-click also dispatches two click events. The
            // first click opens the replaceable file-preview tab; its paired
            // double-click below promotes that preview to a retained tab.
            if (!shouldOpenOnRowClick(event.detail)) return;
            previewWorkspaceTargetFileTab(target, 'file', node.path, {
              preferKanbanPeek: true,
              projectDir: sessionProjectDir,
            });
          }}
          onDoubleClick={() => {
            if (!target) return;
            openWorkspaceTargetFileTab(target, 'file', node.path, {
              preferKanbanPeek: true,
              projectDir: sessionProjectDir,
            });
          }}
          onKeyDown={(event) => {
            // F2, not Enter: Enter already activates the row, and taking that
            // to mean rename would stop the keyboard opening a file at all.
            if (!canMutate || event.key !== "F2") return;
            event.preventDefault();
            beginRename(node);
          }}
          onDragStart={(event) => {
            if (!sessionId) return;
            setSelectedPath(node.path);
            setWorkspaceFileDragData(event.dataTransfer, sessionId, "file", node.path, absolutePath);
          }}
          draggable={Boolean(sessionId)}
          className="flex w-full min-w-0 items-center gap-2 border-l-transparent py-1.5 pr-8 text-left transition-colors"
          title={node.isSymlink ? `${node.path} (symbolic link)` : node.path}
          data-testid={`workspace-file-row-${node.path}`}
          data-symlink={node.isSymlink ? "true" : undefined}
        >
          {node.isSymlink ? (
            <Link2
              className="h-3.5 w-3.5 shrink-0 text-(--text-muted) group-hover:text-(--text-primary)"
              aria-label="Symbolic link"
            />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0 text-(--text-muted) group-hover:text-(--text-primary)" />
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {node.name}
          </span>
        </button>
      </div>
    );
  }

  if (!sessionId && !worktreeId) {
    return (
      <EmptyState
        title="No worktree selected"
        body="Select a session with a workspace to browse files."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-(--chat-header-border) px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <FolderTree className="h-4 w-4 shrink-0 text-(--text-muted)" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-(--text-primary)">
                Files
              </p>
              <p className="truncate text-[11px] text-(--text-muted)">
                {isSearching
                  ? `${visibleFiles.length.toLocaleString()} matches`
                  : `${baseFiles.length.toLocaleString()} files loaded`}
                {listedTruncated ? " · truncated" : ""}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
          {/* Two buttons for the whole panel, always in the same place. What was
              removed is the strip that followed the pointer down the tree — a
              row's own actions are on its right-click menu. */}
          <Tooltip content={canMutate ? "New file" : "Select a workspace to edit files"}>
            <button
              type="button"
              {...telemetryClickAttributes("files.new_file", "files_panel")}
              onClick={() => beginNewEntry("file", "")}
              disabled={!canMutate}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-(--input-border) text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="New file"
              data-testid="workspace-new-file"
            >
              <FilePlus2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content={canMutate ? "New folder" : "Select a workspace to edit files"}>
            <button
              type="button"
              {...telemetryClickAttributes("files.new_folder", "files_panel")}
              onClick={() => beginNewEntry("folder", "")}
              disabled={!canMutate}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-(--input-border) text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="New folder"
              data-testid="workspace-new-folder"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content={showHiddenFiles ? "Hide hidden files" : "Show hidden files"}>
            <button
              type="button"
              {...telemetryClickAttributes("files.hidden.toggle", "files_panel")}
              onClick={toggleShowHiddenFiles}
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors",
                showHiddenFiles
                  ? "border-(--accent) bg-(--accent)/10 text-(--text-primary)"
                  : "border-(--input-border) text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--text-primary)",
              )}
              aria-label={showHiddenFiles ? "Hide hidden files" : "Show hidden files"}
              aria-pressed={showHiddenFiles}
            >
              {showHiddenFiles ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </button>
          </Tooltip>
          </div>
        </div>
        <label className="mt-3 flex h-8 items-center gap-2 rounded-md border border-(--input-border) bg-(--chat-bg) px-2.5 focus-within:border-(--accent)">
          <Search className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
          <input
            {...telemetryClickAttributes('files.search', 'files_panel')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files"
            className="min-w-0 flex-1 bg-transparent text-xs text-(--text-primary) outline-none placeholder:text-(--text-muted)"
          />
        </label>
      </div>

      {loading ? (
        <div className="flex h-full items-center justify-center">
          <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
        </div>
      ) : isSearching && searchResult.loading ? (
        <div className="flex h-full items-center justify-center">
          <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
        </div>
      ) : isSearching && searchResult.error ? (
        <EmptyState title="Search unavailable" body={searchResult.error} icon="error" />
      ) : error ? (
        <EmptyState title="Files unavailable" body={error} icon="error" />
      ) : fileTree.length === 0 && !inlineInput.input ? (
        // The empty state is a right-click target too: an empty workspace is
        // exactly where "New file" is wanted most.
        <div className="min-h-0 flex-1" onContextMenu={openBackgroundContextMenu}>
          <EmptyState
            title={query.trim() ? "No matches" : "No files"}
            body={query.trim()
              ? "Try another search."
              : canMutate
                ? "This workspace has no readable files. Right-click to add one."
                : "This workspace has no readable files."}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] uppercase tracking-[0.18em] text-(--text-muted)">
              Workspace files
            </span>
            <span className="font-mono text-[11px] text-(--text-muted) tabular-nums">
              {visibleFiles.length.toLocaleString()}
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {/* The rows stop their own context menu, so this one only ever
                fires on the empty space past the last row. */}
            <div
              className="flex min-h-full flex-col"
              onContextMenu={openBackgroundContextMenu}
              data-testid="workspace-file-tree"
            >
              {inlineInput.newEntryParent === "" ? renderInlineInputRow(0) : null}
              {fileTree.map((node) => renderTreeNode(node, 0))}
            </div>
          </ScrollArea>
        </div>
      )}
      {contextMenu ? (
        <WorkspaceFileContextMenu
          absolutePath={contextMenu.absolutePath}
          canOpenFile={contextMenu.canOpenFile}
          entryActions={canMutate ? {
            onDelete: contextMenu.node
              ? () => setDeleteRequest(deleteRequestFor(contextMenu.node!))
              : undefined,
            onNewFile: () => beginNewEntry("file", newEntryParentFor(contextMenu.node)),
            onNewFolder: () => beginNewEntry("folder", newEntryParentFor(contextMenu.node)),
            onRename: contextMenu.node
              ? () => beginRename(contextMenu.node!)
              : undefined,
          } : undefined}
          onClose={() => setContextMenu(null)}
          position={contextMenu.position}
        />
      ) : null}
      <WorkspaceDeleteDialog
        onConfirm={deleteEntry}
        onOpenChange={(next) => {
          if (!next) setDeleteRequest(null);
        }}
        request={deleteRequest}
      />
    </div>
  );
}
