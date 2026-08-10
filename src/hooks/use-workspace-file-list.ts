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

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function useWorkspaceFileList(
  selected: string | WorkspaceTarget | null,
  projectId?: string | null,
): WorkspaceFileListState & {
  loadFiles: (options?: { signal?: AbortSignal; silent?: boolean }) => void;
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

  const loadFiles = useCallback((options?: {
    signal?: AbortSignal;
    silent?: boolean;
  }) => {
    void (async () => {
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
        const response = await fetchWithTimeout(
          url,
          { signal: options?.signal, retries: 1 },
        );
        const payload = (await response.json().catch(() => null)) as WorkspaceFilesResponse | null;
        if (!response.ok) throw new Error("Failed to load files.");

        if (requestSeqRef.current !== requestSeq) return;
        const nextFiles = Array.isArray(payload?.files) ? payload.files : [];
        const nextSymlinks = Array.isArray(payload?.symlinks) ? payload.symlinks : [];
        const nextDirectories = Array.isArray(payload?.directories) ? payload.directories : [];
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
    })();
  }, [targetId, targetKind, projectId]);

  useEffect(() => {
    const abortController = new AbortController();
    loadFiles({ signal: abortController.signal });
    return () => abortController.abort();
  }, [loadFiles]);

  const refreshFiles = useCallback(() => {
    loadFiles({ silent: true });
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
