"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithTimeout, isTimeoutError } from "@/lib/api/fetch-with-timeout";

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

export function useWorkspaceFileList(sessionId: string | null): WorkspaceFileListState & {
  loadFiles: (options?: { signal?: AbortSignal; silent?: boolean }) => void;
  refreshFiles: () => void;
} {
  const [state, setState] = useState<WorkspaceFileListState>(() => ({
    directories: [],
    error: null,
    files: [],
    loading: Boolean(sessionId),
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
      if (!sessionId) {
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
        const response = await fetchWithTimeout(
          `/api/sessions/${encodeURIComponent(sessionId)}/files`,
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
  }, [sessionId]);

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
