"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJsonWithTimeout, isTimeoutError } from "@/lib/api/fetch-with-timeout";
import { workspaceTargetApiPath, workspaceTargetKey, type WorkspaceTarget } from "@/types/worktree";

interface WorkspaceFilesResponse {
  directory?: string;
  directories?: string[];
  files?: string[];
  missing?: boolean;
  symlinks?: string[];
  truncated?: boolean;
  workDir?: string | null;
}

interface WorkspaceDirectoryListing {
  directories: string[];
  files: string[];
  symlinks: string[];
  truncated: boolean;
}

interface WorkspaceSearchResult extends WorkspaceDirectoryListing {
  error: string | null;
  loading: boolean;
}

interface WorkspaceFileListState {
  /** Entries from the root and the directories the user has actually opened. */
  directories: string[];
  error: string | null;
  files: string[];
  loadedDirectories: string[];
  loading: boolean;
  loadingDirectories: string[];
  searchResult: WorkspaceSearchResult;
  /** Subset of `files` that are symbolic links, in the same order. */
  symlinks: string[];
  truncated: boolean;
  workDir: string | null;
}

export interface WorkspaceFileListMutation {
  kind: "directory" | "file";
  path: string;
  previousPath?: string;
  type: "create" | "delete" | "rename";
}

interface WorkspaceDirectoryLoadOptions {
  signal?: AbortSignal;
  silent?: boolean;
  mutation?: WorkspaceFileListMutation;
}

const MUTATION_LIST_ATTEMPTS = 5;
const FILE_LIST_LOAD_TIMEOUT_MS = 15_000;

function normalizeWorkspaceRelativePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

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

function toListing(
  payload: WorkspaceFilesResponse | null,
  mutation?: WorkspaceFileListMutation,
): WorkspaceDirectoryListing {
  let files = Array.isArray(payload?.files) ? payload.files : [];
  let symlinks = Array.isArray(payload?.symlinks) ? payload.symlinks : [];
  let directories = Array.isArray(payload?.directories) ? payload.directories : [];
  if (mutation) {
    files = reconcileEntries(files, "files", mutation);
    directories = reconcileEntries(directories, "directories", mutation);
    symlinks = reconcileEntries(symlinks, "symlinks", mutation);
  }
  return { directories, files, symlinks, truncated: Boolean(payload?.truncated) };
}

function flattenListings(
  listings: Record<string, WorkspaceDirectoryListing>,
): WorkspaceDirectoryListing {
  const directories = new Set<string>();
  const files = new Set<string>();
  const symlinks = new Set<string>();
  let truncated = false;
  for (const listing of Object.values(listings)) {
    listing.directories.forEach((entry) => directories.add(entry));
    listing.files.forEach((entry) => files.add(entry));
    listing.symlinks.forEach((entry) => symlinks.add(entry));
    truncated ||= listing.truncated;
  }
  return {
    directories: [...directories].sort(compareWorkspacePaths),
    files: [...files].sort(compareWorkspacePaths),
    symlinks: [...symlinks].sort(compareWorkspacePaths),
    truncated,
  };
}

function workspaceFileListUrl(
  target: WorkspaceTarget,
  projectId: string | null | undefined,
  directory?: string,
): string {
  const params = new URLSearchParams();
  if (target.kind === "session" && projectId) params.set("projectId", projectId);
  if (directory !== undefined) params.set("directory", directory);
  const query = params.toString();
  return `${workspaceFileListPath(target)}${query ? `?${query}` : ""}`;
}

