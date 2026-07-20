import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const openWorkspaceTabSource = fs.readFileSync(
  new URL('../src/lib/workspace-tabs/open-workspace-tab.ts', import.meta.url),
  'utf8',
);
const memoryPanelSource = fs.readFileSync(
  new URL('../src/components/memory/memory-panel.tsx', import.meta.url),
  'utf8',
);
const memoryFileTabSource = fs.readFileSync(
  new URL('../src/components/memory/memory-file-tab.tsx', import.meta.url),
  'utf8',
);
const sessionPeekSource = fs.readFileSync(
  new URL('../src/components/board/session-peek.tsx', import.meta.url),
  'utf8',
);
const boardStoreSource = fs.readFileSync(
  new URL('../src/stores/board-store.ts', import.meta.url),
  'utf8',
);
const settingsStoreSource = fs.readFileSync(
  new URL('../src/stores/settings-store.ts', import.meta.url),
  'utf8',
);

test('Context rows explicitly route memory files into Kanban Peek', () => {
  assert.match(openWorkspaceTabSource, /tryOpenMemoryFileInKanbanPeek/);
  assert.match(openWorkspaceTabSource, /type: "memory-file"/);
  assert.match(openWorkspaceTabSource, /options\.preferKanbanPeek/);
  assert.match(memoryPanelSource, /preferKanbanPeek: true/);
});

test('Peek state accepts both workspace and editable Context file references', () => {
  assert.match(boardStoreSource, /WorkspaceFileSessionRef \| MemoryFileSessionRef/);
  assert.match(sessionPeekSource, /<MemoryFileTab/);
  assert.match(sessionPeekSource, /peekFileRef\.type === 'memory-file'/);
});

test('the reused Context file editor closes through Peek and retains editing controls', () => {
  assert.match(memoryFileTabSource, /onClose\?: \(\) => void/);
  assert.match(memoryFileTabSource, /onDirtyChange\?: \(dirty: boolean\) => void/);
  assert.match(memoryFileTabSource, /data-testid="memory-mode-edit"/);
  assert.match(memoryFileTabSource, /data-testid="memory-save-btn"/);
  assert.match(memoryFileTabSource, /data-testid="memory-file-close"/);
  assert.match(memoryFileTabSource, /onChange=\{setDraft\}/);
});

test('unsaved Context edits are guarded before Peek replacement or close', () => {
  assert.match(boardStoreSource, /peekFileDirty: boolean/);
  assert.match(boardStoreSource, /confirmDiscardPeekFileChanges/);
  assert.match(boardStoreSource, /discardChangesConfirm/);
  assert.match(sessionPeekSource, /onDirtyChange=\{setPeekFileDirty\}/);
  assert.match(settingsStoreSource, /collapsed && !useBoardStore\.getState\(\)\.closeSessionPeek\(\)/);
  assert.match(settingsStoreSource, /partial\.kanbanSessionOpenMode/);
});
