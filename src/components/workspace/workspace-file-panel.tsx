"use client";

import {
  AlertCircle,
  Eye,
  EyeOff,
  FilePlus2,
  Files,
  Trash2,
  FolderPlus,
  FolderTree,
  Link2,
  LoaderCircle,
  RefreshCw,
  Search,
  ArrowDownAZ,
  ArrowUpZA,
  FileType,
  Clock,
} from "lucide-react";
import {
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { GitPanelData } from "@/types/git";
import type { WorkspaceFileRef } from "@/lib/workspace-tabs/special-session";
import { resolveRevealedWorkspacePath } from "@/lib/workspace-files/workspace-file-reveal";
import { useWorkspaceFileReveal } from "@/hooks/use-workspace-file-reveal";
import { buildWorkspaceGitDecorations } from "@/lib/workspace-files/workspace-git-decorations";
import { WorkspaceGitBadge } from "./workspace-git-badge";
import { useWorkspaceTreeSelection } from "./use-workspace-tree-selection";
import { visibleWorkspaceTreeNodes, workspaceSelectionRoots } from "@/lib/workspace-files/workspace-tree-selection";
import { WorkspaceTreeExpansionControls } from "./workspace-tree-expansion-controls";
import { buildWorkspaceFileTree, type WorkspaceTreeNode } from "@/lib/workspace-files/workspace-file-tree";
import {
  WorkspaceFileIcon, WorkspaceFileName, WorkspaceTreeBranchGuide,
  WorkspaceTreeDirectoryButton, WorkspaceTreeFileButton, workspaceTreeFileRowClassName,
} from "./workspace-tree-row";
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
import { restoreWorkspaceFileScroll } from "@/lib/workspace-files/workspace-file-scroll";
import {
  selectExpandedWorkspacePaths,
  useWorkspaceFileViewStore,
} from "@/stores/workspace-file-view-store";
import { useWorkspacePeekStore } from '@/stores/workspace-peek-store';
import {
  openWorkspaceTargetFileTab,
  previewWorkspaceTargetFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
import { v4 as uuidv4 } from "uuid";
import { usePanelStore } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import { resolveWorkspaceTarget, workspaceTargetApiPath, workspaceTargetKey } from '@/types/worktree';
import {
  setWorkspaceDirectoryDragData,
  setWorkspaceTargetFileDragData,
} from "@/lib/dnd/panel-session-drag";
import { copyText, toAbsoluteWorkspacePath } from "@/lib/workspace-tabs/file-path-actions";
import { findWorkspaceTypeAheadMatch, resolveWorkspaceTreeKey } from "@/lib/workspace-files/workspace-tree-keyboard";
import { hasExternalFileDrag, readDroppedFiles, resolveWorkspaceDrop } from "@/lib/workspace-files/workspace-tree-drop";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import {
  WorkspaceDeleteDialog,
  type WorkspaceDeleteRequest,
} from "@/components/workspace/workspace-delete-dialog";
import { WorkspaceInlineInputRow } from "@/components/workspace/workspace-inline-input-row";
import { useWorkspaceInlineInput } from "@/components/workspace/use-workspace-inline-input";
import {
  isRapidDirectoryRenameDoubleClick,
  clickPointerType,
  shouldOpenOnRowClick,
  shouldToggleDirectoryOnClick,
} from "@/components/workspace/workspace-inline-input-state";
import { shouldReloadReselectedWorktree } from "@/components/workspace/workspace-file-panel-refresh";
import {
  createWorkspaceDirectoryRequest,
  createWorkspaceFileRequest,
  fetchWorkspaceTrashLabel,
  transferWorkspaceEntriesRequest,
  uploadWorkspaceFilesRequest,
  deleteWorkspaceEntryRequest,
  renameWorkspaceEntryRequest,
} from "@/lib/workspace-files/workspace-file-mutation-client";
import { hasUnsavedWorkspaceFileEdits, hasUnsavedWorkspaceFileEditsUnder } from "@/lib/workspace-files/workspace-dirty-registry";
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

type PathContextMenuState = WorkspacePathContextMenuState<WorkspaceTreeNode>;

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
  activeFileRef = null,
  gitData = null,
}: {
  sessionId: string | null;
  worktreeId?: string | null;
  activeFileRef?: WorkspaceFileRef | null;
  gitData?: GitPanelData | null;
}) {
  const target = useMemo(
    () => resolveWorkspaceTarget(sessionId, worktreeId),
    [sessionId, worktreeId],
  );
  const targetKey = useMemo(() => target ? workspaceTargetKey(target) : null, [target]);
  const canMutate = target !== null;
  const isDocumentVisible = useDocumentVisibility();
  const peekTarget = useWorkspacePeekStore((state) => state.target);
  const previousPeekTargetRef = useRef(peekTarget);
  const previousFileListTargetKeyRef = useRef(targetKey);
  const directoryRenameDoubleClickRef = useRef<{
    path: string;
    qualified: boolean;
    timestamp: number;
  } | null>(null);
  const subscriberId = useStableWorkspaceFilesSubscriberId("workspace-file-panel");
  const [query, setQuery] = useState("");
  const [deleteRequests, setDeleteRequests] = useState<WorkspaceDeleteRequest[] | null>(null);
  const [contextMenu, setContextMenu] = useState<PathContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<{
    mode: "copy" | "cut";
    paths: string[];
    targetKey: string | null;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [transferStatus, setTransferStatus] = useState<{ busy: string | null; error: string | null }>({
    busy: null,
    error: null,
  });
  // What this workspace's OS calls its trash; null where there is none (WSL), and then
  // delete is permanent and the dialog says so.
  const [trashSupport, setTrashSupport] = useState<{ key: string | null; label: string | null }>({
    key: null,
    label: null,
  });
  const trashLabel = trashSupport.key === targetKey ? trashSupport.label : null;
  const [mtimes, setMtimes] = useState<Record<string, number>>({});
  const internalDragRef = useRef<string[] | null>(null);
  const dragExpandRef = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const typeAheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: "",
    timer: null,
  });
  const treeContainerRef = useRef<HTMLDivElement | null>(null);
  const sortMode = useWorkspaceFileViewStore((state) => state.sortMode);
  const setSortMode = useWorkspaceFileViewStore((state) => state.setSortMode);
  const showHiddenFiles = useWorkspaceFileViewStore((state) => state.showHiddenFiles);
  const toggleShowHiddenFiles = useWorkspaceFileViewStore((state) => state.toggleShowHiddenFiles);
  const storedExpandedPaths = useWorkspaceFileViewStore(
    selectExpandedWorkspacePaths(targetKey),
  );
  const expandStoredPath = useWorkspaceFileViewStore((state) => state.expandPath);
  const toggleStoredPath = useWorkspaceFileViewStore((state) => state.toggleExpandedPath);
  const setExpandedPaths = useWorkspaceFileViewStore((state) => state.setExpandedPaths);
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
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollRestoreController = useRef<AbortController | null>(null);
  const stopScrollRestore = useCallback(() => scrollRestoreController.current?.abort(), []);
  const scrollRef = useCallback((viewport: HTMLDivElement | null) => {
    viewportRef.current = viewport;
    if (!viewport || !targetKey || isSearching) return;
    const controller = new AbortController();
    scrollRestoreController.current = controller;
    const store = useWorkspaceFileViewStore.getState();
    const cleanup = restoreWorkspaceFileScroll(
      viewport,
      store.scrollTopByWorkspace[targetKey] ?? 0,
      (scrollTop) => store.setScrollTop(targetKey, scrollTop),
      controller.signal,
    );
    return () => {
      cleanup();
      if (viewportRef.current === viewport) viewportRef.current = null;
      if (scrollRestoreController.current === controller) scrollRestoreController.current = null;
    };
  }, [targetKey, isSearching]);
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
    () => buildWorkspaceFileTree(visibleFiles, symlinkPaths, visibleDirectories, sortMode, mtimes),
    [mtimes, sortMode, symlinkPaths, visibleDirectories, visibleFiles],
  );

  useEffect(function loadModifiedTimes() {
    if (sortMode !== "modified" || !target) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Only folders already loaded: that is every folder the tree can show.
      const directoriesToRead = ["", ...loadedDirectories.filter(Boolean)];
      void Promise.all(directoriesToRead.map(async (directory) => {
        try {
          const response = await fetch(
            `${workspaceTargetApiPath(target)}/mtimes?directory=${encodeURIComponent(directory)}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (!response.ok) return {};
          return ((await response.json()) as { mtimes?: Record<string, number> }).mtimes ?? {};
        } catch {
          return {};
        }
      })).then((results) => {
        if (controller.signal.aborted) return;
        setMtimes((previous) => Object.assign({}, previous, ...results));
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [directories, files, loadedDirectories, sortMode, target]);

  useEffect(function loadTrashSupport() {
    if (!target || !targetKey) return;
    let cancelled = false;
    void fetchWorkspaceTrashLabel(target).then((label) => {
      if (!cancelled) setTrashSupport({ key: targetKey, label });
    });
    return () => { cancelled = true; };
  }, [target, targetKey]);

  const visibleNodes = useMemo(() => visibleWorkspaceTreeNodes(fileTree, expandedPaths, isSearching), [fileTree, expandedPaths, isSearching]);
  const visiblePaths = useMemo(() => visibleNodes.map((node) => node.path), [visibleNodes]);
  const treeSelection = useWorkspaceTreeSelection(targetKey, visiblePaths);
  const { selectPath: setSelectedPath } = treeSelection;
  const selectedPath = treeSelection.selection.primary;
  const selectedNodes = visibleNodes.filter((node) => treeSelection.selection.paths.has(node.path));
  const selectedFiles = selectedNodes.filter((node) => node.type === "file");
  const { cancelReveal } = useWorkspaceFileReveal({
    workspaceKey: targetKey,
    activePath: resolveRevealedWorkspacePath(target, activeFileRef),
    visibleFiles, expandedPaths, loading, searching: isSearching, showHiddenFiles,
    editing: Boolean(inlineInput.input), expandParent: expandPath,
    selectPath: setSelectedPath, viewportRef, stopScrollRestore,
  });
  const gitDecorations = useMemo(() => gitData && workDir
    ? buildWorkspaceGitDecorations({
      changedFiles: gitData.changedFiles, repoRoot: gitData.repoRoot,
      workspaceRoot: workDir, truncated: gitData.changedFilesTruncated,
    }) : null, [gitData, workDir]);


  function openSelectedFiles() {
    cancelReveal();
    if (!target) return;
    for (const node of selectedFiles) {
      openWorkspaceTargetFileTab(target, "file", node.path, { projectDir: sessionProjectDir });
    }
  }

  function requestSelectedDelete() {
    cancelReveal();
    const requests = workspaceSelectionRoots(selectedNodes.map(deleteRequestFor));
    if (requests.length) setDeleteRequests(requests);
  }

  function collapseAllFolders() {
    cancelReveal();
    if (targetKey) setExpandedPaths(targetKey, []);
  }

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

  async function deleteEntry(request: WorkspaceDeleteRequest, options: { permanent: boolean }) {
    if (!target) return;
    try {
      await deleteWorkspaceEntryRequest(target, request.path, {
        recursive: request.kind === "directory",
        trash: !options.permanent,
      });

      // The tab has to go with the file: leaving it open shows an editable buffer
      // for a path that no longer exists.
      closeWorkspaceFileTabsFor(target, request.path);
      treeSelection.removePath(request.path);
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

  // ---- Move / copy / paste / upload -------------------------------------

  function parentOf(path: string): string {
    return path.split("/").slice(0, -1).join("/");
  }

  /** The selection a clipboard or drag action works on, with nested entries folded into their folder. */
  function selectedRootPaths(): string[] {
    const roots = workspaceSelectionRoots(
      selectedNodes.map((node) => ({ path: node.path, kind: node.type })),
    ).map((entry) => entry.path);
    if (roots.length) return roots;
    return selectedPath ? [selectedPath] : [];
  }

  /** A paste lands inside a folder, or beside the file that is selected. */
  function pasteDestinationFor(node: WorkspaceTreeNode | null): string {
    return newEntryParentFor(node);
  }

  /** Rows waiting to be moved by a paste are dimmed, the way a file explorer shows a cut. */
  function isCutPath(path: string): boolean {
    return clipboard?.mode === "cut" && clipboard.targetKey === targetKey && clipboard.paths.includes(path);
  }

  function canPasteHere(): boolean {
    return Boolean(canMutate && clipboard && clipboard.targetKey === targetKey && clipboard.paths.length);
  }

  async function runTransfer(
    operation: "move" | "copy",
    sources: string[],
    destination: string,
  ): Promise<boolean> {
    if (!target || sources.length === 0) return false;
    cancelReveal();
    setTransferStatus({ busy: operation === "move" ? "Moving…" : "Copying…", error: null });
    try {
      const result = await transferWorkspaceEntriesRequest(target, operation, sources, destination);
      if (operation === "move") {
        for (const entry of result.entries) {
          if (entry.from !== entry.to) repointWorkspaceFileTabs(target, entry.from, entry.to);
        }
      }
      if (destination) expandPath(destination);
      const last = result.entries.at(-1);
      if (last) setSelectedPath(last.to);
      refreshFiles();
      setTransferStatus({ busy: null, error: null });
      void captureTelemetryEvent("workspace_file_action_result", {
        file_action: operation,
        entry_kind: last?.kind ?? "file",
        result: "success",
      });
      return true;
    } catch (error) {
      setTransferStatus({ busy: null, error: error instanceof Error ? error.message : "The operation failed." });
      void captureTelemetryEvent("workspace_file_action_result", {
        file_action: operation,
        entry_kind: "file",
        result: "failed",
      });
      return false;
    }
  }

  function copySelectionToClipboard(mode: "copy" | "cut") {
    if (!canMutate) return;
    const paths = selectedRootPaths();
    if (paths.length) setClipboard({ mode, paths, targetKey });
  }

  async function pasteClipboard(destination: string) {
    if (!clipboard || !canPasteHere()) return;
    const { mode, paths } = clipboard;
    const ok = await runTransfer(mode === "cut" ? "move" : "copy", paths, destination);
    if (ok && mode === "cut") setClipboard(null);
  }

  async function duplicateSelection() {
    // One request per parent folder: a copy lands in a single destination.
    const byParent = new Map<string, string[]>();
    for (const path of selectedRootPaths()) {
      const parent = parentOf(path);
      byParent.set(parent, [...(byParent.get(parent) ?? []), path]);
    }
    for (const [parent, paths] of byParent) {
      if (!(await runTransfer("copy", paths, parent))) return;
    }
  }

  async function uploadDroppedFiles(
    dropped: Awaited<ReturnType<typeof readDroppedFiles>>,
    destination: string,
  ) {
    if (!target || dropped.length === 0) return;
    setTransferStatus({ busy: `Uploading ${dropped.length} file${dropped.length === 1 ? "" : "s"}…`, error: null });
    try {
      await uploadWorkspaceFilesRequest(target, destination, dropped);
      if (destination) expandPath(destination);
      refreshFiles();
      setTransferStatus({ busy: null, error: null });
      void captureTelemetryEvent("workspace_file_action_result", {
        file_action: "upload",
        entry_kind: "file",
        result: "success",
      });
    } catch (error) {
      refreshFiles();
      setTransferStatus({ busy: null, error: error instanceof Error ? error.message : "The upload failed." });
      void captureTelemetryEvent("workspace_file_action_result", {
        file_action: "upload",
        entry_kind: "file",
        result: "failed",
      });
    }
  }

  function clearDragState() {
    internalDragRef.current = null;
    setDropTarget(null);
    if (dragExpandRef.current) {
      clearTimeout(dragExpandRef.current.timer);
      dragExpandRef.current = null;
    }
  }

  function beginInternalDrag(node: WorkspaceTreeNode) {
    const inSelection = treeSelection.selection.paths.has(node.path) && treeSelection.selection.paths.size > 1;
    internalDragRef.current = inSelection ? selectedRootPaths() : [node.path];
  }

  /** Marks a folder (`""` is the root) as a drop target when the drag in flight can land there. */
  function handleDragOverFolder(event: DragEvent, destination: string) {
    if (!canMutate) return;
    const internal = internalDragRef.current;
    if (internal) {
      const copying = event.altKey || event.ctrlKey;
      const verdict = resolveWorkspaceDrop(internal, destination);
      if (!verdict.allowed && !(copying && !internal.some((s) => destination === s || destination.startsWith(`${s}/`)))) return;
      event.dataTransfer.dropEffect = copying ? "copy" : "move";
    } else if (hasExternalFileDrag(event.dataTransfer)) {
      event.dataTransfer.dropEffect = "copy";
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(destination);
    // Hovering a closed folder opens it, so the drop can reach what is inside.
    if (destination && !expandedPaths.has(destination) && dragExpandRef.current?.path !== destination) {
      if (dragExpandRef.current) clearTimeout(dragExpandRef.current.timer);
      dragExpandRef.current = {
        path: destination,
        timer: setTimeout(() => {
          toggleDirectory(destination);
          dragExpandRef.current = null;
        }, 700),
      };
    }
  }

  function handleDropOnFolder(event: DragEvent, destination: string) {
    if (!canMutate) return;
    const internal = internalDragRef.current;
    const external = !internal && hasExternalFileDrag(event.dataTransfer);
    if (!internal && !external) return;
    event.preventDefault();
    event.stopPropagation();
    const copying = event.altKey || event.ctrlKey;
    // Entries must be read before the first await: the drop's data is gone after it.
    const droppedPromise = external ? readDroppedFiles(event.dataTransfer) : null;
    clearDragState();
    if (internal) {
      if (copying) void runTransfer("copy", internal, destination);
      else void runTransfer("move", resolveWorkspaceDrop(internal, destination).movable, destination);
    } else if (droppedPromise) {
      void droppedPromise.then((dropped) => uploadDroppedFiles(dropped, destination));
    }
  }

  /** Opens a shell in the folder, beside the panel the user is working in. */
  function openTerminalIn(directory: string) {
    const cwd = toAbsoluteWorkspacePath(workDir, directory);
    if (!cwd) return;
    const panels = usePanelStore.getState();
    const tab = panels.tabPanels[panels.activeTabId];
    if (!tab) return;
    const terminalPanelId = panels.createTerminalPanelAt(tab.activePanelId, uuidv4(), cwd, "vertical");
    if (terminalPanelId) {
      const tabStore = useTabStore.getState();
      tabStore.pinTab(tabStore.activeTabId);
    }
  }

  // ---- Keyboard ----------------------------------------------------------

  function focusTreeRow(path: string) {
    const rows = treeContainerRef.current?.querySelectorAll<HTMLElement>("[data-tree-path]");
    for (const row of rows ?? []) {
      if (row.dataset.treePath === path) {
        row.focus();
        row.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  }

  function handleTreeNavigationKey(event: React.KeyboardEvent): boolean {
    const active = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-path]");
    const current = active?.dataset.treePath ?? selectedPath;
    const rows = visibleNodes.map((node) => ({ path: node.path, type: node.type, name: node.name }));

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
      const typeAhead = typeAheadRef.current;
      if (typeAhead.timer) clearTimeout(typeAhead.timer);
      typeAhead.buffer += event.key;
      typeAhead.timer = setTimeout(() => { typeAhead.buffer = ""; }, 800);
      const match = findWorkspaceTypeAheadMatch(rows, current, typeAhead.buffer);
      if (!match) return false;
      treeSelection.selectPath(match);
      focusTreeRow(match);
      return true;
    }

    const action = resolveWorkspaceTreeKey({
      current,
      expanded: expandedPaths,
      key: event.key,
      rows,
      searching: isSearching,
      shiftKey: event.shiftKey,
    });
    if (!action) return false;
    if (action.type === "expand") {
      toggleDirectory(action.path);
    } else if (action.type === "collapse") {
      toggleDirectory(action.path);
    } else {
      if (action.extend) {
        treeSelection.selectWithModifiers(action.path, { ctrlKey: false, metaKey: false, shiftKey: true });
      } else {
        treeSelection.selectPath(action.path);
      }
      focusTreeRow(action.path);
    }
    return true;
  }

  function expandSubfolders(path: string) {
    const nested = baseDirectories.filter((directory) => directory === path || directory.startsWith(`${path}/`));
    for (const directory of nested) {
      expandPath(directory);
      if (!loadedDirectorySet.has(directory) && !loadingDirectorySet.has(directory)) {
        void loadDirectory(directory, { silent: true });
      }
    }
  }

  function collapseSubfolders(path: string) {
    if (!targetKey) return;
    setExpandedPaths(targetKey, storedExpandedPaths.filter((entry) => !entry.startsWith(`${path}/`)));
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

  /** Keep native double-click support, but use a tighter app-level threshold. */
  function handleDirectoryClick(event: MouseEvent, path: string) {
    const previousClick = directoryRenameDoubleClickRef.current;
    const qualifiedDoubleClick = isRapidDirectoryRenameDoubleClick({
      clickCount: event.detail,
      path,
      previousPath: previousClick?.path,
      previousTimestamp: previousClick?.timestamp,
      timestamp: event.timeStamp,
    });
    directoryRenameDoubleClickRef.current = {
      path,
      qualified: qualifiedDoubleClick,
      timestamp: event.timeStamp,
    };
    if (!shouldToggleDirectoryOnClick(event.detail, qualifiedDoubleClick)) return;
    toggleDirectory(path);
  }

  /** Named apart from the hook's `startRename` to keep row event handling local. */
  function beginRename(node: WorkspaceTreeNode) {
    cancelReveal();
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
    cancelReveal();
    treeSelection.selectContextPath(node.path);
    setContextMenu(nextContextMenu);
  }

  /** Right-click past the last row: the actions that need no row. */
  function openBackgroundContextMenu(event: MouseEvent) {
    cancelReveal();
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
    if (node.type === "directory") return { kind: "directory", path: node.path, dirty: hasUnsavedWorkspaceFileEditsUnder(targetKey, node.path) };
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
    cancelReveal();
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
    if (node.type === "directory") {
      const expanded = isSearching || expandedPaths.has(node.path);
      const directoryLoading = loadingDirectorySet.has(node.path);
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
          <div
            className={cn(
              "group flex min-w-0 items-center transition-colors hover:bg-(--sidebar-hover)",
              treeSelection.selection.paths.has(node.path) && "bg-(--accent)/10",
              dropTarget === node.path && "bg-(--accent)/20 outline outline-1 -outline-offset-1 outline-(--accent)",
              isCutPath(node.path) && "opacity-50",
            )}
            onDragOver={(event) => handleDragOverFolder(event, node.path)}
            onDrop={(event) => handleDropOnFolder(event, node.path)}
          >
          <WorkspaceTreeDirectoryButton
            name={node.name}
            decoration={<WorkspaceGitBadge decoration={gitDecorations?.directories.get(node.path) ?? gitDecorations?.files.get(node.path)} directory />}
            depth={depth}
            expanded={expanded}
            loading={directoryLoading}
            nameProps={{
              onDoubleClick: (event) => {
                if (!canMutate || !directoryRenameDoubleClickRef.current?.qualified) return;
                if (event.ctrlKey || event.metaKey || event.shiftKey || treeSelection.selection.paths.size > 1) return;
                event.stopPropagation();
                beginRename(node);
              },
            }}
            type="button"
            {...telemetryClickAttributes("files.directory.toggle", "files_panel")}
            onClick={(event) => {
              cancelReveal();
              if (treeSelection.selectWithModifiers(node.path, event)) return;
              handleDirectoryClick(event, node.path);
            }}
            onKeyDown={(event) => {
              if (!canMutate || treeSelection.selection.paths.size > 1 || event.key !== "F2") return;
              event.preventDefault();
              beginRename(node);
            }}
            onContextMenu={(event) => openRowContextMenu(event, node, absolutePath)}
            onDragStart={(event) => {
              cancelReveal();
              beginInternalDrag(node);
              if (!sessionId) return;
              setWorkspaceDirectoryDragData(event.dataTransfer, sessionId, node.path, absolutePath);
            }}
            onDragEnd={clearDragState}
            draggable={Boolean(target)}
            data-tree-path={node.path}
            title={node.path}
            aria-pressed={treeSelection.selection.paths.has(node.path)}
            data-testid={`workspace-directory-row-${node.path}`}
          />
          </div>
          {expanded ? <div className="relative"><WorkspaceTreeBranchGuide depth={depth} />{children}</div> : null}
        </div>
      );
    }

    const isSelected = treeSelection.selection.paths.has(node.path);
    const absolutePath = toAbsoluteWorkspacePath(workDir, node.path);

    if (inlineInput.isRenaming(node.path)) {
      return <div key={`file:${node.path}`}>{renderInlineInputRow(depth)}</div>;
    }

    return (
      <div
        key={`file:${node.path}`}
        className={cn(workspaceTreeFileRowClassName(isSelected), isCutPath(node.path) && "opacity-50")}
        onContextMenu={(event) => openRowContextMenu(event, node, absolutePath)}
        onDragOver={(event) => handleDragOverFolder(event, parentOf(node.path))}
        onDrop={(event) => handleDropOnFolder(event, parentOf(node.path))}
      >
        <WorkspaceTreeFileButton
          depth={depth}
          type="button"
          {...telemetryClickAttributes("files.file.open", "files_panel")}
          onClick={(event) => {
            cancelReveal();
              if (treeSelection.selectWithModifiers(node.path, event)) return;
            if (!target) return;
            // A mouse click only selects; the double-click below opens the file.
            // Enter (detail 0) and a touch tap open the replaceable preview tab.
            if (!shouldOpenOnRowClick(event.detail, clickPointerType(event))) return;
            previewWorkspaceTargetFileTab(target, 'file', node.path, {
              preferKanbanPeek: true,
              projectDir: sessionProjectDir,
            });
          }}
          onDoubleClick={(event) => {
            if (!target || event.ctrlKey || event.metaKey || event.shiftKey) return;
            openWorkspaceTargetFileTab(target, 'file', node.path, {
              preferKanbanPeek: true,
              projectDir: sessionProjectDir,
            });
          }}
          onKeyDown={(event) => {
            // F2, not Enter: Enter already activates the row, and taking that
            // to mean rename would stop the keyboard opening a file at all.
            if (!canMutate || treeSelection.selection.paths.size > 1 || event.key !== "F2") return;
            event.preventDefault();
            beginRename(node);
          }}
          onDragStart={(event) => {
            cancelReveal();
            if (!target) return;
            beginInternalDrag(node);
            treeSelection.selectContextPath(node.path);
            setWorkspaceTargetFileDragData(event.dataTransfer, target, "file", node.path, absolutePath);
          }}
          onDragEnd={clearDragState}
          draggable={Boolean(target)}
          data-tree-path={node.path}
          title={node.isSymlink ? `${node.path} (symbolic link)` : node.path}
          aria-pressed={isSelected}
          data-testid={`workspace-file-row-${node.path}`}
          data-workspace-file-path={node.path}
          data-symlink={node.isSymlink ? "true" : undefined}
        >
          {node.isSymlink ? (
            <Link2
              className="h-3.5 w-3.5 shrink-0 text-(--text-muted) group-hover:text-(--text-primary)"
              aria-label="Symbolic link"
            />
          ) : (
            <WorkspaceFileIcon name={node.name} />
          )}
          <WorkspaceFileName name={node.name} />
          <WorkspaceGitBadge decoration={gitDecorations?.files.get(node.path)} />
        </WorkspaceTreeFileButton>
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
          <Tooltip content="Refresh">
            <button
              type="button"
              {...telemetryClickAttributes("files.refresh", "files_panel")}
              onClick={() => { setTransferStatus({ busy: null, error: null }); refreshFiles(); }}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-(--input-border) text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
              aria-label="Refresh"
              data-testid="workspace-refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content={`Sort: ${sortMode === "name" ? "name A–Z" : sortMode === "name-desc" ? "name Z–A" : sortMode === "type" ? "file type" : "last modified"}`}>
            <button
              type="button"
              {...telemetryClickAttributes("files.sort", "files_panel")}
              onClick={() => setSortMode(sortMode === "name" ? "name-desc" : sortMode === "name-desc" ? "type" : sortMode === "type" ? "modified" : "name")}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-(--input-border) text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
              aria-label="Change sort order"
              data-testid="workspace-sort"
            >
              {sortMode === "name" ? <ArrowDownAZ className="h-3.5 w-3.5" /> : sortMode === "name-desc" ? <ArrowUpZA className="h-3.5 w-3.5" /> : sortMode === "type" ? <FileType className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
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
        <div className="flex min-h-0 flex-1 flex-col gap-1 py-2">
          <div className="flex items-center justify-between px-3 pb-1">
            <span className="text-[11px] font-medium text-(--text-secondary)">
              Workspace files
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-(--text-muted) tabular-nums">
                {visibleFiles.length.toLocaleString()}
              </span>
              <WorkspaceTreeExpansionControls
                disabled={isSearching || !targetKey || baseDirectories.length === 0}
                onCollapseAll={collapseAllFolders}
              />
            </div>
          </div>
          {selectedNodes.length > 1 ? (
            <div className="flex items-center gap-2 px-3 py-1 text-xs text-(--text-secondary)" data-testid="workspace-selection-actions">
              <span className="min-w-0 flex-1">{selectedNodes.length} selected</span>
              <button type="button" className="rounded p-1 hover:bg-(--sidebar-hover) disabled:opacity-40" disabled={!selectedFiles.length}
                onClick={openSelectedFiles} aria-label="Open selected files" title="Open selected files"><Files className="h-3.5 w-3.5" /></button>
              <button type="button" className="rounded p-1 text-(--status-error-text) hover:bg-(--sidebar-hover)"
                onClick={requestSelectedDelete} aria-label="Delete selected items" title="Delete selected items"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ) : null}
          {transferStatus.busy ? (
            <p className="flex items-center gap-1.5 px-3 text-xs text-(--text-secondary)" role="status" data-testid="workspace-transfer-busy">
              <LoaderCircle className="h-3 w-3 animate-spin" />{transferStatus.busy}
            </p>
          ) : null}
          {transferStatus.error ? (
            <p className="flex items-start gap-1.5 px-3 text-xs text-(--status-error-text)" role="alert" data-testid="workspace-transfer-error">
              <span className="min-w-0 flex-1">{transferStatus.error}</span>
              <button type="button" className="shrink-0 underline" onClick={() => setTransferStatus({ busy: null, error: null })}>Dismiss</button>
            </p>
          ) : null}
          {listedTruncated ? <p className="px-3 text-xs text-(--text-muted)" data-testid="workspace-truncated-notice">The list was truncated, so some files are not shown. Narrow it with search.</p> : null}
          {gitDecorations?.partial ? <p className="px-3 text-xs text-(--text-muted)">Git status is incomplete because the change list was truncated.</p> : null}
          <ScrollArea key={targetKey} ref={scrollRef} className="min-h-0 flex-1" onWheel={cancelReveal} onTouchStart={cancelReveal}>
            {/* The rows stop their own context menu, so this one only ever
                fires on the empty space past the last row. */}
            <div
              ref={treeContainerRef}
              className={cn(
                "flex min-h-full flex-col",
                dropTarget === "" && "outline outline-1 -outline-offset-1 outline-(--accent)",
              )}
              onContextMenu={openBackgroundContextMenu}
              onDragOver={(event) => handleDragOverFolder(event, "")}
              onDrop={(event) => handleDropOnFolder(event, "")}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
              }}
              data-testid="workspace-file-tree"
              onKeyDown={(event) => {
                if (inlineInput.input || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
                const modifier = event.ctrlKey || event.metaKey;
                if (modifier && !event.shiftKey && !event.altKey && ["c", "x", "v"].includes(event.key.toLowerCase())) {
                  if (!canMutate) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const key = event.key.toLowerCase();
                  if (key === "v") {
                    const anchor = selectedNodes.find((node) => node.path === selectedPath) ?? selectedNodes[0] ?? null;
                    void pasteClipboard(pasteDestinationFor(anchor));
                  } else {
                    copySelectionToClipboard(key === "x" ? "cut" : "copy");
                  }
                  return;
                }
                if (event.key === "Escape" && (clipboard || selectedNodes.length)) {
                  setClipboard(null);
                  treeSelection.selectPath(null);
                  return;
                }
                if (!modifier && !event.altKey && handleTreeNavigationKey(event)) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelReveal();
                  treeSelection.selectAll();
                } else if (event.key === "Delete" && selectedNodes.length) {
                  event.preventDefault();
                  event.stopPropagation();
                  requestSelectedDelete();
                }
              }}
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
          selectionActions={canMutate && contextMenu.node && treeSelection.selection.paths.has(contextMenu.node.path) && selectedNodes.length > 1 ? {
            count: selectedNodes.length,
            onOpen: selectedFiles.length ? openSelectedFiles : undefined,
            onDelete: requestSelectedDelete,
            onCut: () => copySelectionToClipboard("cut"),
            onCopy: () => copySelectionToClipboard("copy"),
            onCopyRelativePaths: () => copyText(selectedRootPaths().join("\n")),
          } : undefined}
          entryActions={canMutate ? {
            onDelete: contextMenu.node
              ? () => setDeleteRequests([deleteRequestFor(contextMenu.node!)])
              : undefined,
            onNewFile: () => beginNewEntry("file", newEntryParentFor(contextMenu.node)),
            onNewFolder: () => beginNewEntry("folder", newEntryParentFor(contextMenu.node)),
            onRename: contextMenu.node
              ? () => beginRename(contextMenu.node!)
              : undefined,
            onCut: contextMenu.node ? () => copySelectionToClipboard("cut") : undefined,
            onCopy: contextMenu.node ? () => copySelectionToClipboard("copy") : undefined,
            onDuplicate: contextMenu.node ? () => { void duplicateSelection(); } : undefined,
            onPaste: canPasteHere()
              ? () => { void pasteClipboard(pasteDestinationFor(contextMenu.node)); }
              : undefined,
            onCopyRelativePath: contextMenu.node ? () => copyText(contextMenu.node!.path) : undefined,
            onOpenTerminal: () => openTerminalIn(newEntryParentFor(contextMenu.node)),
            onExpandChildren: contextMenu.node?.type === "directory"
              ? () => expandSubfolders(contextMenu.node!.path)
              : undefined,
            onCollapseChildren: contextMenu.node?.type === "directory"
              ? () => collapseSubfolders(contextMenu.node!.path)
              : undefined,
          } : undefined}
          onClose={() => setContextMenu(null)}
          position={contextMenu.position}
        />
      ) : null}
      <WorkspaceDeleteDialog
        onConfirm={deleteEntry}
        trashLabel={trashLabel}
        onOpenChange={(next) => {
          if (!next) setDeleteRequests(null);
        }}
        requests={deleteRequests}
      />
    </div>
  );
}
