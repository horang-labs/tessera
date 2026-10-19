import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const panel = await read('../src/components/workspace/workspace-file-panel.tsx');
const menu = await read('../src/components/workspace/workspace-file-context-menu.tsx');

test('rows and the tree background are drop targets for moves and uploads', () => {
  assert.match(panel, /onDragOver=\{\(event\) => handleDragOverFolder\(event, node\.path\)\}/);
  assert.match(panel, /onDrop=\{\(event\) => handleDropOnFolder\(event, node\.path\)\}/);
  assert.match(panel, /handleDragOverFolder\(event, ""\)/);
  assert.match(panel, /transferWorkspaceEntriesRequest\(target, operation, sources, destination\)/);
  assert.match(panel, /readDroppedFiles\(event\.dataTransfer\)/);
  // Directory rows are draggable in a worktree panel too, not only with a Session.
  assert.match(panel, /draggable=\{Boolean\(target\)\}\s*data-tree-path=\{node\.path\}/);
});

test('the tree handles clipboard and navigation keys', () => {
  assert.match(panel, /\["c", "x", "v"\]\.includes\(event\.key\.toLowerCase\(\)\)/);
  assert.match(panel, /resolveWorkspaceTreeKey\(\{/);
  assert.match(panel, /findWorkspaceTypeAheadMatch\(/);
});

test('delete uses the OS trash only where the workspace has one', async () => {
  const dialog = await read('../src/components/workspace/workspace-delete-dialog.tsx');
  const trash = await read('../src/lib/workspace-files/workspace-file-trash.ts');
  assert.match(panel, /trash: !options\.permanent/);
  assert.match(panel, /fetchWorkspaceTrashLabel\(target\)/);
  assert.match(panel, /trashLabel=\{trashLabel\}/);
  // No trash folder of our own and no undo behind it: either the OS trash or a real delete.
  assert.doesNotMatch(trash, /\.tessera-trash/);
  assert.doesNotMatch(panel, /undoTrash|restoreWorkspaceEntry/);
  // A WSL path (UNC from Windows, or a server inside WSL) has no trash, so only a permanent delete is offered.
  assert.match(trash, /microsoft/i);
  assert.match(dialog, /trashLabel \? \(/);
  assert.match(dialog, /onClick=\{\(\) => void confirm\(!trashLabel\)\}/);
});

test('menu offers clipboard, relative path, terminal and subfolder actions', () => {
  for (const id of [
    'cut', 'copy', 'paste', 'duplicate', 'copy-relative-path',
    'open-terminal', 'expand-children', 'collapse-children',
  ]) {
    assert.match(menu, new RegExp(`data-testid="workspace-context-${id}"`));
  }
  assert.match(panel, /createTerminalPanelAt\(tab\.activePanelId, uuidv4\(\), cwd, "vertical"\)/);
});

test('header has refresh and a sort that includes last-modified', () => {
  assert.match(panel, /data-testid="workspace-refresh"/);
  assert.match(panel, /data-testid="workspace-sort"/);
  assert.match(panel, /\/mtimes\?directory=/);
});

test('the delete dialog tracks finished deletions in state, not a ref read during render', async () => {
  // A ref reset in an effect leaves a re-opened dialog's first render with the
  // last run's paths filtered out, so deleting the same path twice did nothing.
  const dialog = await read('../src/components/workspace/workspace-delete-dialog.tsx');
  assert.doesNotMatch(dialog, /completed\.current/);
  assert.match(dialog, /useState<ReadonlySet<string>>/);
});

test('a single click only selects in the Git tab too; double-click opens the diff', async () => {
  const git = await read('../src/components/git/git-panel-sections.tsx');
  assert.match(git, /if \(shouldOpenOnRowClick\(event\.detail, clickPointerType\(event\)\)\) onOpenDiffFile\(file\);/);
  assert.doesNotMatch(git, /event\.detail === 0 \|\| shouldOpenOnRowClick/);
  assert.match(git, /onDoubleClick=\{\(\) => \{\s*setSelectedPath\(file\.path\);\s*onPinDiffFile\(file\);/);
});
