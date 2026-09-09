import { useCallback, useEffect, useMemo, useRef } from "react";

export interface CommitSelectionRange {
  anchorPath: string;
  paths: readonly string[];
}

export interface CommitSelectionAnchor {
  path: string;
  targetKey: string | null;
}

export function resolveCommitSelectionAnchorPath(
  anchor: CommitSelectionAnchor | null,
  targetKey: string | null,
  visiblePaths: readonly string[],
): string | null {
  if (anchor?.targetKey !== targetKey) return null;
  return visiblePaths.includes(anchor.path) ? anchor.path : null;
}

/**
 * Resolve the paths affected by a commit checkbox interaction.
 *
 * A regular click establishes the range anchor. Shift-click keeps that anchor
 * and applies the clicked checkbox's next state to every visible file between
 * the two. If polling removed the anchor, the interaction safely falls back to
 * the clicked file and starts a new range.
 */
export function resolveCommitSelectionRange(
  visiblePaths: readonly string[],
  anchorPath: string | null,
  currentPath: string,
  extendRange: boolean,
): CommitSelectionRange {
  if (!extendRange) {
    return { anchorPath: currentPath, paths: [currentPath] };
  }

  if (anchorPath === null) {
    return { anchorPath: currentPath, paths: [currentPath] };
  }

  const anchorIndex = visiblePaths.indexOf(anchorPath);
  const currentIndex = visiblePaths.indexOf(currentPath);
  if (anchorIndex === -1 || currentIndex === -1) {
    return { anchorPath: currentPath, paths: [currentPath] };
  }

  const start = Math.min(anchorIndex, currentIndex);
  const end = Math.max(anchorIndex, currentIndex);
  return {
    anchorPath,
    paths: visiblePaths.slice(start, end + 1),
  };
}

export function eventExtendsCommitSelection(event: Event): boolean {
  return "shiftKey" in event && event.shiftKey === true;
}

export function useCommitFileSelection({
  allSelected,
  files,
  onSetSelected,
  someSelected,
  targetKey,
}: {
  allSelected: boolean;
  files: readonly { path: string }[] | undefined;
  onSetSelected: (paths: readonly string[], selected: boolean) => void;
  someSelected: boolean;
  targetKey: string | null;
}) {
  const anchorRef = useRef<CommitSelectionAnchor | null>(null);
  const visiblePaths = useMemo(
    () => files?.map((file) => file.path) ?? [],
    [files],
  );
  const mixed = someSelected && !allSelected;

  useEffect(() => {
    anchorRef.current = null;
  }, [targetKey]);

  useEffect(() => {
    if (resolveCommitSelectionAnchorPath(anchorRef.current, targetKey, visiblePaths) === null) {
      anchorRef.current = null;
    }
  }, [targetKey, visiblePaths]);

  // `indeterminate` is a DOM property, not an HTML attribute. A callback ref
  // applies it both on updates and when a conditional surface first mounts.
  const selectAllCheckboxRef = useCallback((node: HTMLInputElement | null) => {
    if (node) node.indeterminate = mixed;
  }, [mixed]);

  const setFileSelected = useCallback((
    path: string,
    selected: boolean,
    nativeEvent: Event,
  ) => {
    const anchorPath = resolveCommitSelectionAnchorPath(
      anchorRef.current,
      targetKey,
      visiblePaths,
    );
    const range = resolveCommitSelectionRange(
      visiblePaths,
      anchorPath,
      path,
      eventExtendsCommitSelection(nativeEvent),
    );
    anchorRef.current = { path: range.anchorPath, targetKey };
    onSetSelected(range.paths, selected);
  }, [onSetSelected, targetKey, visiblePaths]);

  return { selectAllCheckboxRef, setFileSelected };
}
