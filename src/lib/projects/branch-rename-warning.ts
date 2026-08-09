import { readUiStorageItem, writeUiStorageItem } from '@/lib/persistence/ui-storage';

export interface ProjectBranchRenameWarning {
  previousBranch: string;
  currentBranch: string;
  /** Opaque identity for this exact reflog event; never used to mutate scope. */
  eventId: string;
}

function dismissalStorageKey(
  projectId: string,
  warning: ProjectBranchRenameWarning,
): string {
  const identity = [
    projectId,
    warning.previousBranch,
    warning.currentBranch,
    warning.eventId,
  ].map(encodeURIComponent).join(':');
  return `tessera:branch-rename-warning:dismissed:v2:${identity}`;
}

export function isBranchRenameWarningDismissed(
  projectId: string,
  warning: ProjectBranchRenameWarning,
): boolean {
  return readUiStorageItem(dismissalStorageKey(projectId, warning)) === '1';
}

export function persistBranchRenameWarningDismissal(
  projectId: string,
  warning: ProjectBranchRenameWarning,
): void {
  writeUiStorageItem(dismissalStorageKey(projectId, warning), '1');
}