export function useWorkspaceFileList(
  selected: string | WorkspaceTarget | null,
  projectId?: string | null,
): WorkspaceFileListState & {
  loadDirectory: (directory: string, options?: WorkspaceDirectoryLoadOptions) => Promise<void>;
  loadFiles: (options?: WorkspaceDirectoryLoadOptions) => Promise<void>;
  refreshFiles: () => void;
  searchFiles: (query: string, options?: { signal?: AbortSignal }) => Promise<void>;
} {
  const targetKind = typeof selected === "string" ? "session" : selected?.kind;
  const targetId = typeof selected === "string" ? selected : selected?.id;
  const target = useMemo<WorkspaceTarget | null>(() => targetKind && targetId
    ? { kind: targetKind, id: targetId }
    : null, [targetId, targetKind]);
  const targetKey = target ? workspaceTargetKey(target) : null;
  const targetReady = Boolean(target && (target.kind === "worktree" || projectId));
  const [listings, setListings] = useState<Record<string, WorkspaceDirectoryListing>>({});
  const [listingTargetKey, setListingTargetKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(targetId));
  const [loadingDirectories, setLoadingDirectories] = useState<string[]>([]);
  const [workDir, setWorkDir] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<WorkspaceSearchResult>({
    directories: [], error: null, files: [], loading: false, symlinks: [], truncated: false,
  });
  const generationRef = useRef(0);
  const requestSeqByDirectoryRef = useRef(new Map<string, number>());
  const listingsRef = useRef(listings);
  listingsRef.current = listings;

  const loadDirectory = useCallback(async (
    rawDirectory: string,
    options?: WorkspaceDirectoryLoadOptions,
  ) => {
    if (!target || !targetReady) return;
    const directory = normalizeWorkspaceRelativePath(rawDirectory);
    const generation = generationRef.current;
    const requestSeq = (requestSeqByDirectoryRef.current.get(directory) ?? 0) + 1;
    requestSeqByDirectoryRef.current.set(directory, requestSeq);

    if (!options?.silent && directory === "") {
      setError(null);
      setLoading(true);
    }
    setLoadingDirectories((current) => current.includes(directory)
      ? current
      : [...current, directory]);

    try {
      let payload: WorkspaceFilesResponse | null = null;
      const attempts = options?.mutation ? MUTATION_LIST_ATTEMPTS : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const result = await fetchJsonWithTimeout<WorkspaceFilesResponse>(
          workspaceFileListUrl(target, projectId, directory),
          {
            cache: "no-store",
            signal: options?.signal,
            timeoutMs: FILE_LIST_LOAD_TIMEOUT_MS,
            retries: 1,
          },
        );
        payload = result.payload;
        if (!result.response.ok) throw new Error("Failed to load files.");
        if (!options?.mutation || payloadReflectsMutation(payload, options.mutation)) break;
      }

      if (
        generationRef.current !== generation
        || requestSeqByDirectoryRef.current.get(directory) !== requestSeq
      ) return;

      const nextListing = toListing(payload, options?.mutation);
      setListings((current) => {
        const next = { ...current, [directory]: nextListing };
        const previousChildren = current[directory]?.directories ?? [];
        const nextChildren = new Set(nextListing.directories);
        for (const removedDirectory of previousChildren) {
          if (nextChildren.has(removedDirectory)) continue;
          for (const loadedDirectory of Object.keys(next)) {
            if (isPathAtOrBelow(loadedDirectory, removedDirectory)) delete next[loadedDirectory];
          }
        }
        return next;
      });
      setWorkDir(payload?.workDir ?? null);
      if (directory === "") {
        setError(null);
        setListingTargetKey(targetKey);
        setLoading(false);
      }
    } catch (caught) {
      if (
        options?.signal?.aborted
        || generationRef.current !== generation
        || requestSeqByDirectoryRef.current.get(directory) !== requestSeq
      ) return;
      if (directory === "" && !options?.silent) {
        setError(isTimeoutError(caught)
          ? "The file list did not load in time."
          : caught instanceof Error ? caught.message : "Failed to load files.");
        setLoading(false);
        setListingTargetKey(targetKey);
      }
    } finally {
      if (
        generationRef.current === generation
        && requestSeqByDirectoryRef.current.get(directory) === requestSeq
      ) {
        setLoadingDirectories((current) => current.filter((entry) => entry !== directory));
      }
    }
  }, [projectId, target, targetKey, targetReady]);

  const loadFiles = useCallback((options?: WorkspaceDirectoryLoadOptions) =>
    loadDirectory("", options), [loadDirectory]);

  const refreshFiles = useCallback(() => {
    const loaded = Object.keys(listingsRef.current);
    void Promise.all((loaded.length ? loaded : [""]).map((directory) =>
      loadDirectory(directory, { silent: true })));
  }, [loadDirectory]);

  const searchFiles = useCallback(async (
    query: string,
    options?: { signal?: AbortSignal },
  ) => {
    if (!target || !targetReady || !query.trim()) {
      setSearchResult({
        directories: [], error: null, files: [], loading: false, symlinks: [], truncated: false,
      });
      return;
    }
    const generation = generationRef.current;
    setSearchResult((current) => ({ ...current, error: null, loading: true }));
    try {
      // The legacy recursive listing remains available for global search and
      // the @ reference picker, but it is no longer on the tab-open path.
      const result = await fetchJsonWithTimeout<WorkspaceFilesResponse>(
        workspaceFileListUrl(target, projectId),
        {
          cache: "no-store",
          signal: options?.signal,
          timeoutMs: FILE_LIST_LOAD_TIMEOUT_MS,
          retries: 1,
        },
      );
      if (!result.response.ok) throw new Error("Failed to search files.");
      if (generationRef.current !== generation || options?.signal?.aborted) return;
      setSearchResult({ ...toListing(result.payload), error: null, loading: false });
    } catch (caught) {
      if (generationRef.current !== generation || options?.signal?.aborted) return;
      setSearchResult({
        directories: [],
        error: isTimeoutError(caught)
          ? "The file search did not finish in time."
          : caught instanceof Error ? caught.message : "Failed to search files.",
        files: [],
        loading: false,
        symlinks: [],
        truncated: false,
      });
    }
  }, [projectId, target, targetReady]);

  useEffect(() => {
    generationRef.current += 1;
    requestSeqByDirectoryRef.current.clear();
    setListings({});
    setListingTargetKey(null);
    setError(null);
    setLoading(Boolean(target));
    setLoadingDirectories([]);
    setWorkDir(null);
    setSearchResult({
      directories: [], error: null, files: [], loading: false, symlinks: [], truncated: false,
    });
    if (!target || !targetReady) return;
    const abortController = new AbortController();
    void loadDirectory("", { signal: abortController.signal });
    return () => abortController.abort();
  }, [loadDirectory, target, targetKey, targetReady]);

  const flattened = useMemo(() => flattenListings(listings), [listings]);
  return {
    ...flattened,
    error,
    loadedDirectories: Object.keys(listings),
    loading: Boolean(target) && listingTargetKey !== targetKey ? true : loading,
    loadingDirectories,
    loadDirectory,
    loadFiles,
    refreshFiles,
    searchFiles,
    searchResult,
    workDir,
  };
}

export function workspaceFileListPath(target: WorkspaceTarget): string {
  return `${workspaceTargetApiPath(target)}/files`;
}
