import type { GitChangedFile } from "@/types/git";

/**
 * Which changed file can be reverted (its working tree restored to HEAD, or
 * deleted outright when it has no HEAD version).
 *
 * Centralised so the revert button's eligibility, the server-side guard and the
 * tests all agree on one rule (`docs/design/git-delivery.md` §2).
 *
 * A conflicted file is excluded: reverting it would not resolve the conflict,
 * and the current `git status` record is the only live signal the conflict UI
 * reads. A file that is only staged (and not untracked) is excluded too — the
 * panel has no staging UI (§5), so such a change was made outside it, and
 * reverting it would silently throw away work the panel never showed.
 */
export function canRevertFile(file: GitChangedFile): boolean {
  if (file.state === "conflicted") return false;
  if (file.state === "untracked") return true;
  if (file.staged && !file.unstaged) return false;
  return true;
}
