/**
 * The names a preparation script knows its surroundings by.
 *
 * They live apart from the module that builds the runner so that anything
 * merely writing a script — the editor in the settings panel, the checklist
 * that fills it in — can name them without pulling in the shell and path
 * machinery that only running a script needs.
 */

/** The original checkout the worktree was created from. */
export const PREPARATION_PROJECT_DIR_ENV = 'TESSERA_PROJECT_DIR';
/** The new worktree, which is also the script's working directory. */
export const PREPARATION_WORKTREE_DIR_ENV = 'TESSERA_WORKTREE_DIR';
/** The branch the new worktree checked out. */
export const PREPARATION_BRANCH_NAME_ENV = 'TESSERA_BRANCH_NAME';
