import type { WorkflowStatus } from './task-entity';

/**
 * Sidebar/list grouping bucket.
 *
 * `chat` is a special bucket for sessions that are not attached to a task.
 * Worktree/task items use the parent task's workflow status.
 */
export type SidebarStatusGroup = 'chat' | WorkflowStatus;

/**
 * Display and sort order for sidebar groups and kanban columns.
 * chat first (default state), then active workflow states,
 * then terminal states last.
 */
export const SIDEBAR_STATUS_GROUP_ORDER: readonly SidebarStatusGroup[] = [
  'chat',
  'todo',
  'in_progress',
  'in_review',
  'done',
] as const;

/**
 * Per-status display configuration.
 * label: i18n key string (resolved at render time via t())
 * color: CSS color or CSS variable reference
 * defaultCollapsed: whether the sidebar group starts collapsed
 */
export interface SidebarStatusGroupConfig {
  label: string;
  color: string;
  defaultCollapsed: boolean;
}

export const SIDEBAR_STATUS_GROUP_CONFIG: Record<SidebarStatusGroup, SidebarStatusGroupConfig> = {
  chat:        { label: 'task.status.chat',        color: 'var(--accent-light)',      defaultCollapsed: false },
  todo:        { label: 'task.status.todo',         color: 'var(--workflow-todo)',     defaultCollapsed: true  },
  in_progress: { label: 'task.status.inProgress',  color: 'var(--workflow-doing)',    defaultCollapsed: false },
  in_review:   { label: 'task.status.inReview',    color: 'var(--workflow-review)',   defaultCollapsed: false },
  done:        { label: 'task.status.done',         color: 'var(--workflow-done)',     defaultCollapsed: true  },
};

export function getSessionStatusGroup(session: {
  taskId?: string;
  workflowStatus?: WorkflowStatus;
}): SidebarStatusGroup {
  if (!session.taskId) return 'chat';
  return session.workflowStatus ?? 'todo';
}

/**
 * MIME type for drag-and-drop task status changes.
 * Distinct from any existing session drag MIME to avoid collisions.
 */
export const TASK_DND_MIME = 'application/x-task-dnd' as const;

/**
 * MIME type for multi-select drag-and-drop.
 * Carries a JSON array of all selected session IDs being dragged together.
 */
export const TASK_MULTI_DND_MIME = 'application/x-task-multi-dnd' as const;

/**
 * MIME type for kanban task-entity drag-and-drop.
 * Distinct from TASK_DND_MIME because board task cards move task entities,
 * not standalone chat sessions.
 */
export const TASK_ENTITY_DND_MIME = 'application/x-task-entity-dnd' as const;

/**
 * MIME type for drag-and-drop column/group reordering.
 * Carries the sidebar status group being dragged, distinct from TASK_DND_MIME (card moves).
 */
export const COLUMN_DND_MIME = 'application/x-column-dnd' as const;

/**
 * MIME type for collection item drag-and-drop.
 * Carries JSON: { type: 'task' | 'chat', id: string, collectionId: string | null }
 */
export const COLLECTION_ITEM_DND_MIME = 'application/x-collection-item-dnd' as const;

/**
 * MIME type for collection group reordering.
 * Carries the collection ID (or '__uncategorized') being dragged.
 */
export const COLLECTION_GROUP_DND_MIME = 'application/x-collection-group-dnd' as const;
