import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { getAvailableSessionWorktrees, SessionLocationSelector } from '@/components/session/session-location-selector';
import type { TaskEntity } from '@/types/task-entity';

function task(id: string, patch: Partial<TaskEntity> = {}): TaskEntity {
  return { id, title: id, projectId: 'project', projectViewId: 'project', workDir: `/repo-${id}`, worktreeBranch: `feature/${id}`, workflowStatus: 'todo', sortOrder: 0, sessions: [], createdAt: '', updatedAt: '', ...patch };
}

test('session locations omit unavailable checkouts, legacy non-worktree tasks and the project folder', () => {
  const tasks = [task('usable'), task('archived', { archived: true }), task('deleted', { worktreeDeletedAt: 'today' }), task('missing', { worktreeMissing: true }), task('pending', { isPending: true }), task('no-path', { workDir: undefined }), task('legacy', { worktreeBranch: undefined }), task('project', { workDir: '/repo' })];
  assert.deepEqual(getAvailableSessionWorktrees(tasks, '/repo').map((item) => item.id), ['usable']);
});

test('session locations deduplicate physical worktrees across Windows and WSL path representations', () => {
  const tasks = [task('project', { workDir: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\repo' }), task('first', { workDir: '/home/work/checkout' }), task('alias', { workDir: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\checkout' }), task('identity', { worktreeId: 'wt-1' }), task('identity-alias', { worktreeId: 'wt-1' })];
  assert.deepEqual(getAvailableSessionWorktrees(tasks, '/home/work/repo').map((item) => item.id), ['first', 'identity']);
});

test('session location chooser exposes existing worktrees before opening the picker', () => {
  const markup = renderToStaticMarkup(createElement(SessionLocationSelector, { location: { worktrees: [task('named')], selectedWorktree: null, locationKind: 'project', projectDir: '/repo', loading: false, setLocationKind() {}, setSelectedWorktreeId() {}, canSubmit: true } }));
  assert.match(markup, /data-session-location-selector/);
  assert.match(markup, /Existing worktree \(1\)/);
  assert.match(markup, /aria-pressed="true"/);
});
