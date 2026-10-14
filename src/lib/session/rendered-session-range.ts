/**
 * Shift+Click range order taken from the rows that are actually on screen.
 *
 * The sidebar's data-derived ordering drifted from what it renders: the All
 * Projects list ordered by each Session's project-wide sortOrder, which
 * interleaves rows of unrelated Worktrees and chats, and collapsed groups or
 * "show more" caps still contributed hidden rows. Reading the rendered rows
 * in document order selects exactly the rows between the two clicks.
 */

/** Marks a row that Shift+Click may include. The value is the Session id. */
export const SESSION_RANGE_ROW_ATTRIBUTE = 'data-session-range-id';
/** Marks a list whose rows form one range. Nested scopes are independent. */
export const SESSION_RANGE_SCOPE_ATTRIBUTE = 'data-session-range-scope';

const ROW_SELECTOR = `[${SESSION_RANGE_ROW_ATTRIBUTE}]`;
const SCOPE_SELECTOR = `[${SESSION_RANGE_SCOPE_ATTRIBUTE}]`;

interface RangeElement {
  closest(selector: string): RangeElement | null;
  querySelectorAll(selector: string): ArrayLike<RangeElement>;
  getAttribute(name: string): string | null;
}

function isRangeElement(value: unknown): value is RangeElement {
  return typeof value === 'object'
    && value !== null
    && typeof (value as RangeElement).closest === 'function';
}

/**
 * Returns the Session ids rendered in the clicked row's range scope, in
 * document order, or null when the click did not come from a scoped row.
 */
export function getRenderedSessionRangeIds(target: unknown): string[] | null {
  if (!isRangeElement(target)) return null;
  const row = target.closest(ROW_SELECTOR);
  const scope = row?.closest(SCOPE_SELECTOR);
  if (!scope) return null;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.from(scope.querySelectorAll(ROW_SELECTOR))) {
    // A nested scope (Recent Work inside the sidebar) owns its own rows.
    if (candidate.closest(SCOPE_SELECTOR) !== scope) continue;
    const id = candidate.getAttribute(SESSION_RANGE_ROW_ATTRIBUTE);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
