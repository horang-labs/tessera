/**
 * The script a run actually ran, spelled the way it ran.
 *
 * A stored preparation script is written against Tessera's variables, so read
 * back on its own it says `$TESSERA_PROJECT_DIR` where the interesting part is
 * which directory that was. The log already shows the expanded form — the
 * shell's own trace does that — and a script shown beside it has to agree.
 *
 * Only the variables Tessera sets are expanded. Anything else in the script is
 * the user's shell environment, which this has no honest way to know: a guess
 * shown as fact is worse than the variable left standing.
 */

import {
  PREPARATION_BRANCH_NAME_ENV,
  PREPARATION_PROJECT_DIR_ENV,
  PREPARATION_WORKTREE_DIR_ENV,
} from './preparation-environment';

/** The names a run supplies, in every spelling a script can reach them by. */
const EXPANDABLE = [
  PREPARATION_PROJECT_DIR_ENV,
  PREPARATION_WORKTREE_DIR_ENV,
  PREPARATION_BRANCH_NAME_ENV,
] as const;

/**
 * `$NAME` stops at a character that could continue the name, so a longer
 * variable starting with a shorter one's letters is left alone. `${NAME}` and
 * `%NAME%` carry their own terminator.
 */
function occurrencesOf(name: string): RegExp {
  return new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])|%${name}%`, 'g');
}

export function expandPreparationVariables(
  script: string,
  values: Partial<Record<string, string>>,
): string {
  let expanded = script;
  for (const name of EXPANDABLE) {
    const value = values[name];
    if (value === undefined) continue;
    // A function replacement, so a `$` in the value is a character rather than
    // a back-reference into whatever matched.
    expanded = expanded.replace(occurrencesOf(name), () => value);
  }
  return expanded;
}
