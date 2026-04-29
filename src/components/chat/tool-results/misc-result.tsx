'use client';

import { memo } from 'react';
import { CheckCircle, XCircle, ListTodo, Circle, Clock, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  BackgroundTaskToolResult,
  TodoUpdateToolResult,
} from '@/types/tool-result';

interface MiscResultProps {
  result: BackgroundTaskToolResult | TodoUpdateToolResult;
  toolName: string;
}

/** Status icon for task items */
function TaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle className="w-3 h-3 text-(--status-success-text) shrink-0" />;
    case 'in_progress':
      return <Clock className="w-3 h-3 text-(--accent) shrink-0 animate-pulse" />;
    case 'deleted':
      return <Trash2 className="w-3 h-3 text-(--text-muted) shrink-0" />;
    default:
      return <Circle className="w-3 h-3 text-(--text-muted) shrink-0" />;
  }
}

/** Status badge color */
function statusBadgeClass(status: string): string {
  switch (status) {
    case 'completed': return 'bg-(--status-success-bg) text-(--status-success-text)';
    case 'in_progress': return 'bg-(--status-info-bg) text-(--status-info-text)';
    case 'deleted': return 'bg-(--text-muted)/15 text-(--text-muted)';
    default: return 'bg-(--text-muted)/15 text-(--text-muted)';
  }
}

export const MiscResult = memo(function MiscResult({ result }: MiscResultProps) {
  // TaskStop
  if (result.kind === 'background_task' && result.action === 'stop') {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <XCircle className="w-3 h-3 text-(--text-muted) shrink-0" />
        <span className="text-(--text-secondary)">Task stopped:</span>
        <span className="text-(--text-muted) font-mono">{result.task.id}</span>
      </div>
    );
  }

  // TaskOutput
  if (result.kind === 'background_task' && result.action === 'output') {
    const task = result.task;
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-[11px]">
          <span className={cn(
            'text-[9px] px-1 py-0.5 rounded',
            task.status === 'completed' ? 'bg-(--status-success-bg) text-(--status-success-text)' :
            task.status === 'failed' ? 'bg-(--status-error-bg) text-(--status-error-text)' :
            'bg-(--accent)/10 text-(--accent)'
          )}>
            {task.status}
          </span>
          <span className="text-(--text-muted) font-mono">{task.id}</span>
          <span className="text-(--text-secondary) truncate">{task.description}</span>
        </div>
        {task.output && (
          <pre className="text-[11px] text-(--text-secondary) bg-(--tool-output-bg) px-2 py-1.5 rounded font-mono whitespace-pre-wrap max-h-[100px] overflow-y-auto">
            {task.output}
          </pre>
        )}
      </div>
    );
  }

  // TodoWrite — structured task list with diff
  if (result.kind === 'todo_update') {
    const oldTodos = result.previous || [];
    const newTodos = result.next || [];
    const wasEmpty = oldTodos.length === 0;

    // Compute diff: find added, removed, changed
    const oldMap = new Map(oldTodos.map((t: any, i: number) => [t.content, { ...t, idx: i }]));
    const newMap = new Map(newTodos.map((t: any, i: number) => [t.content, { ...t, idx: i }]));

    const added = newTodos.filter((t: any) => !oldMap.has(t.content));
    const removed = oldTodos.filter((t: any) => !newMap.has(t.content));
    const changed = newTodos.filter((t: any) => {
      const old = oldMap.get(t.content);
      return old && old.status !== t.status;
    });

    const completedCount = newTodos.filter((t: any) => t.status === 'completed').length;
    const inProgressCount = newTodos.filter((t: any) => t.status === 'in_progress').length;

    return (
      <div className="rounded border border-(--tool-border) bg-(--tool-bg) px-3 py-2 space-y-2">
        {/* Header */}
        <div className="flex items-center gap-2">
          <ListTodo className="w-3.5 h-3.5 text-(--accent) shrink-0" />
          <span className="text-xs text-(--text-secondary) font-medium">
            {wasEmpty ? 'Tasks created' : 'Tasks updated'}
          </span>
          <div className="flex items-center gap-1.5 ml-auto">
            {completedCount > 0 && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-(--status-success-bg) text-(--status-success-text)">
                {completedCount} done
              </span>
            )}
            {inProgressCount > 0 && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-(--status-info-bg) text-(--status-info-text)">
                {inProgressCount} active
              </span>
            )}
            <span className="text-[10px] text-(--text-muted)">
              {newTodos.length} total
            </span>
          </div>
        </div>

        {/* Diff summary */}
        {!wasEmpty && (added.length > 0 || removed.length > 0 || changed.length > 0) && (
          <div className="flex items-center gap-2 text-[10px]">
            {added.length > 0 && (
              <span className="text-(--status-success-text)">+{added.length} added</span>
            )}
            {removed.length > 0 && (
              <span className="text-(--status-error-text)">-{removed.length} removed</span>
            )}
            {changed.length > 0 && (
              <span className="text-(--accent)">{changed.length} changed</span>
            )}
          </div>
        )}

        {/* Task list */}
        <div className="space-y-0.5">
          {newTodos.map((todo: any, i: number) => {
            const isAdded = added.includes(todo);
            const isChanged = changed.includes(todo);
            const oldStatus = isChanged ? oldMap.get(todo.content)?.status : null;

            return (
              <div
                key={i}
                className={cn(
                  'flex items-center gap-2 py-1 px-1.5 rounded text-[11px]',
                  isAdded && 'bg-(--status-success-bg)',
                  isChanged && 'bg-(--status-info-bg)'
                )}
              >
                <TaskStatusIcon status={todo.status} />
                <span className={cn(
                  'truncate flex-1',
                  todo.status === 'completed' ? 'text-(--text-muted) line-through' :
                  todo.status === 'in_progress' ? 'text-(--text-primary)' :
                  'text-(--text-secondary)'
                )}>
                  {todo.content}
                </span>

                {/* Status badge */}
                <span className={cn(
                  'text-[9px] px-1 py-0.5 rounded shrink-0',
                  statusBadgeClass(todo.status)
                )}>
                  {todo.status === 'in_progress' ? 'active' : todo.status}
                </span>

                {/* Status change indicator */}
                {isChanged && oldStatus && (
                  <span className="text-[9px] text-(--text-muted) shrink-0">
                    ({oldStatus} →)
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Active task detail */}
        {newTodos.some((t: any) => t.status === 'in_progress' && t.activeForm) && (
          <div className="border-t border-(--divider) pt-1.5 mt-1">
            {newTodos
              .filter((t: any) => t.status === 'in_progress' && t.activeForm)
              .map((t: any, i: number) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px] text-(--accent)">
                  <Clock className="w-2.5 h-2.5 animate-pulse shrink-0" />
                  <span className="truncate">{t.activeForm}</span>
                </div>
              ))
            }
          </div>
        )}
      </div>
    );
  }

  // Default: JSON dump
  return (
    <pre className="text-[11px] text-(--text-muted) bg-(--tool-param-bg) px-2 py-1.5 rounded font-mono whitespace-pre-wrap max-h-[150px] overflow-y-auto">
      {JSON.stringify(result, null, 2)}
    </pre>
  );
});
