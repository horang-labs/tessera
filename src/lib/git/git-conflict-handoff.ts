import { deriveGitConflictRecovery } from '@/lib/git/git-conflict-recovery';
import type { GitPanelRead } from '@/lib/git/git-panel-read';
import type { UnifiedSession } from '@/types/chat';
import type { GitPanelData } from '@/types/git';

const CONFLICT_HANDOFF_PROVIDERS: ReadonlySet<string> = new Set([
  'claude-code',
  'codex',
  'opencode',
]);

export type GitConflictHandoffResult =
  | { kind: 'ready'; data: GitPanelData; request: string }
  | { kind: 'stale'; data: GitPanelData }
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string };

export function deriveGitConflictHandoffAvailability(
  data: GitPanelData | null | undefined,
  session: UnifiedSession | null | undefined,
): boolean {
  const recovery = deriveGitConflictRecovery(data);
  return Boolean(
    data
    && session
    && data.sessionId === session.id
    && CONFLICT_HANDOFF_PROVIDERS.has(session.provider?.trim() ?? '')
    && session.kind !== 'terminal'
    && !session.archived
    && !session.isReadOnly
    && recovery
    && !recovery.unresolvedFilesTruncated
    && recovery.unresolvedFiles.length > 0,
  );
}

export function buildGitConflictResolutionRequest(data: GitPanelData): string {
  const recovery = deriveGitConflictRecovery(data);
  if (!recovery || recovery.unresolvedFiles.length === 0) {
    throw new Error('Conflict recovery is no longer available.');
  }

  const paths = recovery.unresolvedFiles
    .map((file) => `- ${JSON.stringify(file.path)}`)
    .join('\n');

  return [
    'Help resolve the current Git conflicts in this worktree.',
    '',
    `Worktree: ${JSON.stringify(data.worktreePath)}`,
    `Operation: ${recovery.operation}`,
    'Unresolved paths:',
    paths,
    '',
    'Inspect the listed paths, resolve their conflict markers, and leave the changes for me to review.',
    `Do not continue the ${operationCommand(recovery.operation)} or commit.`,
  ].join('\n');
}

export async function revalidateGitConflictHandoff(
  expected: GitPanelData,
  session: UnifiedSession | null | undefined,
  readLatest: () => Promise<GitPanelRead>,
): Promise<GitConflictHandoffResult> {
  if (!deriveGitConflictHandoffAvailability(expected, session)) {
    return { kind: 'unavailable' };
  }

  const latest = await readLatest();
  if (latest.kind === 'session_missing') return { kind: 'unavailable' };
  if (latest.kind === 'failed') return latest;

  if (
    !deriveGitConflictHandoffAvailability(latest.data, session)
    || conflictFingerprint(latest.data) !== conflictFingerprint(expected)
  ) {
    return { kind: 'stale', data: latest.data };
  }

  return {
    kind: 'ready',
    data: latest.data,
    request: buildGitConflictResolutionRequest(latest.data),
  };
}

function conflictFingerprint(data: GitPanelData): string {
  const recovery = deriveGitConflictRecovery(data);
  if (!recovery) return '';
  return JSON.stringify({
    operation: recovery.operation,
    paths: recovery.unresolvedFiles.map((file) => file.path).sort(),
    worktreePath: data.worktreePath,
  });
}

function operationCommand(operation: NonNullable<GitPanelData['conflictOperation']>): string {
  if (operation === 'cherry_pick') return 'cherry-pick';
  return operation;
}
