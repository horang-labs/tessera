import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(path, 'utf8');

test('restart session is exposed in header, sidebar, and kanban context menus only', () => {
  const taskMenu = read('src/components/chat/task-context-menu.tsx');
  const listMenu = read('src/components/chat/collection-group-sections.tsx');
  const header = read('src/components/chat/header.tsx');
  const kanban = read('src/components/board/kanban-card.tsx');
  const primitives = read('src/components/chat/work-item-primitives.tsx');

  assert.match(taskMenu, /data-testid="ctx-restart-process"/);
  assert.match(listMenu, /data-testid="ctx-restart-process"/);
  assert.match(header, /onRestartProcess=/);
  assert.match(kanban, /onRestartProcess=/);
  assert.doesNotMatch(kanban, /quick-restart-button/);
  assert.doesNotMatch(listMenu, /quick-restart/);
  assert.doesNotMatch(primitives, /RestartProcessButton/);
});

test('task restart snapshots only currently running child sessions', () => {
  const board = read('src/components/board/kanban-board.tsx');
  const list = read('src/components/chat/collection-group.tsx');

  assert.match(board, /handleTaskRestartProcess[\s\S]*taskMenuAnchor\.task\.sessions/);
  assert.match(board, /resolveSessionRuntimePresentation\(liveSession \?\? session\)\.canStop/);
  assert.match(list, /handleContextMenuRestartProcess[\s\S]*resolveSessionRuntimePresentation\(liveSession \?\? session\)\.canStop/);
});
