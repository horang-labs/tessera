"use client";

import {
  AlertCircle,
  ChevronRight,
  Copy,
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
  PenLine,
  Search,
  Trash2,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
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
import {
  copyText,
  toAbsoluteWorkspacePath,
} from "@/lib/workspace-tabs/file-path-actions";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import { WorkspaceNewFileDialog } from "@/components/workspace/workspace-new-file-dialog";
import { WorkspaceEntryNameDialog } from "@/components/workspace/workspace-entry-name-dialog";
import {
  WorkspaceDeleteDialog,
  type WorkspaceDeleteRequest,
} from "@/components/workspace/workspace-delete-dialog";
import {
  createWorkspaceDirectoryRequest,
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
  // null when closed; the string is the folder the dialog pre-fills with.
  const [newFileDirectory, setNewFileDirectory] = useState<string | null>(null);
  const [newFolderDirectory, setNewFolderDirectory] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
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

  useWorkspaceFilesLiveSync({
    enabled: Boolean(sessionId) && isDocumentVisible,
    onRefresh: refreshFiles,
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
    // file needs it as an ancestor — the file rows are nested under it.
    return baseDirectories.filter((dirPath) =>
      dirPath.toLowerCase().includes(trimmed)
      || visibleFiles.some((filePath) => filePath.startsWith(`${dirPath}/`)));
  }, [baseDirectories, query, visibleFiles]);
  const symlinkPaths = useMemo(() => new Set(symlinks), [symlinks]);
  const fileTree = useMemo(
    () => buildFileTree(visibleFiles, symlinkPaths, visibleDirectories),
    [symlinkPaths, visibleDirectories, visibleFiles],
  );
  const isSearching = query.trim().length > 0;

  async function createFolder(directory: string, name: string) {
    if (!sessionId) return;
    const created = await createWorkspaceDirectoryRequest(
      sessionId,
      directory ? `${directory}/${name}` : name,
    );
    // Expand the ancestors, or a folder created inside a collapsed one appears
    // to have done nothing.
    setExpandedPaths((current) => {
      const next = new Set(current);
      let walked = "";
      for (const part of created.path.split("/").slice(0, -1)) {
        walked = walked ? `${walked}/${part}` : part;
        next.add(walked);
      }
      return next;
    });
    refreshFiles();
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

  function renderTreeNode(node: WorkspaceTreeNode, depth: number): ReactNode {
    const paddingLeft = 8 + depth * 12;

    if (node.type === "directory") {
      const expanded = isSearching || expandedPaths.has(node.path);
      const FolderIcon = expanded ? FolderOpen : Folder;
      const absolutePath = toAbsoluteWorkspacePath(workDir, node.path);
      return (
        <div key={`dir:${node.path}`} className="flex flex-col">
          {/* The row's own action sits beside the disclosure button, not inside
              it: a control nested in a control is unreachable to a screen
              reader and invalid HTML. */}
          <div className="group flex min-w-0 items-center transition-colors hover:bg-(--sidebar-hover)">
          <button
            type="button"
            onClick={() => toggleDirectory(node.path)}
            onContextMenu={(event) => {
              if (!absolutePath) return;
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({
                absolutePath,
                canOpenFile: true,
                position: { x: event.clientX, y: event.clientY },
              });
            }}
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
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
              {node.name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-(--text-muted) tabular-nums">
              {node.fileCount}
            </span>
          </button>
          <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <Tooltip content={`New file in ${node.path}`}>
              <button
                type="button"
                onClick={() => setNewFileDirectory(node.path)}
                className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary)"
                aria-label={`New file in ${node.path}`}
                data-testid="workspace-new-file-in-folder"
              >
                <FilePlus2 className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip content={`New folder in ${node.path}`}>
              <button
                type="button"
                onClick={() => setNewFolderDirectory(node.path)}
                className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary)"
                aria-label={`New folder in ${node.path}`}
                data-testid="workspace-new-folder-in-folder"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip content={`Rename ${node.name}`}>
              <button
                type="button"
                onClick={() => setRenameTarget(node.path)}
                className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary)"
                aria-label={`Rename ${node.path}`}
                data-testid="workspace-rename-entry"
              >
                <PenLine className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip content={`Delete ${node.name}`}>
              <button
                type="button"
                onClick={() => setDeleteRequest({ kind: "directory", path: node.path })}
                className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--status-error-text)"
                aria-label={`Delete ${node.path}`}
                data-testid="workspace-delete-entry"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
          </div>
          {expanded ? node.children.map((child) => renderTreeNode(child, depth + 1)) : null}
        </div>
      );
    }

    const isSelected = node.path === selectedPath;
    const absolutePath = toAbsoluteWorkspacePath(workDir, node.path);

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
          if (!absolutePath) return;
          event.preventDefault();
          event.stopPropagation();
          setSelectedPath(node.path);
          setContextMenu({
            absolutePath,
            canOpenFile: true,
            position: { x: event.clientX, y: event.clientY },
          });
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (!sessionId) return;
            setSelectedPath(node.path);
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
        {/* Below the Phone viewport step the actions are simply present: `hover:` compiles
            to `@media (hover: hover)`, so on a phone no rule exists to reveal them. The
            reveal is kept from `sm` up, where a pointer drives the UI (#250). */}
        <div className="pointer-events-auto absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-(--sidebar-hover)/95 opacity-100 sm:pointer-events-none sm:opacity-0 shadow-sm transition-opacity sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <Tooltip content="Copy absolute path">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (!absolutePath || !node.path) return;
                copyText(absolutePath);
              }}
              disabled={!absolutePath}
              className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary) disabled:pointer-events-none disabled:opacity-35"
              aria-label={`Copy absolute path for ${absolutePath || node.path}`}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content={`Rename ${node.name}`}>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setRenameTarget(node.path);
              }}
              className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary)"
              aria-label={`Rename ${node.path}`}
              data-testid="workspace-rename-entry"
            >
              <PenLine className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content={`Delete ${node.name}`}>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setDeleteRequest({
                  kind: "file",
                  path: node.path,
                  dirty: hasUnsavedWorkspaceFileEdits(sessionId, node.path),
                });
              }}
              className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--status-error-text)"
              aria-label={`Delete ${node.path}`}
              data-testid="workspace-delete-entry"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
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
          <Tooltip content="New file">
            <button
              type="button"
              onClick={() => setNewFileDirectory("")}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-(--input-border) text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
              aria-label="New file"
              data-testid="workspace-new-file"
            >
              <FilePlus2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="New folder">
            <button
              type="button"
              onClick={() => setNewFolderDirectory("")}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-(--input-border) text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
              aria-label="New folder"
              data-testid="workspace-new-folder"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
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
      ) : fileTree.length === 0 ? (
        <EmptyState
          title={query.trim() ? "No matches" : "No files"}
          body={query.trim() ? "Try another search." : "This workspace has no readable files."}
        />
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
            <div className="flex flex-col">
              {fileTree.map((node) => renderTreeNode(node, 0))}
            </div>
          </ScrollArea>
        </div>
      )}
      {contextMenu ? (
        <WorkspaceFileContextMenu
          absolutePath={contextMenu.absolutePath}
          canOpenFile={contextMenu.canOpenFile}
          onClose={() => setContextMenu(null)}
          position={contextMenu.position}
        />
      ) : null}
      <WorkspaceNewFileDialog
        directory={newFileDirectory ?? ""}
        open={newFileDirectory !== null}
        onOpenChange={(next) => {
          if (!next) setNewFileDirectory(null);
        }}
        sessionId={sessionId}
      />
      <WorkspaceEntryNameDialog
        confirmLabel="Create"
        description={newFolderDirectory
          ? `New folder inside ${newFolderDirectory}.`
          : "New folder at the workspace root."}
        key={`new-folder:${newFolderDirectory ?? ""}`}
        onOpenChange={(next) => {
          if (!next) setNewFolderDirectory(null);
        }}
        onSubmit={(name) => createFolder(newFolderDirectory ?? "", name)}
        open={newFolderDirectory !== null}
        placeholder="drafts"
        testIdPrefix="workspace-new-folder"
        title="New folder"
      />
      <WorkspaceEntryNameDialog
        confirmLabel="Rename"
        description="New name. It stays in the same folder, so a name cannot contain a slash."
        initialValue={renameTarget ? renameTarget.split("/").pop() ?? "" : ""}
        key={`rename:${renameTarget ?? ""}`}
        onOpenChange={(next) => {
          if (!next) setRenameTarget(null);
        }}
        onSubmit={(name) => renameEntry(renameTarget ?? "", name)}
        open={renameTarget !== null}
        placeholder="new-name.md"
        testIdPrefix="workspace-rename"
        title="Rename"
      />
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
