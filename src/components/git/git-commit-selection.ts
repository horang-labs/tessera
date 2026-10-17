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

/** A row the commit checkbox can act on: a file, or a folder standing for its files. */
export interface CommitSelectionItem {
  path: string;
  /** The files a folder row stands for; a file row stands for itself. */
  filePaths?: readonly string[];
}

/** Expand rows into the distinct files they stand for, in row order. */
export function expandCommitSelectionItems(
  items: readonly CommitSelectionItem[],
  rowPaths: readonly string[],
): string[] {
  const byPath = new Map(items.map((item) => [item.path, item]));
  const files = new Set<string>();
  for (const rowPath of rowPaths) {
    for (const filePath of byPath.get(rowPath)?.filePaths ?? [rowPath]) files.add(filePath);
  }
  return [...files];
}

/** JetBrains' toggle rule: include everything unless everything is already included. */
export function nextCommitInclusion(
  filePaths: readonly string[],
  isIncluded: (path: string) => boolean,
): boolean {
  return !filePaths.every(isIncluded);
}

export interface CommitTreeRow {
  path: string;
  depth: number;
  kind: "file" | "folder";
}

export type CommitTreeKeyTarget =
  | { kind: "move"; index: number }
  | { kind: "toggle"; path: string }
  | null;

/**
 * Where a tree navigation key goes from the row at `index`, following the
 * WAI-ARIA tree pattern that JetBrains and VS Code share: Right expands a
 * collapsed folder or steps into an expanded one, Left collapses an expanded
 * folder or climbs to the parent.
 */
export function resolveCommitTreeKeyTarget(
  rows: readonly CommitTreeRow[],
  index: number,
  key: string,
  isExpanded: (path: string) => boolean,
): CommitTreeKeyTarget {
  if (rows.length === 0) return null;
  if (index < 0 || index >= rows.length) {
    return key === "ArrowUp" || key === "End"
      ? { kind: "move", index: rows.length - 1 }
      : { kind: "move", index: 0 };
  }
  const row = rows[index];
  switch (key) {
    case "ArrowDown":
      return { kind: "move", index: Math.min(index + 1, rows.length - 1) };
    case "ArrowUp":
      return { kind: "move", index: Math.max(index - 1, 0) };
    case "Home":
      return { kind: "move", index: 0 };
    case "End":
      return { kind: "move", index: rows.length - 1 };
    case "ArrowRight":
      if (row.kind !== "folder") return null;
      if (!isExpanded(row.path)) return { kind: "toggle", path: row.path };
      return rows[index + 1]?.depth > row.depth ? { kind: "move", index: index + 1 } : null;
    case "ArrowLeft": {
      if (row.kind === "folder" && isExpanded(row.path)) return { kind: "toggle", path: row.path };
      for (let parent = index - 1; parent >= 0; parent -= 1) {
        if (rows[parent].depth < row.depth) return { kind: "move", index: parent };
      }
      return null;
    }
    default:
      return null;
  }
}

export function useCommitFileSelection({
  allSelected,
  files,
  onSetSelected,
  someSelected,
  targetKey,
}: {
  allSelected: boolean;
  files: readonly CommitSelectionItem[] | undefined;
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

  /**
   * `group` is the multi-row selection the clicked row belongs to, if any:
   * like JetBrains, ticking one selected row ticks every selected row.
   */
  const setFileSelected = useCallback((
    path: string,
    selected: boolean,
    nativeEvent: Event,
    group?: readonly string[],
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
    const rows = range.paths.length === 1 && group && group.length > 1 && group.includes(path)
      ? group
      : range.paths;
    onSetSelected(expandCommitSelectionItems(files ?? [], rows), selected);
  }, [files, onSetSelected, targetKey, visiblePaths]);

  return { selectAllCheckboxRef, setFileSelected };
}
