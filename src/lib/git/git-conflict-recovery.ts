import type {
  GitChangedFile,
  GitConflictOperation,
  GitPanelData,
} from '@/types/git';

export interface GitConflictRecovery {
  operation: GitConflictOperation;
  unresolvedFiles: GitChangedFile[];
  unresolvedFilesTruncated: boolean;
}

/**
 * The focused recovery model for an unfinished Git operation. The panel's
 * changed-file payload is the authority for unresolved paths: status entries
 * classified as `conflicted` are the paths Git still requires the user to
 * review, while ordinary modifications may already have been resolved.
 */
export function deriveGitConflictRecovery(
  data: GitPanelData | null | undefined,
): GitConflictRecovery | null {
  const operation = data?.conflictOperation;
  if (!data || !operation) return null;

  return {
    operation,
    unresolvedFiles: data.changedFiles.filter((file) => file.state === 'conflicted'),
    unresolvedFilesTruncated: Boolean(data.changedFilesTruncated),
  };
}
