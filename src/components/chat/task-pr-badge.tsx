'use client';

/**
 * Task card status indicators:
 *
 *   [ ☁ remote ]  [ <GitIcon> #123 ]
 *
 *   - RemoteBranchIcon : Cloud when the branch is on origin; CloudOff only
 *     when an open/merged PR has lost its branch. Silent otherwise.
 *   - PrIndicator      : state-specific Octicons (open / merged / closed)
 *     + #number when a PR exists, hidden when the task has no PR yet.
 *
 * The caller decorates the card itself (e.g. left-edge stripe) when
 * `detectPrMismatch` reports a mismatch; this component no longer renders
 * its own warning pill.
 */

import { memo } from 'react';
import {
  Cloud,
  CloudOff,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkflowStatus } from '@/types/task-entity';
import type { TaskPrStatus } from '@/types/task-pr-status';
import { useI18n } from '@/lib/i18n';

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * Only surface a warning when the task's column claim is AHEAD of the actual
 * PR progression — the user has pushed the card forward in the kanban before
 * reality caught up. Tasks that lag behind (e.g. a still-Doing card whose PR
 * has been merged) stay quiet; the user will move them along when ready.
 */
export type MismatchKind =
  | 'review_missing'  // Review column claimed but no PR opened yet
  | 'done_open'       // Done column claimed but PR still open
  | 'done_missing'    // Done column claimed but no PR at all
  | null;

export function detectPrMismatch(
  workflowStatus: WorkflowStatus,
  prStatus: TaskPrStatus | undefined,
): MismatchKind {
  if (workflowStatus === 'in_review') {
    if (!prStatus) return 'review_missing';
    return null;
  }
  if (workflowStatus === 'done') {
    if (!prStatus) return 'done_missing';
    if (prStatus.state === 'open') return 'done_open';
    return null;
  }
  return null;
}

export function prMismatchTooltip(kind: MismatchKind, prNumber?: number, t?: TranslateFn): string {
  return mismatchTooltip(kind, prNumber, t);
}

function mismatchTooltip(kind: MismatchKind, prNumber?: number, t?: TranslateFn): string {
  switch (kind) {
    case 'review_missing':
      return t?.('task.prMismatch.reviewMissing') ?? 'Review status but no linked PR — open a PR or move the card back';
    case 'done_open':
      return prNumber
        ? (t?.('task.prMismatch.doneOpenWithPr', { prNumber }) ?? `Done status but PR #${prNumber} is still open — merge is not complete`)
        : (t?.('task.prMismatch.doneOpen') ?? 'Done status but the PR is still open — merge is not complete');
    case 'done_missing':
      return t?.('task.prMismatch.doneMissing') ?? 'Done status but no linked PR — confirm the work is actually complete';
    default:
      return '';
  }
}

/* -------------------------------------------------------------------------- */
/* Remote branch icon                                                         */
/* -------------------------------------------------------------------------- */

function RemoteBranchIcon({
  present,
  tooltip,
}: {
  present: boolean;
  tooltip: string;
}) {
  const Icon = present ? Cloud : CloudOff;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center cursor-help text-(--text-muted)',
        present ? 'opacity-80' : 'opacity-45',
      )}
      title={tooltip}
      data-testid="task-remote-indicator"
      data-present={present}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2} />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* PR indicator                                                               */
/* -------------------------------------------------------------------------- */

function PrIndicator({ prStatus }: { prStatus: TaskPrStatus | undefined }) {
  const { t, language } = useI18n();
  if (!prStatus) return null;

  // GitHub-standard state icons + colors (Octicons 2021 convention):
  //   open → GitPullRequest (녹), merged → GitMerge (보라), closed → GitPullRequestClosed (빨).
  const { Icon, textClass } =
    prStatus.state === 'open'
      ? { Icon: GitPullRequest, textClass: 'text-(--status-success-text)' }
      : prStatus.state === 'merged'
      ? { Icon: GitMerge, textClass: 'text-(--pr-merged-text)' }
      : { Icon: GitPullRequestClosed, textClass: 'text-(--status-error-text)' };

  const stateLabel =
    prStatus.state === 'open'
      ? t('task.prStatus.open')
      : prStatus.state === 'merged'
      ? t('task.prStatus.merged')
      : t('task.prStatus.closed');

  const mergedLine = prStatus.mergedAt
    ? `\n${t('task.prStatus.mergedAt', { date: new Date(prStatus.mergedAt).toLocaleString(language) })}`
    : '';
  const syncedLine = prStatus.lastSynced
    ? `\n${t('task.prStatus.lastSynced', { date: new Date(prStatus.lastSynced).toLocaleString(language) })}`
    : '';

  return (
    <a
      href={prStatus.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex items-center gap-1 text-[0.6875rem] font-medium leading-none no-underline cursor-pointer opacity-90',
        textClass,
      )}
      title={`${t('task.prStatus.title', { number: prStatus.number, state: stateLabel })}${mergedLine}${syncedLine}`}
      data-testid="task-pr-indicator"
      data-state={prStatus.state}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2} />
      <span>#{prStatus.number}</span>
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/* Aggregate badge                                                            */
/* -------------------------------------------------------------------------- */

interface TaskPrBadgeProps {
  workflowStatus: WorkflowStatus;
  prStatus?: TaskPrStatus;
  prUnsupported?: boolean;
  /**
   * Server-reported presence of the task's branch on origin. `undefined`
   * means we haven't synced yet — skip the remote icon rather than falsely
   * flipping between states.
   */
  remoteBranchExists?: boolean;
  /** Local branch name, surfaced in the remote-branch tooltip. */
  branchName?: string;
  className?: string;
}

function TaskPrBadgeImpl({
  workflowStatus,
  prStatus,
  prUnsupported,
  remoteBranchExists,
  branchName,
  className,
}: TaskPrBadgeProps) {
  const { t } = useI18n();
  // Non-GitHub / gh-missing tasks: render nothing (status layer opts out).
  if (prUnsupported) return null;

  const mismatch = detectPrMismatch(workflowStatus, prStatus);

  // Remote branch display rules:
  //  - Present: always show the Cloud icon (reassures branch is pushed).
  //  - Absent: only show CloudOff when it actually signals a problem — an
  //    open or merged PR that has lost its branch on origin.
  const branchLabel = branchName ? `origin/${branchName}` : t('task.prStatus.remoteBranch');
  let remoteIcon: { present: boolean; tooltip: string } | null = null;
  if (remoteBranchExists === true) {
    remoteIcon = {
      present: true,
      tooltip: `${branchLabel}\n${t('task.prStatus.pushedToOrigin')}`,
    };
  } else if (
    remoteBranchExists === false &&
    (prStatus?.state === 'open' || prStatus?.state === 'merged')
  ) {
    const why =
      prStatus.state === 'open'
        ? t('task.prStatus.openBranchMissing', { prNumber: prStatus.number })
        : t('task.prStatus.mergedBranchDeleted', { prNumber: prStatus.number });
    remoteIcon = {
      present: false,
      tooltip: `${branchLabel}\n${why}`,
    };
  }

  return (
    <span
      className={cn('inline-flex items-center gap-1.5', className)}
      data-testid="task-pr-badge"
      data-mismatch-kind={mismatch ?? undefined}
    >
      {remoteIcon && <RemoteBranchIcon present={remoteIcon.present} tooltip={remoteIcon.tooltip} />}
      <PrIndicator prStatus={prStatus} />
    </span>
  );
}

export const TaskPrBadge = memo(TaskPrBadgeImpl);
