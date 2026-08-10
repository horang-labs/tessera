"use client";

import {
  AlertCircle,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
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
import { isHiddenWorkspaceRelativePath } from "@/lib/workspace-files/hidden-workspace-path";
import { useWorkspaceFileViewStore } from "@/stores/workspace-file-view-store";
import {
  openWorkspaceFileTab,
  previewWorkspaceFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
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
  DIR_TOGGLE_DOUBLE_CLICK_MS,
  isRenameHotspotTarget,
  RENAME_HOTSPOT_ATTR,
  resolveDirToggleTiming,
  shouldOpenOnRowClick,
} from "@/components/workspace/workspace-inline-input-state";
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
  fileCount: number;
}

type WorkspaceTreeNode = WorkspaceDirectoryNode | WorkspaceFileNode;

interface PathContextMenuState {
  absolutePath: string;
  canOpenFile: boolean;
  /** The row it was opened on, or null for the panel's empty background. */
  node: WorkspaceTreeNode | null;
  position: { x: number; y: number };
}

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
  const fileCount = children.reduce((count, child) => {
    if (child.type === "file") return count + 1;
    return count + child.fileCount;
  }, 0);

  return {
    type: "directory",
    name: node.name,
    path: node.path,
    children,
    fileCount,
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

export function WorkspaceFilePanel({ sessionId }: { sessionId: string | null }) {
  const isDocumentVisible = useDocumentVisibility();
  const subscriberId = useStableWorkspaceFilesSubscriberId("workspace-file-panel");
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<WorkspaceDeleteRequest | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<PathContextMenuState | null>(null);
  const showHiddenFiles = useWorkspaceFileViewStore((state) => state.showHiddenFiles);
  const toggleShowHiddenFiles = useWorkspaceFileViewStore((state) => state.toggleShowHiddenFiles);
  const {
    directories,
    error,
    files,
    loading,
    refreshFiles,
    symlinks,
    truncated,
    workDir,
  } = useWorkspaceFileList(sessionId);

  const deferredToggleRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (deferredToggleRef.current !== null) window.clearTimeout(deferredToggleRef.current);
  }, []);

  const expandPath = useCallback((path: string) => {
    if (!path) return;
    setExpandedPaths((current) => {
      if (current.has(path)) return current;
      const next = new Set(current);
      let walked = "";
      for (const part of path.split("/")) {
        walked = walked ? `${walked}/${part}` : part;
        next.add(walked);
      }
      return next;
    });
  }, []);

  const inlineInput = useWorkspaceInlineInput({
    onCreateFile: createFile,
    onCreateFolder: createFolder,
    onExpandParent: expandPath,
    onRefreshFiles: refreshFiles,
    onRename: renameEntry,
    sessionId,
  });

  useWorkspaceFilesLiveSync({
    enabled: Boolean(sessionId) && isDocumentVisible,
    // Gated, not passed straight through: a reconcile landing while a name is
    // being typed would take the row it is being typed into.
    onRefresh: inlineInput.handleExternalRefresh,
    sessionId,
    subscriberId,
  });

  const baseFiles = useMemo(
    () => (showHiddenFiles
      ? files
      : files.filter((filePath) => !isHiddenWorkspaceRelativePath(filePath))),
    [files, showHiddenFiles],
  );
  const visibleFiles = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return baseFiles;
    return baseFiles
      .filter((filePath) => filePath.toLowerCase().includes(trimmed));
  }, [baseFiles, query]);
  const baseDirectories = useMemo(
    () => (showHiddenFiles
      ? directories
      : directories.filter((dirPath) => !isHiddenWorkspaceRelativePath(dirPath))),
    [directories, showHiddenFiles],
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
  const symlinkPaths = useMemo(() => new Set(symlinks), [symlinks]);
  const fileTree = useMemo(
    () => buildFileTree(visibleFiles, symlinkPaths, visibleDirectories),
    [symlinkPaths, visibleDirectories, visibleFiles],
  );
  const isSearching = query.trim().length > 0;

  // Expand the ancestors, or an entry created inside a collapsed folder appears
  // to have done nothing.
  function expandParentOf(path: string) {
    expandPath(path.split("/").slice(0, -1).join("/"));
  }

  async function createFolder(path: string) {
    if (!sessionId) return;
    const created = await createWorkspaceDirectoryRequest(sessionId, path);
    expandParentOf(created.path);
    refreshFiles();
  }

  async function createFile(path: string) {
    if (!sessionId) return;
    const created = await createWorkspaceFileRequest(sessionId, path);
    expandParentOf(created.path);
    refreshFiles();
    setSelectedPath(created.path);
    openWorkspaceFileTab(sessionId, "file", created.path);
  }

  async function renameEntry(path: string, newName: string) {
    if (!sessionId) return;
    const renamed = await renameWorkspaceEntryRequest(sessionId, path, newName);
    repointWorkspaceFileTabs(sessionId, renamed.previousPath, renamed.path);
    if (selectedPath && isPathUnderMutation(selectedPath, renamed.previousPath)) {
      setSelectedPath(renamed.path + selectedPath.slice(renamed.previousPath.length));
    }
    refreshFiles();
  }

  async function deleteEntry(request: WorkspaceDeleteRequest) {
    if (!sessionId) return;
    await deleteWorkspaceEntryRequest(sessionId, request.path, {
      recursive: request.kind === "directory",
    });
    // The tab has to go with the file: leaving it open shows an editable buffer
    // for a path that no longer exists.
    closeWorkspaceFileTabsFor(sessionId, request.path);
    if (selectedPath && isPathUnderMutation(selectedPath, request.path)) {
      setSelectedPath(null);
    }
    refreshFiles();
  }

  function toggleDirectory(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function clearDeferredToggle() {
    if (deferredToggleRef.current === null) return;
    window.clearTimeout(deferredToggleRef.current);
    deferredToggleRef.current = null;
  }

  /**
   * A click on the folder's name may be the first half of a double-click that
   * means rename, and toggling on both halves collapses and re-expands the row
   * under the input. Clicks on the name wait the double-click window out.
   */
  function handleDirectoryClick(event: MouseEvent, path: string) {
    const timing = resolveDirToggleTiming({
      clickCount: event.detail,
      fromRenameHotspot: isRenameHotspotTarget(event.target),
    });
    clearDeferredToggle();
    if (timing === "skip") return;
    if (timing === "immediate") {
      toggleDirectory(path);
      return;
    }
    deferredToggleRef.current = window.setTimeout(() => {
      deferredToggleRef.current = null;
      toggleDirectory(path);
    }, DIR_TOGGLE_DOUBLE_CLICK_MS);
  }

  /**
   * Named apart from the hook's `startRename` because it does more: the first
   * click of the gesture armed a deferred toggle, and it must not fire under
   * the input that is about to open.
   */
  function beginRename(node: WorkspaceTreeNode) {
    clearDeferredToggle();
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
    if (!absolutePath) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      absolutePath,
      canOpenFile: true,
      node,
      position: { x: event.clientX, y: event.clientY },
    });
  }

  /** Right-click past the last row: the actions that need no row. */
  function openBackgroundContextMenu(event: MouseEvent) {
    const rootPath = toAbsoluteWorkspacePath(workDir, "");
    if (!rootPath) return;
    event.preventDefault();
    setContextMenu({
      absolutePath: rootPath,
      canOpenFile: false,
      node: null,
      position: { x: event.clientX, y: event.clientY },
    });
  }

  /** A folder takes its contents with it; a file may take an unsaved draft. */
  function deleteRequestFor(node: WorkspaceTreeNode): WorkspaceDeleteRequest {
    if (node.type === "directory") return { kind: "directory", path: node.path };
    return {
      kind: "file",
      path: node.path,
      dirty: hasUnsavedWorkspaceFileEdits(sessionId, node.path),
    };
  }

  /** A new entry goes inside a folder, or beside the file that was clicked. */
  function newEntryParentFor(node: WorkspaceTreeNode | null): string {
    if (!node) return "";
    if (node.type === "directory") return node.path;
    return node.path.split("/").slice(0, -1).join("/");
  }

  function renderInlineInputRow(depth: number) {
    const input = inlineInput.input;
    if (!input) return null;
    // Re-pointing a tab remounts it on the new path, so the draft goes with the
    // old one. The delete confirmation says so; the rename has to as well.
    const hint = input.kind === "rename"
      && hasUnsavedWorkspaceFileEdits(sessionId, input.path)
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
            onClick={(event) => handleDirectoryClick(event, node.path)}
            onKeyDown={(event) => {
              if (event.key !== "F2") return;
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
              // The double-click-to-rename target is the name text alone, so the
              // disclosure stays reachable on the chevron, the icon and the
              // empty part of the row.
              {...{ [RENAME_HOTSPOT_ATTR]: "" }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                beginRename(node);
              }}
              className="min-w-0 flex-1 truncate font-mono text-[11px]"
            >
              {node.name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-(--text-muted) tabular-nums">
              {node.fileCount}
            </span>
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
          onClick={(event) => {
            if (!sessionId) return;
            setSelectedPath(node.path);
            // The second click of a double-click on the name means rename, and
            // re-previewing the same file under the input it just opened is
            // nothing anyone asked for.
            if (!shouldOpenOnRowClick({
              clickCount: event.detail,
              fromRenameHotspot: isRenameHotspotTarget(event.target),
            })) return;
            previewWorkspaceFileTab(sessionId, "file", node.path, {
              preferKanbanPeek: true,
            });
          }}
          onDoubleClick={() => {
            if (!sessionId) return;
            setSelectedPath(node.path);
            openWorkspaceFileTab(sessionId, "file", node.path, {
              preferKanbanPeek: true,
            });
          }}
          onKeyDown={(event) => {
            // F2, not Enter: Enter already activates the row, and taking that
            // to mean rename would stop the keyboard opening a file at all.
            if (event.key !== "F2") return;
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
          <span
            // Renaming is scoped to the name text, so the icon and the rest of
            // the row keep opening the file the way they always have.
            {...{ [RENAME_HOTSPOT_ATTR]: "" }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              beginRename(node);
            }}
            className="min-w-0 flex-1 truncate font-mono text-[11px]"
          >
            {node.name}
          </span>
        </button>
      </div>
    );
  }

  if (!sessionId) {
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
                {baseFiles.length.toLocaleString()} files
                {truncated ? " · truncated" : ""}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
          {/* Creating lives on the right-click menu, on a row or on the empty
              space below the tree — not on a header button and not on a strip
              of icons that follows the pointer down the tree. */}
          <Tooltip content={showHiddenFiles ? "Hide hidden files" : "Show hidden files"}>
            <button
              type="button"
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
              : "This workspace has no readable files. Right-click to add one."}
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
          entryActions={{
            onDelete: contextMenu.node
              ? () => setDeleteRequest(deleteRequestFor(contextMenu.node!))
              : undefined,
            onNewFile: () => inlineInput.startNew("file", newEntryParentFor(contextMenu.node)),
            onNewFolder: () => inlineInput.startNew("folder", newEntryParentFor(contextMenu.node)),
            onRename: contextMenu.node
              ? () => beginRename(contextMenu.node!)
              : undefined,
          }}
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
