export interface WorkspaceKeyRow {
  path: string;
  type: 'file' | 'directory';
  name: string;
}

export type WorkspaceTreeKeyAction =
  | { type: 'focus'; path: string; extend: boolean }
  | { type: 'expand'; path: string }
  | { type: 'collapse'; path: string };

function parentPath(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

/**
 * Arrow-key navigation for the explorer tree, the way every file explorer does
 * it: up/down walk the visible rows, right opens a folder or steps into it, left
 * closes it or steps out to its parent, Home/End jump to the ends.
 *
 * Returns null for a key the tree does not own, so the caller leaves it alone.
 */
export function resolveWorkspaceTreeKey(input: {
  key: string;
  shiftKey: boolean;
  rows: readonly WorkspaceKeyRow[];
  expanded: ReadonlySet<string>;
  current: string | null;
  searching: boolean;
}): WorkspaceTreeKeyAction | null {
  const { key, rows, expanded, current, searching } = input;
  if (rows.length === 0) return null;
  const index = current ? rows.findIndex((row) => row.path === current) : -1;
  const row = index === -1 ? null : rows[index];
  const focus = (target: WorkspaceKeyRow | undefined): WorkspaceTreeKeyAction | null =>
    target ? { type: 'focus', path: target.path, extend: input.shiftKey } : null;

  switch (key) {
    case 'ArrowDown':
      return focus(rows[index === -1 ? 0 : Math.min(index + 1, rows.length - 1)]);
    case 'ArrowUp':
      return focus(rows[index === -1 ? 0 : Math.max(index - 1, 0)]);
    case 'Home':
      return focus(rows[0]);
    case 'End':
      return focus(rows[rows.length - 1]);
    case 'ArrowRight': {
      if (!row || row.type !== 'directory' || searching) return null;
      if (!expanded.has(row.path)) return { type: 'expand', path: row.path };
      const child = rows[index + 1];
      return child && parentPath(child.path) === row.path
        ? { type: 'focus', path: child.path, extend: false }
        : null;
    }
    case 'ArrowLeft': {
      if (!row) return null;
      if (row.type === 'directory' && expanded.has(row.path) && !searching) {
        return { type: 'collapse', path: row.path };
      }
      const parent = parentPath(row.path);
      return parent && rows.some((candidate) => candidate.path === parent)
        ? { type: 'focus', path: parent, extend: false }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Type-ahead: the next row after `current` whose name starts with what was
 * typed, wrapping around. A repeated single letter cycles through the rows
 * that share it.
 */
export function findWorkspaceTypeAheadMatch(
  rows: readonly WorkspaceKeyRow[],
  current: string | null,
  buffer: string,
): string | null {
  if (!buffer || rows.length === 0) return null;
  const needle = buffer.toLowerCase();
  const start = current ? rows.findIndex((row) => row.path === current) : -1;
  const repeated = needle.length > 1 && [...needle].every((char) => char === needle[0]);
  const prefix = repeated ? needle[0] : needle;
  // A growing prefix may still match the current row; a repeated letter
  // must move on from it.
  const first = start === -1 ? 0 : (repeated || needle.length === 1 ? start + 1 : start);
  for (let offset = 0; offset < rows.length; offset += 1) {
    const row = rows[(first + offset) % rows.length];
    if (row.name.toLowerCase().startsWith(prefix)) return row.path;
  }
  return null;
}
