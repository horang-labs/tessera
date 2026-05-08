/**
 * Task entity types for workflow management.
 *
 * Tasks use 'task_' prefixed IDs and group multiple sessions into a single
 * work unit tied to a worktree branch.
 *
 * NOTE: WorkflowStatus is intentionally separate from sidebar status groups
 * (defined in task.ts). Sidebar groups govern UI buckets like `chat`/`todo`,
 * while WorkflowStatus governs task-level workflow progression.
 */

/** Workflow status for tasks (not for chat sessions). */
export type WorkflowStatus = 'todo' | 'in_progress' | 'in_review' | 'done';

export const WORKFLOW_STATUS_ORDER: WorkflowStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

export const WORKFLOW_STATUS_CONFIG: Record<WorkflowStatus, { label: string; color: string }> = {
  todo: { label: 'Todo', color: 'var(--workflow-todo)' },
  in_progress: { label: 'Doing', color: 'var(--workflow-doing)' },
  in_review: { label: 'Review', color: 'var(--workflow-review)' },
  done: { label: 'Done', color: 'var(--workflow-done)' },
};

export interface TaskEntity {
  id: string;              // 'task_<uuid>'
  projectId: string;
  title: string;
  collectionId?: string;   // FK -> collections.id
  workflowStatus: WorkflowStatus;
  worktreeBranch?: string;
  workDir?: string;        // Working directory (from first session's work_dir)
  /** True when Tessera recorded this worktree as app-managed. */
  worktreeManaged?: boolean;
  archived?: boolean;
  archivedAt?: string;
  worktreeDeletedAt?: string;
  /** True when the recorded worktree path no longer exists on disk. */
  worktreeMissing?: boolean;
  summary?: string;        // Original chat context summary
  sortOrder: number;       // Display order within collection
  sessions: TaskSession[]; // Child session list
  createdAt: string;
  updatedAt: string;
  /** Worktree diff stats (+/−). Populated asynchronously; undefined until known. */
  diffStats?: import('./worktree-diff-stats').WorktreeDiffStats | null;
  /** Latest known GitHub PR for the task branch. */
  prStatus?: import('./task-pr-status').TaskPrStatus;
  /** True when PR sync is not applicable (not GitHub, gh missing, no branch). */
  prUnsupported?: boolean;
  /**
   * Whether the worktree's branch still exists on origin. `undefined` means we
   * haven't probed yet (first sync not complete) — UI should treat as unknown
   * rather than absent.
   */
  remoteBranchExists?: boolean;
  /**
   * Client-only marker for optimistic placeholders shown while the real task
   * is being created on the server. Never set by the API; stripped from
   * anything sent back to the server.
   */
  isPending?: boolean;
}

export interface TaskSession {
  id: string;
  title: string;
  provider?: string;
  lastModified: string;
  isRunning: boolean;
}

export function generateTaskId(): string {
  return 'task_' + crypto.randomUUID();
}
