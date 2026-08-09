import { readUiStorageItem, writeUiStorageItem } from '@/lib/persistence/ui-storage';

export interface ProjectBranchRenameWarning {
  previousBranch: string;
  currentBranch: string;
}

function dismissalStorageKey(
  projectId: string,
  warning: ProjectBranchRenameWarning,
): string {
  const identity = [
    projectId,
    warning.previousBranch,
    warning.currentBranch,
  ].map(encodeURIComponent).join(':');
  return `tessera:branch-rename-warning:dismissed:v1:${identity}`;
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
