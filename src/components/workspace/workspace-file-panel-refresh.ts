interface ReselectedWorktreeReloadInput {
  currentTargetKey: string | null;
  isWorktreeTarget: boolean;
  peekChanged: boolean;
  peekWorktreeId: string | null;
  previousTargetKey: string | null;
  targetId: string | null;
}

/**
 * The file-list hook owns initial loads and target changes. This extra reload
 * exists only for reselecting the Worktree already shown in Peek, because a
 * Worktree panel has no Session watcher to refresh it while it is hidden.
 */
export function shouldReloadReselectedWorktree({
  currentTargetKey,
  isWorktreeTarget,
  peekChanged,
  peekWorktreeId,
  previousTargetKey,
  targetId,
}: ReselectedWorktreeReloadInput): boolean {
  return isWorktreeTarget
    && currentTargetKey === previousTargetKey
    && peekChanged
    && peekWorktreeId === targetId;
}
