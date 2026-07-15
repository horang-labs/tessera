'use client';

import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Circle, ListTodo, LoaderCircle } from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import type { TodoItem } from '@/types/cli-jsonl-schemas';
import { cn } from '@/lib/utils';
import { SINGLE_PANEL_CONTENT_SHELL } from '../single-panel-shell';

interface TodoStatusBarProps {
  sessionId: string;
  isSinglePanel?: boolean;
}

const COLLAPSED_STORAGE_KEY = 'tessera.todo-status-bar.collapsed';

function readStoredCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // localStorage unavailable (private mode etc.) — collapse still works for the session.
  }
}

function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return <CheckCircle2 className="size-3.5 shrink-0 text-(--status-success-text)" />;
  }
  if (status === 'in_progress') {
    return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-(--accent)" />;
  }
  return <Circle className="size-3.5 shrink-0 text-(--text-muted)" />;
}

function statusLabel(status: TodoItem['status']): string {
  return status === 'in_progress' ? 'running' : status;
}

function statusClass(status: TodoItem['status']): string {
  if (status === 'completed') {
    return 'bg-(--status-success-bg) text-(--status-success-text)';
  }
  if (status === 'in_progress') {
    return 'bg-(--status-info-bg) text-(--status-info-text)';
  }
  return 'bg-(--text-muted)/15 text-(--text-muted)';
}

/**
 * Latest live todo projection, docked above the composer independently from
 * message pagination. Completed items remain visible while any task is active;
 * the whole card disappears as soon as the snapshot becomes terminal or empty.
 * The header toggles the item list; the collapsed preference persists across
 * sessions via localStorage (#151).
 */
export function TodoStatusBar({ sessionId, isSinglePanel }: TodoStatusBarProps) {
  const todos = useChatStore((state) => state.todoSnapshots.get(sessionId));
  // Safe to read during the initial render: the bar only mounts client-side
  // once the store receives a todo snapshot, so SSR never renders it.
  const [collapsed, setCollapsed] = useState(readStoredCollapsed);

  const hasActiveTodo = todos?.some(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress',
  );

  if (!todos || todos.length === 0 || !hasActiveTodo) return null;

  const completedCount = todos.filter((todo) => todo.status === 'completed').length;
  const runningCount = todos.filter((todo) => todo.status === 'in_progress').length;
  const activeTodo = todos.find((todo) => todo.status === 'in_progress')
    ?? todos.find((todo) => todo.status === 'pending');
  const collapsedSummary = activeTodo
    ? (activeTodo.status === 'in_progress' && activeTodo.activeForm) || activeTodo.content
    : null;

  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      const next = !previous;
      writeStoredCollapsed(next);
      return next;
    });
  };

  return (
    <div className="pt-1.5" data-testid="todo-status-bar" data-collapsed={collapsed}>
      <div className={cn('w-full', isSinglePanel ? SINGLE_PANEL_CONTENT_SHELL : 'px-4')}>
        <section
          aria-label="Task progress"
          className="overflow-hidden rounded-lg border border-(--tool-border) bg-(--tool-bg) shadow-sm"
        >
          <header
            role="button"
            tabIndex={0}
            aria-expanded={!collapsed}
            data-testid="todo-status-toggle"
            onClick={toggleCollapsed}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleCollapsed();
              }
            }}
            className={cn(
              'flex cursor-pointer select-none items-center gap-2 px-3 py-2 transition-colors hover:bg-(--text-muted)/10',
              !collapsed && 'border-b border-(--tool-border)',
            )}
          >
            <ListTodo className="size-4 shrink-0 text-(--accent)" />
            <span className="shrink-0 text-xs font-medium text-(--text-primary)">Tasks</span>
            {collapsed && collapsedSummary && (
              <span
                title={collapsedSummary}
                data-testid="todo-status-collapsed-summary"
                className="min-w-0 truncate text-[11px] text-(--text-secondary)"
              >
                {collapsedSummary}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px]">
              {runningCount > 0 && (
                <span className="rounded bg-(--status-info-bg) px-1.5 py-0.5 text-(--status-info-text)">
                  {runningCount} running
                </span>
              )}
              <span className="text-(--text-muted)">
                {completedCount}/{todos.length} completed
              </span>
              {collapsed
                ? <ChevronRight className="size-3.5 shrink-0 text-(--text-muted)" />
                : <ChevronDown className="size-3.5 shrink-0 text-(--text-muted)" />}
            </div>
          </header>

          {!collapsed && (
            <div className="max-h-[30vh] space-y-0.5 overflow-y-auto p-1.5">
              {todos.map((todo, index) => (
                <div
                  key={`${todo.content}-${index}`}
                  className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1"
                  data-status={todo.status}
                  data-testid="todo-status-item"
                >
                  <TodoStatusIcon status={todo.status} />
                  <div className="min-w-0 flex-1">
                    <div
                      title={todo.content}
                      className={cn(
                        'truncate text-[11px]',
                        todo.status === 'completed'
                          ? 'text-(--text-muted) line-through'
                          : 'text-(--text-secondary)',
                      )}
                    >
                      {todo.content}
                    </div>
                    {todo.status === 'in_progress' && todo.activeForm && todo.activeForm !== todo.content && (
                      <div
                        className="truncate text-[10px] text-(--accent)"
                        title={todo.activeForm}
                      >
                        {todo.activeForm}
                      </div>
                    )}
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[9px]',
                      statusClass(todo.status),
                    )}
                  >
                    {statusLabel(todo.status)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
