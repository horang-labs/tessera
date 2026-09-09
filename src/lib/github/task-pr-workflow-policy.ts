import type { WorkflowStatus } from '@/types/task-entity';
import { isCurrentTaskPr, type TaskPrStatus } from '@/types/task-pr-status';

/**
 * The workflow state implied by the task's current pull request.
 *
 * A successful PR probe is authoritative for these two states. Historical and
 * closed pull requests describe earlier revisions, so they never move the
 * current task. Returning the target independently of the task's current
 * workflow lets every successful sync converge manual moves back to GitHub.
 */
export function deriveTaskWorkflowStatusFromPr(
  prStatus: TaskPrStatus | null | undefined,
): WorkflowStatus | undefined {
  if (!prStatus || !isCurrentTaskPr(prStatus)) return undefined;
  if (prStatus.state === 'open') return 'in_review';
  if (prStatus.state === 'merged') return 'done';
  return undefined;
}
