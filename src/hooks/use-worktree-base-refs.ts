import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import type { WorktreeCreationSource } from '@/lib/worktrees/create';

export type WorktreeCreationMode = WorktreeCreationSource['mode'];

export type WorktreeBaseRefKind = 'local' | 'remote' | 'detached';

export interface WorktreeBaseRef {
  name: string;
  label: string;
  kind: WorktreeBaseRefKind;
  current: boolean;
}

interface WorktreeBaseRefsResponse {
  refs?: WorktreeBaseRef[];
  error?: string;
}

export function resolveWorktreeCreationSource(
  mode: WorktreeCreationMode,
  selectedBaseRefForCreate: string | undefined,
  selectedRef: WorktreeBaseRef | null,
): WorktreeCreationSource | null {
  if (mode === 'checkout-branch') {
    return selectedRef ? { mode, branch: selectedRef.name } : null;
  }
  return { mode, baseRef: selectedBaseRefForCreate ?? null };
}

export function useWorktreeBaseRefs(projectDir: string | null | undefined) {
  const [refs, setRefs] = useState<WorktreeBaseRef[]>([]);
  const [selectedBaseRef, setSelectedBaseRef] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedProjectDir, setLoadedProjectDir] = useState<string | null>(null);
  const [hasUserSelectedBaseRef, setHasUserSelectedBaseRef] = useState(false);
  const [currentBaseRefName, setCurrentBaseRefName] = useState<string | null>(null);
  const [creationMode, setCreationMode] = useState<WorktreeCreationMode>('branch-off');

  useEffect(() => {
    if (!projectDir) {
      return;
    }

    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setIsLoading(true);
      setError(null);
      setHasUserSelectedBaseRef(false);
      setCurrentBaseRefName(null);
      setCreationMode('branch-off');
    });

    const params = new URLSearchParams({ projectDir });
    fetchWithClientId(`/api/worktrees/refs?${params.toString()}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as WorktreeBaseRefsResponse;
        if (!response.ok) {
          throw new Error(payload.error ?? 'Failed to load base branches');
        }
        return payload.refs ?? [];
      })
      .then((nextRefs) => {
        setLoadedProjectDir(projectDir);
        setRefs(nextRefs);
        const currentRef = nextRefs.find((ref) => ref['current']) ?? nextRefs[0] ?? null;
        setSelectedBaseRef(currentRef?.name ?? '');
        setCurrentBaseRefName(nextRefs.find((ref) => ref['current'])?.name ?? null);
        setHasUserSelectedBaseRef(false);
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        const message = loadError instanceof Error ? loadError.message : 'Failed to load base branches';
        setLoadedProjectDir(projectDir);
        setRefs([]);
        setSelectedBaseRef('');
        setHasUserSelectedBaseRef(false);
        setCurrentBaseRefName(null);
        setError(message);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => controller.abort();
  }, [projectDir]);

  const chooseBaseRef = useCallback((value: string) => {
    setSelectedBaseRef(value);
    setHasUserSelectedBaseRef(true);
  }, []);

  const chooseCreationMode = useCallback((mode: WorktreeCreationMode) => {
    setCreationMode(mode);
  }, []);

  const isStale = Boolean(projectDir && loadedProjectDir !== projectDir);
  const effectiveRefs = useMemo(
    () => projectDir && !isStale ? refs : [],
    [isStale, projectDir, refs],
  );
  const effectiveSelectedBaseRef = projectDir && !isStale ? selectedBaseRef : '';

  const selectedRef = useMemo(
    () => effectiveRefs.find((ref) => ref.name === effectiveSelectedBaseRef) ?? null,
    [effectiveRefs, effectiveSelectedBaseRef],
  );

  const selectedBaseRefForCreate =
    hasUserSelectedBaseRef
      && effectiveSelectedBaseRef
      && effectiveSelectedBaseRef !== currentBaseRefName
      ? effectiveSelectedBaseRef
      : undefined;
  const worktreeSourceForCreate = useMemo(
    () => resolveWorktreeCreationSource(
      creationMode,
      selectedBaseRefForCreate,
      selectedRef,
    ),
    [creationMode, selectedBaseRefForCreate, selectedRef],
  );

  return {
    refs: effectiveRefs,
    selectedBaseRef: effectiveSelectedBaseRef,
    selectedBaseRefForCreate,
    selectedRef,
    setSelectedBaseRef: chooseBaseRef,
    creationMode,
    setCreationMode: chooseCreationMode,
    worktreeSourceForCreate,
    isLoading: Boolean(projectDir) && (isLoading || isStale),
    error: projectDir && !isStale ? error : null,
  };
}
