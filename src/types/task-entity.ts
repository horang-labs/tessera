/**
 * Task entity types for workflow management.
 *
 * Tasks use 'task_' prefixed IDs and group multiple sessions into a single
 * work unit tied to a worktree branch.
 *
 * NOTE: WorkflowStatus is intentionally separate from sidebar status groups
 * (defined in task.ts). Sidebar groups govern UI buckets like `chat`/`todo`,
 * while WorkflowStatus governs logical workflow progression for tasks and
 * user-positioned standalone chats.
 */

/** Workflow status for tasks and user-positioned standalone chat sessions. */
export type WorkflowStatus = 'todo' | 'in_progress' | 'in_review' | 'done';

export const WORKFLOW_STATUS_ORDER: WorkflowStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

export const WORKFLOW_STATUS_CONFIG: Record<WorkflowStatus, { label: string; color: string }> = {
  todo: { label: 'Todo', color: 'var(--workflow-todo)' },
  in_progress: { label: 'Doing', color: 'var(--workflow-doing)' },
  in_review: { label: 'Review', color: 'var(--workflow-review)' },
  done: { label: 'Done', color: 'var(--workflow-done)' },
};

export const CHAT_WORKFLOW_ICON_COLOR: Record<WorkflowStatus, string> = {
  todo: 'var(--workflow-todo)',
  in_progress: 'var(--workflow-doing)',
  in_review: 'var(--workflow-review)',
  done: 'var(--workflow-done)',
};

export const CHAT_WORKFLOW_ICON_FILL: Record<WorkflowStatus, string> = {
  todo: 'var(--chat-workflow-todo-fill)',
  in_progress: 'var(--chat-workflow-doing-fill)',
  in_review: 'var(--chat-workflow-review-fill)',
  done: 'var(--chat-workflow-done-fill)',
};

export interface TaskEntity {
  id: string;              // 'task_<uuid>'
  /** Stable identity of the linked Worktree represented by this task. */
  worktreeId?: string;
  projectId: string;
  title: string;
  collectionId?: string;   // FK -> collections.id
  workflowStatus: WorkflowStatus;
  worktreeBranch?: string;
  workDir?: string;        // Parent-owned checkout path (legacy child fallback during migration)
  /** Immutable Project-view placement captured when the Worktree was created. */
  creationScope?: {
    originWorktreeId: string;
    branch: string;
  };
  /** Git provenance only; never used to decide Project-view placement. */
  startPoint?: string;
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
  /** How far the worktree's preparation has progressed, and whether it succeeded. */
  preparationStatus?: import('@/lib/projects/preparation-status-policy').PreparationStatus;
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
  /** Stable representative Project, independent of the Project currently showing it. */
  originProjectId?: string;
  title: string;
  provider?: string;
  lastModified: string;
  isRunning: boolean;
  /** Fixed execution surface inherited from the linked session. */
  kind?: 'chat' | 'terminal';
  /**
   * Display order within the task. Starts out as creation order (a new session
   * is inserted at 0 and pushes the rest down) and survives manual drag-reorder.
   */
  sortOrder: number;
}

export function generateTaskId(): string {
  return 'task_' + crypto.randomUUID();
}
