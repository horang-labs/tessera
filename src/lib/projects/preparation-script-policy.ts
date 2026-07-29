/**
 * Policy for what a project's stored preparation script means.
 *
 * A preparation script belongs to a project and is inherited by every worktree
 * created from it. Storage is the only concern here: whether a stored value
 * counts as a script at all, and what the canonical form of that value is.
 * Running the script is not this module's business.
 */

/**
 * Reduce a preparation script to the form worth storing.
 *
 * Blank input — never written, cleared, or whitespace only — collapses to
 * `null` so that "no preparation script" has exactly one representation.
 * Line endings become newlines so that a script written on Windows reads back
 * the same as one written anywhere else; indentation inside the script is left
 * untouched because it is part of what the user wrote.
 */
export function normalizePreparationScript(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const normalized = raw.replace(/\r\n?/g, '\n').trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Whether a project has a preparation script to run.
 */
export function hasPreparationScript(stored: string | null | undefined): boolean {
  return normalizePreparationScript(stored) !== null;
}
