import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  findCompositeWorktreeId,
  getLinkedWorktreeDensity,
  toLinkedWorktreeSession,
} from '../src/lib/worktrees/linked-worktree-presentation';
import { WorktreeOverview } from '../src/components/worktree/worktree-overview';
import { ChatItemRow, TaskItemRow } from '../src/components/chat/collection-group-sections';
import { buildCollectionGroups } from '../src/lib/chat/build-collection-groups';
import { useSettingsStore } from '../src/stores/settings-store';
import type { TaskEntity, TaskSession } from '../src/types/task-entity';
import type { UnifiedSession } from '../src/types/chat';

test('linked Worktree density follows the projected zero/one/many session threshold', () => {
  assert.equal(getLinkedWorktreeDensity([]), 'standalone');
  assert.equal(getLinkedWorktreeDensity([{ id: 'visible' }]), 'composite');
  assert.equal(getLinkedWorktreeDensity([{ id: 'one' }, { id: 'two' }]), 'expanded');
});

test('a projected composite Session resolves its canonical Worktree side target', () => {
  const linkedWorktrees = [
    { worktreeId: 'wt-zero', sessions: [] },
    { worktreeId: 'wt-one', sessions: [{ id: 'session-one' }] },
    { worktreeId: 'wt-many', sessions: [{ id: 'session-two' }, { id: 'session-three' }] },
  ];

  assert.equal(findCompositeWorktreeId(linkedWorktrees, 'session-one'), 'wt-one');
  assert.equal(findCompositeWorktreeId(linkedWorktrees, 'session-two'), null);
  assert.equal(findCompositeWorktreeId(linkedWorktrees, null), null);
});

test('projected child Sessions retain canonical Worktree and Project placement when opened', () => {
  const linked: TaskEntity = {
    id: 'task-linked',
    worktreeId: 'wt-linked',
    projectId: 'origin-project',
    projectViewId: 'project-view',
    title: 'Linked',
    workflowStatus: 'in_progress',
    worktreeBranch: 'feature/linked',
    workDir: '/repo/linked',
    sortOrder: 0,
    sessions: [],
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
  const opened = toLinkedWorktreeSession(linked, taskSession('child'));

  assert.deepEqual(
    { projectDir: opened.projectDir, taskId: opened.taskId, worktreeId: opened.worktreeId, workDir: opened.workDir },
    { projectDir: 'project-view', taskId: 'task-linked', worktreeId: 'wt-linked', workDir: '/repo/linked' },
  );
  const directProjection = { ...opened, projectDir: 'imported-worktree', taskId: undefined, title: 'Canonical title' };
  const nestedProjection = toLinkedWorktreeSession(linked, taskSession('child'), directProjection);
  assert.equal(nestedProjection.title, 'Canonical title');
  assert.deepEqual(
    { projectDir: nestedProjection.projectDir, taskId: nestedProjection.taskId },
    { projectDir: 'project-view', taskId: 'task-linked' },
  );
});

test('linked Worktree overview names the canonical linked target', () => {
  const overview = renderToStaticMarkup(createElement(WorktreeOverview, {
    branch: 'feature/linked',
    displayPath: '/repo/linked',
    label: 'Linked Worktree',
  }));

  assert.match(overview, /Linked Worktree/);
  assert.match(overview, /feature\/linked/);
  assert.match(overview, /\/repo\/linked/);
  assert.doesNotMatch(overview, /Project Worktree/);
});

function taskSession(id: string): TaskSession {
  return {
    id,
    title: `Session ${id}`,
    lastModified: '2026-08-09T00:00:00.000Z',
    isRunning: false,
    sortOrder: 0,
  };
}

test('Project groups retain canonical linked Worktrees after branch-scoped session projection', () => {
  const linked: TaskEntity = {
    id: 'linked-task',
    worktreeId: 'wt-linked',
    projectId: 'project-view',
    projectViewId: 'project-view',
    title: 'Linked Worktree',
    workflowStatus: 'todo',
    sessions: [taskSession('linked-session')],
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  };

  assert.deepEqual(
    buildCollectionGroups([], [linked], []).flatMap((group) => group.tasks.map((item) => item.worktreeId)),
    ['wt-linked'],
  );
});

function renderLinkedWorktree(sessionIds: string[]): string {
  const task: TaskEntity = {
    id: `task-${sessionIds.length}`,
    worktreeId: `wt-${sessionIds.length}`,
    projectId: 'project-view',
    projectViewId: 'project-view',
    title: `Worktree ${sessionIds.length}`,
    workflowStatus: 'todo',
    worktreeBranch: `feature/${sessionIds.length}`,
    workDir: `/repo/worktree-${sessionIds.length}`,
    sortOrder: 0,
    sessions: sessionIds.map(taskSession),
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
  return renderToStaticMarkup(createElement(TaskItemRow, {
    task,
    activeSessionId: null,
    onSessionClick: () => {},
    isDragging: false,
    isJustDropped: false,
    onDragStart: () => {},
    onDragEnd: () => {},
    onDragOverItem: () => {},
    onAddSession: () => {},
  }));
}

test('linked Worktree rows render standalone, composite, and expanded identities', () => {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, showProviderIcons: false },
  }));

  const standalone = renderLinkedWorktree([]);
  assert.match(standalone, /data-linked-worktree-density="standalone"/);
  assert.match(standalone, /collection-task-worktree-icon-task-0/);
  assert.doesNotMatch(standalone, /collection-subsession-/);

  const composite = renderLinkedWorktree(['one']);
  assert.match(composite, /data-linked-worktree-density="composite"/);
  assert.match(composite, /collection-task-worktree-icon-task-1/);
  assert.doesNotMatch(composite, /collection-subsession-/);

  const expanded = renderLinkedWorktree(['one', 'two']);
  assert.match(expanded, /data-linked-worktree-density="expanded"/);
  assert.match(expanded, /collection-task-worktree-icon-task-2/);
  assert.match(expanded, /collection-subsession-one/);
  assert.match(expanded, /collection-subsession-two/);
});

test('provider-enabled composite rows keep both agent and Worktree identity', () => {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, showProviderIcons: true },
  }));

  const composite = renderLinkedWorktree(['one']);
  assert.match(composite, /collection-task-agent-icon-task-1/);
  assert.match(composite, /collection-task-worktree-icon-task-1/);
});

test('direct Project Worktree Sessions keep their chat identity', () => {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, showProviderIcons: false },
  }));
  const session = {
    id: 'direct-session',
    title: 'Direct Project Session',
    projectDir: 'project-view',
    isRunning: false,
    status: 'completed',
    lastModified: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    archived: false,
    sortOrder: 0,
  } satisfies UnifiedSession;
  const markup = renderToStaticMarkup(createElement(ChatItemRow, {
    session,
    activeSessionId: null,
    onSessionClick: () => {},
    isDragging: false,
    isJustDropped: false,
    onDragStart: () => {},
    onDragEnd: () => {},
    onDragOverItem: () => {},
  }));

  assert.match(markup, /collection-chat-(?:status-)?bubble-direct-session/);
  assert.doesNotMatch(markup, /collection-task-worktree-icon/);
});
