"use client";

import {
  AlertCircle,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  LoaderCircle,
  Search,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import {
  openWorkspaceFileTab,
  previewWorkspaceFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
import { setWorkspaceFileDragData } from "@/lib/dnd/panel-session-drag";
import { fetchWithTimeout, isTimeoutError } from "@/lib/api/fetch-with-timeout";
import {
  copyText,
  toAbsoluteWorkspacePath,
} from "@/lib/workspace-tabs/file-path-actions";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import { cn } from "@/lib/utils";

interface WorkspaceFilesResponse {
  files?: string[];
  truncated?: boolean;
  workDir?: string | null;
}

interface WorkspaceFilePanelState {
  loading: boolean;
  error: string | null;
  truncated: boolean;
}

interface WorkspaceFileNode {
  type: "file";
  name: string;
  path: string;
}

interface WorkspaceDirectoryNode {
  type: "directory";
  name: string;
  path: string;
  children: WorkspaceTreeNode[];
  fileCount: number;
}

type WorkspaceTreeNode = WorkspaceDirectoryNode | WorkspaceFileNode;

interface FileContextMenuState {
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

function buildFileTree(filePaths: string[]): WorkspaceTreeNode[] {
  const root = createMutableDirectory("", "");

  for (const filePath of filePaths) {
    const parts = filePath.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;

    let directory = root;
    for (const part of parts) {
      const childPath = directory.path ? `${directory.path}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = createMutableDirectory(part, childPath);
        directory.directories.set(part, child);
      }
      directory = child;
    }

    directory.files.push({
      type: "file",
      name: fileName,
      path: filePath,
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
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [workDir, setWorkDir] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const [state, setState] = useState<WorkspaceFilePanelState>(() => ({
    loading: Boolean(sessionId),
    error: null,
    truncated: false,
  }));

  useEffect(() => {
    if (!sessionId) {
      setWorkDir(null);
      return;
    }

    const abortController = new AbortController();
    setWorkDir(null);

    const loadFiles = async () => {
      try {
        const response = await fetchWithTimeout(
          `/api/sessions/${encodeURIComponent(sessionId)}/files`,
          { signal: abortController.signal, retries: 1 },
        );
        const payload = (await response.json().catch(() => null)) as WorkspaceFilesResponse | null;
        if (!response.ok) throw new Error("Failed to load files.");
        setFiles(Array.isArray(payload?.files) ? payload.files : []);
        setWorkDir(payload?.workDir ?? null);
        setState({
          loading: false,
          error: null,
          truncated: Boolean(payload?.truncated),
        });
      } catch (error) {
        if (abortController.signal.aborted) return;
        setState({
          loading: false,
          error: isTimeoutError(error)
            ? "The file list did not load in time."
            : error instanceof Error ? error.message : "Failed to load files.",
          truncated: false,
        });
      }
    };

    void loadFiles();
    return () => abortController.abort();
  }, [sessionId]);

  const visibleFiles = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return files;
    return files
      .filter((filePath) => filePath.toLowerCase().includes(trimmed));
  }, [files, query]);
  const fileTree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);
  const isSearching = query.trim().length > 0;

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
      return (
        <div key={`dir:${node.path}`} className="flex flex-col">
          <button
            type="button"
            onClick={() => toggleDirectory(node.path)}
            className="group flex min-w-0 items-center gap-1.5 border-l-2 border-l-transparent py-1.5 pr-2 text-left text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
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
            previewWorkspaceFileTab(sessionId, "file", node.path);
          }}
          onDoubleClick={() => {
            if (!sessionId) return;
            setSelectedPath(node.path);
            openWorkspaceFileTab(sessionId, "file", node.path);
          }}
          onDragStart={(event) => {
            if (!sessionId) return;
            setSelectedPath(node.path);
            setWorkspaceFileDragData(event.dataTransfer, sessionId, "file", node.path);
          }}
          draggable={Boolean(sessionId)}
          className="flex min-w-0 items-center gap-2 border-l-transparent py-1.5 pr-2 text-left transition-colors"
          title={node.path}
          data-testid={`workspace-file-row-${node.path}`}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-(--text-muted) group-hover:text-(--text-primary)" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {node.name}
          </span>
        </button>
        <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-(--sidebar-hover)/95 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
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
                {files.length.toLocaleString()} files
                {state.truncated ? " · truncated" : ""}
              </p>
            </div>
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

      {state.loading ? (
        <div className="flex h-full items-center justify-center">
          <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
        </div>
      ) : state.error ? (
        <EmptyState title="Files unavailable" body={state.error} icon="error" />
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
    </div>
  );
}
