import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KanbanChatCard, KanbanTaskCard } from '@/components/board/kanban-card';
import { selectKanbanProjectionItems } from '@/lib/kanban/board-scope';
import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';

const timestamp = '2026-08-09T00:00:00.000Z';

function directSession(id: string, originProjectId: string): UnifiedSession {
  return {
    id,
    title: id,
    projectDir: 'project-c',
    originProjectId,
    taskId: id === 'canonical-c-session' ? 'linked-c' : undefined,
    isRunning: false,
    status: 'completed',
    lastModified: timestamp,
    createdAt: timestamp,
    archived: false,
    sortOrder: 0,
  };
}

function sessionlessWorktree(): TaskEntity {
  return {
    id: 'descendant-d',
    worktreeId: 'wt_descendant_d',
    projectId: 'project-c',
    projectViewId: 'project-c',
    title: 'Descendant D',
    workflowStatus: 'todo',
    worktreeBranch: 'feature/d',
    workDir: '/repo/descendant-d',
    sortOrder: 0,
    sessions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function linkedWorktree(session: UnifiedSession): TaskEntity {
  return {
    ...sessionlessWorktree(),
    id: 'linked-summary',
    worktreeId: 'wt_linked_summary',
    title: 'Linked Summary',
    sessions: [{
      id: session.id,
      originProjectId: session.originProjectId,
      title: session.title,
      lastModified: session.lastModified,
      isRunning: session.isRunning,
      sortOrder: session.sortOrder,
    }],
  };
}

test('selected Project Kanban renders each linked Session only through its Worktree card', () => {
  const linkedSummary = directSession('summary-only-session', 'project-a');
  linkedSummary.taskId = 'linked-summary';
  const sessions = [
    directSession('canonical-c-session', 'project-a'),
    directSession('direct-c-session', 'project-c'),
    linkedSummary,
  ];
  const items = selectKanbanProjectionItems({
    sessions,
    tasks: [sessionlessWorktree(), linkedWorktree(linkedSummary)],
  }, null);
  const chatMarkup = items.chats.map((session) => renderToStaticMarkup(createElement(
    KanbanChatCard,
    {
      session,
      isActive: false,
      onClick: () => {},
      onDoubleClick: () => {},
    },
  ))).join('');
  const taskMarkup = items.tasks.map((task) => renderToStaticMarkup(createElement(
    KanbanTaskCard,
    {
      task,
      activeSessionId: null,
      onSessionClick: () => {},
      onSessionDoubleClick: () => {},
    },
  ))).join('');
  const markup = chatMarkup + taskMarkup;

  assert.match(markup, /canonical-c-session/);
  assert.match(markup, /direct-c-session/);
  assert.match(markup, /Descendant D/);
  assert.match(markup, /Linked Summary/);
  assert.deepEqual(items.chats.map((session) => session.id), [
    'canonical-c-session',
    'direct-c-session',
  ]);
  assert.equal((markup.match(/kanban-chat-bubble-/g) ?? []).length, 2);
  assert.equal((markup.match(/data-testid="kanban-card"/g) ?? []).length, 4);
});
