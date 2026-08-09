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

test('selected Project Kanban renders direct Sessions as Chat cards and linked Worktrees as cards', () => {
  const sessions = [
    directSession('canonical-c-session', 'project-a'),
    directSession('direct-c-session', 'project-c'),
  ];
  const items = selectKanbanProjectionItems({
    sessions,
    tasks: [sessionlessWorktree()],
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
  assert.equal((markup.match(/kanban-chat-bubble-/g) ?? []).length, 2);
  assert.equal((markup.match(/data-testid="kanban-card"/g) ?? []).length, 3);
});
