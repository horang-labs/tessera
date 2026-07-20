import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const openWorkspaceTabSource = fs.readFileSync(
  new URL('../src/lib/workspace-tabs/open-workspace-tab.ts', import.meta.url),
  'utf8',
);
const boardStoreSource = fs.readFileSync(
  new URL('../src/stores/board-store.ts', import.meta.url),
  'utf8',
);
const sessionPeekSource = fs.readFileSync(
  new URL('../src/components/board/session-peek.tsx', import.meta.url),
  'utf8',
);
const workspaceFileTabSource = fs.readFileSync(
  new URL('../src/components/workspace/workspace-file-tab.tsx', import.meta.url),
  'utf8',
);
const workspaceFilePanelSource = fs.readFileSync(
  new URL('../src/components/workspace/workspace-file-panel.tsx', import.meta.url),
  'utf8',
);

test('workspace file clicks route into the visible Kanban Peek workspace', () => {
  assert.match(openWorkspaceTabSource, /tryOpenWorkspaceFileInKanbanPeek/);
  assert.match(openWorkspaceTabSource, /openPeekFile/);
  assert.match(openWorkspaceTabSource, /options\.preferKanbanPeek/);
  assert.match(workspaceFilePanelSource, /preferKanbanPeek: true/);
});

test('board state owns the transient file sidecar without creating a hidden tab', () => {
  assert.match(boardStoreSource, /peekFileRef:/);
  assert.match(boardStoreSource, /openPeekFile:/);
  assert.match(boardStoreSource, /closePeekFile:/);
  assert.match(boardStoreSource, /peekFileSidecarWidth:/);
  assert.match(
    boardStoreSource,
    /selectedBoardSessionId: state\.peekSessionId \?\? fileRef\.sourceSessionId/,
  );
});

test('Session Peek renders the shared file viewer behind an accessible resizer', () => {
  assert.match(sessionPeekSource, /<WorkspaceFileTab/);
  assert.match(sessionPeekSource, /data-testid="kanban-peek-file-sidecar"/);
  assert.match(sessionPeekSource, /data-testid="kanban-peek-file-resize-handle"/);
  assert.match(sessionPeekSource, /role="separator"/);
  assert.match(sessionPeekSource, /onPointerMove/);
  assert.match(sessionPeekSource, /onKeyDown/);
});

test('file-only Peek delegates its title bar to the file viewer', () => {
  assert.match(sessionPeekSource, /aria-labelledby=\{showSessionContent \? titleId : undefined\}/);
  assert.match(sessionPeekSource, /\{showSessionContent \? \(\s*<header/);
  assert.match(sessionPeekSource, /aria-label=\{isFileOnly \? peekFileLabel : undefined\}/);
});

test('the reused workspace file view can be active and close inside a transient surface', () => {
  assert.match(workspaceFileTabSource, /surfaceActive\?: boolean/);
  assert.match(workspaceFileTabSource, /onClose\?: \(\) => void/);
  assert.match(workspaceFileTabSource, /surfaceActive \|\| state\.activeTabId === tabId/);
});
