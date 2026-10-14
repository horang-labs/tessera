/**
 * Shared horizontal grid for the List sidebar tree, modelled on a file explorer.
 *
 * Every row is `[twistie][icon][label]` inside the same gutter. Expandable rows
 * draw a chevron in the twistie slot; leaf rows keep the slot empty so labels
 * on one level stay aligned. Each level adds exactly one 12px indent, and the
 * child container draws an indent guide under the parent row's chevron:
 * gutter 8px + half the 14px twistie - 12px indent = 3px.
 */
export const SIDEBAR_TREE_ROW_GUTTER = 'mx-0 px-2';
export const SIDEBAR_TREE_ROW_SPACING = 'gap-1.5 py-1';
export const SIDEBAR_TREE_CHILD_INDENT = 'ml-3';
export const SIDEBAR_TREE_TWISTIE_SLOT = 'flex h-3.5 w-3.5 shrink-0 items-center justify-center';
export const SIDEBAR_TREE_LEADING_SLOT = 'flex h-3.5 w-3.5 shrink-0 items-center justify-center';
export const SIDEBAR_TREE_INDENT_GUIDE =
  'pointer-events-none absolute inset-y-0 left-[3px] w-px bg-(--divider)';
export const SIDEBAR_TREE_CHEVRON =
  'h-3.5 w-3.5 text-(--text-muted) transition-transform duration-150';
export const SIDEBAR_TREE_WORKTREE_CARD_CHILD_BRANCH = 'ml-2';
export const SIDEBAR_TREE_WORKTREE_CHILD_CONNECTOR_OFFSET = 'left-0';
