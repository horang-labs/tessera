/**
 * Which Git action the user reached for last (`docs/design/git-delivery.md` §4).
 *
 * Kept in `localStorage` rather than on the session or the worktree: §4 asks for
 * it so that "a workflow repeated all day is not re-selected every time", and a
 * day's work in Tessera spans many sessions and several worktrees. Per-session
 * memory would forget on exactly the switch it is meant to survive.
 *
 * It is a preference, not state the product acts on — nothing here decides what
 * runs, only where an entry sits in the menu — so losing it costs a reordering
 * and nothing else. That is why every path fails quiet.
 */
import {
  GIT_MENU_ACTION_IDS,
  type GitDeliveryMenuActionId,
} from './git-action-menu';

export const GIT_ACTION_MEMORY_KEY = 'tessera:git:last-action';

/**
 * Null both when nothing has been chosen yet and when what is stored is not a
 * delivery action this version has. A name that outlived its action must read as
 * nothing rather than promote an entry the menu cannot draw. §9's abort is not
 * one of these: it is not a workflow to repeat, and it is not drawn at all
 * unless the worktree is in one.
 */
export function readRememberedGitAction(): GitDeliveryMenuActionId | null {
  if (typeof window === 'undefined') return null;

  try {
    const stored = window.localStorage.getItem(GIT_ACTION_MEMORY_KEY);
    return isGitMenuActionId(stored) ? stored : null;
  } catch {
    // Storage can be denied outright — a locked-down browser profile, a private
    // window with quota off. The menu draws in its resting order and works.
    return null;
  }
}

export function rememberGitAction(id: GitDeliveryMenuActionId): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(GIT_ACTION_MEMORY_KEY, id);
  } catch {
    // Failing to remember must never fail the action the user just chose.
  }
}

function isGitMenuActionId(value: unknown): value is GitDeliveryMenuActionId {
  return (
    typeof value === 'string'
    && (GIT_MENU_ACTION_IDS as readonly string[]).includes(value)
  );
}
