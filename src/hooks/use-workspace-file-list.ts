"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithTimeout, isTimeoutError } from "@/lib/api/fetch-with-timeout";
import { workspaceTargetApiPath, type WorkspaceTarget } from "@/types/worktree";

interface WorkspaceFilesResponse {
  directories?: string[];
  files?: string[];
  symlinks?: string[];
  truncated?: boolean;
  workDir?: string | null;
}

interface WorkspaceFileListState {
  /**
   * Folders as the server saw them, not inferred from the file paths: an empty
   * one appears in no file path at all.
   */
  directories: string[];
  error: string | null;
  files: string[];
  loading: boolean;
  /** Subset of `files` that are symbolic links, in the same order. */
  symlinks: string[];
  truncated: boolean;
  workDir: string | null;
}

interface WorkspaceFileListMutation {
  kind: "directory" | "file";
  path: string;
  previousPath?: string;
  type: "create" | "delete" | "rename";
}

interface WorkspaceFileListLoadOptions {
  signal?: AbortSignal;
  silent?: boolean;
  /**
   * A successful mutation that the bridged Windows -> WSL file index may not
   * expose on its first pass even though the filesystem operation completed.
   */
  mutation?: WorkspaceFileListMutation;
}

const MUTATION_LIST_ATTEMPTS = 5;

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function isPathAtOrBelow(candidate: string, path: string): boolean {
  return candidate === path || candidate.startsWith(`${path}/`);
}

function compareWorkspacePaths(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function reconcileEntries(
  entries: string[],
  collection: "directories" | "files" | "symlinks",
  mutation: WorkspaceFileListMutation,
): string[] {
  if (collection === "directories" && mutation.kind === "file") return entries;
  if (collection === "symlinks" && mutation.type === "create") return entries;

  let next = entries;
  const previousPath = mutation.previousPath;
  if (mutation.type === "create") {
    next = entries.includes(mutation.path) ? entries : [...entries, mutation.path];
  } else if (mutation.type === "delete") {
    next = entries.filter((entry) => !isPathAtOrBelow(entry, mutation.path));
  } else if (previousPath) {
    next = entries.map((entry) => isPathAtOrBelow(entry, previousPath)
      ? `${mutation.path}${entry.slice(previousPath.length)}`
      : entry);
  }
  return [...new Set(next)].sort(compareWorkspacePaths);
}

function payloadReflectsMutation(
  payload: WorkspaceFilesResponse | null,
  mutation: WorkspaceFileListMutation,
): boolean {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const directories = Array.isArray(payload?.directories) ? payload.directories : [];
  return sameStringArray(files, reconcileEntries(files, "files", mutation))
    && sameStringArray(directories, reconcileEntries(directories, "directories", mutation));
}

export function useWorkspaceFileList(
  selected: string | WorkspaceTarget | null,
  projectId?: string | null,
): WorkspaceFileListState & {
  loadFiles: (options?: WorkspaceFileListLoadOptions) => Promise<void>;
  refreshFiles: () => void;
} {
  const targetKind = typeof selected === "string" ? "session" : selected?.kind;
  const targetId = typeof selected === "string" ? selected : selected?.id;
  const [state, setState] = useState<WorkspaceFileListState>(() => ({
    directories: [],
    error: null,
    files: [],
    loading: Boolean(targetId),
    symlinks: [],
    truncated: false,
    workDir: null,
  }));
  const requestSeqRef = useRef(0);

  const loadFiles = useCallback(async (options?: WorkspaceFileListLoadOptions) => {
      if (!targetKind || !targetId) {
        setState({
          directories: [],
          error: null,
          files: [],
          loading: false,
          symlinks: [],
          truncated: false,
          workDir: null,
        });
        return;
      }

      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;

      if (!options?.silent) {
        setState((current) => ({
          ...current,
          error: null,
          loading: true,
          truncated: false,
          workDir: null,
        }));
      }

      try {
        const target: WorkspaceTarget = { kind: targetKind, id: targetId };
        // The sessions/[id]/files route requires projectId to scope Project View
        // reference sessions; skip the query param for worktree targets.
        const url = target.kind === "session" && projectId
          ? `${workspaceFileListPath(target)}?projectId=${encodeURIComponent(projectId)}`
          : workspaceFileListPath(target);
        let payload: WorkspaceFilesResponse | null = null;
        const attempts = options?.mutation ? MUTATION_LIST_ATTEMPTS : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const response = await fetchWithTimeout(
            url,
            { cache: 'no-store', signal: options?.signal, retries: 1 },
          );
          payload = (await response.json().catch(() => null)) as WorkspaceFilesResponse | null;
          if (!response.ok) throw new Error("Failed to load files.");
          if (!options?.mutation || payloadReflectsMutation(payload, options.mutation)) break;
        }

        if (requestSeqRef.current !== requestSeq) return;
        let nextFiles = Array.isArray(payload?.files) ? payload.files : [];
        let nextSymlinks = Array.isArray(payload?.symlinks) ? payload.symlinks : [];
        let nextDirectories = Array.isArray(payload?.directories) ? payload.directories : [];
        // The mutation response is authoritative. If the bridge index is still
        // serving an old WSL directory snapshot after the bounded retry,
        // reconcile the successful operation locally until the next refresh.
        if (options?.mutation) {
          nextFiles = reconcileEntries(nextFiles, "files", options.mutation);
          nextDirectories = reconcileEntries(nextDirectories, "directories", options.mutation);
          nextSymlinks = reconcileEntries(nextSymlinks, "symlinks", options.mutation);
        }
        setState((current) => ({
          directories: sameStringArray(current.directories, nextDirectories)
            ? current.directories
            : nextDirectories,
          error: null,
          files: sameStringArray(current.files, nextFiles) ? current.files : nextFiles,
          loading: false,
          symlinks: sameStringArray(current.symlinks, nextSymlinks) ? current.symlinks : nextSymlinks,
          truncated: Boolean(payload?.truncated),
          workDir: payload?.workDir ?? null,
        }));
      } catch (error) {
        if (options?.signal?.aborted || requestSeqRef.current !== requestSeq) return;
        const message = isTimeoutError(error)
          ? "The file list did not load in time."
          : error instanceof Error ? error.message : "Failed to load files.";
        setState((current) => options?.silent
          ? {
              ...current,
              loading: false,
            }
          : {
              directories: [],
              error: message,
              files: [],
              loading: false,
              symlinks: [],
              truncated: false,
              workDir: null,
            });
      }
  }, [targetId, targetKind, projectId]);

  useEffect(() => {
    const abortController = new AbortController();
    void loadFiles({ signal: abortController.signal });
    return () => abortController.abort();
  }, [loadFiles]);

  const refreshFiles = useCallback(() => {
    void loadFiles({ silent: true });
  }, [loadFiles]);

  return {
    ...state,
    loadFiles,
    refreshFiles,
  };
}

export function workspaceFileListPath(target: WorkspaceTarget): string {
  return `${workspaceTargetApiPath(target)}/files`;
}
