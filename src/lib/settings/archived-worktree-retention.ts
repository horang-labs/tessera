import type { UserSettings } from './types';

export function shouldPruneArchivedWorktreesForSettingsUpdate(
  previous: UserSettings,
  next: UserSettings,
): boolean {
  if (!next.autoDeleteArchivedWorktrees) {
    return false;
  }

  return previous.autoDeleteArchivedWorktrees !== next.autoDeleteArchivedWorktrees
    || previous.archivedWorktreeRetentionDays !== next.archivedWorktreeRetentionDays;
}

export function requiresArchivedWorktreeRetentionConfirmation(
  previous: Pick<UserSettings, 'autoDeleteArchivedWorktrees' | 'archivedWorktreeRetentionDays'>,
  next: Pick<UserSettings, 'autoDeleteArchivedWorktrees' | 'archivedWorktreeRetentionDays'>,
): boolean {
  if (!next.autoDeleteArchivedWorktrees) {
    return false;
  }

  if (!previous.autoDeleteArchivedWorktrees) {
    return true;
  }

  return next.archivedWorktreeRetentionDays < previous.archivedWorktreeRetentionDays;
}
