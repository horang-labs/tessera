import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relativePath) =>
  fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const filePanelSource = read('../src/components/workspace/workspace-file-panel.tsx');
const fileViewStoreSource = read('../src/stores/workspace-file-view-store.ts');
const deleteDialogSource = read('../src/components/workspace/workspace-delete-dialog.tsx');
const contextMenuSource = read('../src/components/workspace/workspace-file-context-menu.tsx');
const inlineRowSource = read('../src/components/workspace/workspace-inline-input-row.tsx');
const inlineHookSource = read('../src/components/workspace/use-workspace-inline-input.ts');
const inlineStateSource = read('../src/components/workspace/workspace-inline-input-state.ts');
const mutationClientSource = read('../src/lib/workspace-files/workspace-file-mutation-client.ts');
const tabSyncSource = read('../src/lib/workspace-tabs/workspace-tab-sync.ts');
const fileRouteSource = read('../src/app/api/sessions/[id]/file/route.ts');
const directoryRouteSource = read('../src/app/api/sessions/[id]/directory/route.ts');
const worktreeFileRouteSource = read('../src/app/api/worktrees/[id]/file/route.ts');
const worktreeDirectoryRouteSource = read('../src/app/api/worktrees/[id]/directory/route.ts');
const filesRouteSource = read('../src/app/api/sessions/[id]/files/route.ts');
const fileTabSource = read('../src/components/workspace/workspace-file-tab.tsx');
const panelContainerSource = read('../src/components/panel/panel-container.tsx');
const directoryRowSource = filePanelSource.slice(
  filePanelSource.indexOf('if (node.type === "directory")'),
  filePanelSource.indexOf('const isSelected = node.path === selectedPath'),
);
const fileRowSource = filePanelSource.slice(
  filePanelSource.indexOf('const isSelected = node.path === selectedPath'),
  filePanelSource.indexOf('if (!sessionId && !worktreeId)'),
);

test('folder expansion is restored per workspace after the file panel remounts', () => {
  assert.match(filePanelSource, /selectExpandedWorkspacePaths\(targetKey\)/);
  assert.match(filePanelSource, /toggleStoredPath\(targetKey, path\)/);
  assert.doesNotMatch(filePanelSource, /useState<Set<string>>/);
  assert.match(fileViewStoreSource, /expandedPathsByWorkspace/);
  assert.match(fileViewStoreSource, /createUiJsonStorage<PersistedWorkspaceFileViewState>/);
});

test('every row action lives on the right-click menu, not on a hover strip', () => {
  // A file explorer is a list of names. Four icons appearing on whichever row
  // the pointer crosses is a toolbar, and the user rejected it (#322 rework).
  for (const goneTestId of [
    'workspace-rename-entry',
    'workspace-delete-entry',
    'workspace-new-file-in-folder',
    'workspace-new-folder-in-folder',
  ]) {
    assert.ok(
      !filePanelSource.includes(`data-testid="${goneTestId}"`),
      `${goneTestId} must not be a row control any more`,
    );
  }
  // The panel's own two buttons stay: they sit in one place rather than
  // following the pointer, and the user asked for them to be kept.
  assert.match(filePanelSource, /data-testid="workspace-new-file"/);
  assert.match(filePanelSource, /data-testid="workspace-new-folder"/);
  for (const item of ['new-file', 'new-folder', 'rename', 'delete']) {
    assert.match(contextMenuSource, new RegExp(`data-testid="workspace-context-${item}"`));
  }
  // A folder row deletes as a directory, a file row as a file: the two take
  // different confirmation copy and only one sends `recursive`.
  assert.match(filePanelSource, /if \(node\.type === "directory"\) return \{ kind: "directory", path: node\.path \}/);
  assert.match(filePanelSource, /kind: "file",\s*\n\s*path: node\.path,/);
});

test('the menu creates where the click was, and the background creates at the root', () => {
  // On a folder, inside it; on a file, beside it; on the empty space, at the root.
  assert.match(filePanelSource, /if \(node\.type === "directory"\) return node\.path;/);
  assert.match(filePanelSource, /return node\.path\.split\("\/"\)\.slice\(0, -1\)\.join\("\/"\);/);
  assert.match(filePanelSource, /function newEntryParentFor\(node: WorkspaceTreeNode \| null\): string \{\s*\n\s*if \(!node\) return "";/);
  assert.match(filePanelSource, /onContextMenu=\{openBackgroundContextMenu\}/);
  // The background menu has no row, so it offers no rename and no delete.
  assert.match(filePanelSource, /onDelete: contextMenu\.node/);
  assert.match(filePanelSource, /onRename: contextMenu\.node/);
});

test('the delete confirmation states what is lost', () => {
  // Permanent, recursive for a folder, and explicit that a draft goes with the
  // file — there is no Trash and no undo behind any of it.
  assert.match(deleteDialogSource, /Everything inside this folder is deleted too/);
  assert.match(deleteDialogSource, /does not go to the Trash and cannot be undone/);
  assert.match(deleteDialogSource, /unsaved edits, and they are discarded with it/);
  assert.match(deleteDialogSource, /data-testid="workspace-delete-confirm"/);
  // Cancel must not be the destructive path.
  assert.match(deleteDialogSource, /onClick=\{\(\) => onOpenChange\(false\)\}/);
});

test('a dirty buffer is visible to the delete confirmation', () => {
  assert.match(fileTabSource, /markWorkspaceFileDirty\(sourceTargetKey, path\)/);
  assert.match(fileTabSource, /clearWorkspaceFileDirty\(sourceTargetKey, path\)/);
  assert.match(filePanelSource, /dirty: hasUnsavedWorkspaceFileEdits\(targetKey, node\.path\)/);
});

test('rename warns about the draft it discards', () => {
  // Re-pointing a tab remounts it on the new path, so the draft goes with the
  // old one — the same loss the delete confirmation warns about. The warning
  // moved onto the inline row with the dialog's removal (#322).
  assert.match(filePanelSource, /hasUnsavedWorkspaceFileEdits\(targetKey, input\.path\)/);
  assert.match(filePanelSource, /unsaved edits, and they are discarded by the rename/);
  assert.match(inlineRowSource, /data-testid="workspace-inline-input-hint"/);
});

test('only a folder delete asks the server to recurse', () => {
  assert.match(filePanelSource, /recursive: request\.kind === "directory"/);
  assert.match(mutationClientSource, /if \(options\.recursive\) search\.set\("recursive", "1"\)/);
});

test('open tabs follow a rename and close on a delete', () => {
  assert.match(filePanelSource, /repointWorkspaceFileTabs\(target, renamed\.previousPath, renamed\.path\)/);
  assert.match(filePanelSource, /closeWorkspaceFileTabsFor\(target, request\.path\)/);
  // A folder operation moves everything under it, so matching the path alone
  // would leave the tabs inside it pointed at nothing.
  assert.match(tabSyncSource, /openPath\.startsWith\(`\$\{mutatedPath\}\/`\)/);
});

test('a rename is a rename, never a move', () => {
  // The inline input submits the bare name the row already had; PATCH carries
  // that name and never a path, so the server's same-directory rule holds.
  assert.match(inlineStateSource, /return \{ kind: "rename", path: input\.path, newName: name \}/);
  assert.match(mutationClientSource, /body: JSON\.stringify\(\{ path, newName \}\)/);
});

test('name entry happens inline, and the name-entry dialogs are gone', () => {
  for (const dead of ['workspace-new-file-dialog.tsx', 'workspace-entry-name-dialog.tsx']) {
    assert.equal(
      fs.existsSync(new URL(`../src/components/workspace/${dead}`, import.meta.url)),
      false,
      `${dead} was replaced by the inline input (#322)`,
    );
    assert.ok(!filePanelSource.includes(dead.replace(/\.tsx$/, '')));
  }
  assert.match(inlineRowSource, /data-testid="workspace-inline-input"/);
  assert.match(inlineRowSource, /data-testid="workspace-inline-input-row"/);
  // Enter commits, Esc abandons without a request of any kind.
  assert.match(inlineRowSource, /event\.key === "Enter"/);
  assert.match(inlineRowSource, /event\.key === "Escape"/);
  assert.match(inlineStateSource, /if \(!name\) return \{ kind: "cancel" \}/);
});

test('a refused name is reported beside the input, not in a toast or a modal', () => {
  // The hook keeps the input open and holds the server's message; the row
  // renders it under the field so the name can be fixed where it was typed.
  assert.match(inlineHookSource, /setError\(caught instanceof Error \? caught\.message/);
  assert.match(inlineRowSource, /data-testid="workspace-inline-input-error"/);
  assert.doesNotMatch(inlineRowSource, /toast/i);
});

test('a blur commits before the row can be unmounted out from under it', () => {
  // A deferred blur is lost with the row: opening another input unmounts this
  // one and the cleanup takes the pending timer — and the typed name — with it.
  assert.match(inlineRowSource, /onBlur=\{\(event\) => commit\(event\.currentTarget\.value\)\}/);
  assert.doesNotMatch(inlineRowSource, /setTimeout/);
  // The late reply of that commit must not land on whatever opened next.
  assert.match(inlineHookSource, /generationRef\.current \+= 1/);
  assert.match(inlineHookSource, /if \(generationRef\.current === generation\) close\(\)/);
  assert.match(inlineHookSource, /if \(generationRef\.current !== generation\) return/);
});

test('an input from another workspace cannot strand this panel', () => {
  // The panel outlives a workspace switch. An input left behind would create at
  // the new root — and, worse, hold the watch refresh back for good, which is
  // why the open input is derived against the current session rather than
  // reset in an effect.
  assert.match(inlineHookSource, /opened\.workspaceKey === handlers\.workspaceKey \? opened\.input : null/);
  assert.match(inlineHookSource, /current\.workspaceKey === handlersRef\.current\.workspaceKey/);
  assert.match(filePanelSource, /onRename: renameEntry,\s*\n\s*workspaceKey: targetKey,/);
});

test('a file click previews once and its double-click respects Kanban Peek', () => {
  // Both clicks reach the row, but only the first is an independent preview.
  assert.match(fileRowSource, /if \(!shouldOpenOnRowClick\(event\.detail\)\) return;/);
  assert.match(inlineStateSource, /return clickCount === 1/);
  assert.match(
    fileRowSource,
    /previewWorkspaceTargetFileTab\(target, 'file', node\.path, \{\s*preferKanbanPeek: true,/,
  );

  const doubleClick = fileRowSource.match(
    /onDoubleClick=\{\(\) => \{(?<body>[\s\S]*?)\n\s*\}\}\s*onKeyDown/,
  );
  assert.ok(doubleClick?.groups?.body, 'the file row owns a double-click handler');
  assert.match(doubleClick.groups.body, /openWorkspaceTargetFileTab\(target, 'file', node\.path/);
  assert.match(
    doubleClick.groups.body,
    /preferKanbanPeek: true/,
    'double-click pins in List mode but must stay inside Kanban Peek mode',
  );
  // F2 renames; Enter still activates the row, so the keyboard can open a file.
  assert.match(fileRowSource, /if \(!canMutate \|\| event\.key !== "F2"\) return;/);
});

test('folder toggles have no delayed timer that can fire under an input', () => {
  assert.doesNotMatch(filePanelSource, /DIR_TOGGLE_DOUBLE_CLICK_MS/);
  assert.doesNotMatch(filePanelSource, /deferredToggleRef/);
  const rawStartNew = filePanelSource.match(/inlineInput\.startNew\(/g) ?? [];
  assert.equal(rawStartNew.length, 1, 'startNew is only called from beginNewEntry');
});

test('a watch reconcile cannot take the row being edited', () => {
  // The panel's live sync goes through the hook: while an input is open the
  // reload is held back and applied once, when the input closes.
  assert.match(filePanelSource, /onRefresh: handleLiveRefresh/);
  assert.match(filePanelSource, /handleExternalRefresh\(\)/);
  assert.match(inlineHookSource, /pendingRefreshRef\.current = true/);
  assert.match(inlineHookSource, /handlersRef\.current\.onRefreshFiles\(\)/);
});

test('double-clicking a directory name renames without fighting its toggle', () => {
  // The first click toggles immediately and the second click is ignored before
  // the double-click handler opens rename, so no timer delays ordinary clicks.
  assert.match(directoryRowSource, /onDoubleClick=\{\(event\) => \{\s*if \(!canMutate\) return;\s*event\.stopPropagation\(\);\s*beginRename\(node\);/);
  assert.match(filePanelSource, /if \(!shouldToggleDirectoryOnClick\(event\.detail\)\) return;/);
  assert.match(inlineStateSource, /return clickCount <= 1;/);
});

test('the delete confirmation survives the move to inline entry', () => {
  // Destructive and permanent: this one keeps its explicit acknowledgement.
  assert.match(filePanelSource, /<WorkspaceDeleteDialog/);
  assert.ok(fs.existsSync(
    new URL('../src/components/workspace/workspace-delete-dialog.tsx', import.meta.url),
  ));
});

test('the mutating routes authenticate before parsing a body', () => {
  for (const [name, source] of [
    ['file', fileRouteSource],
    ['directory', directoryRouteSource],
    ['Worktree file', worktreeFileRouteSource],
    ['Worktree directory', worktreeDirectoryRouteSource],
  ]) {
    const authIndex = source.indexOf('requireAuthenticatedUserId');
    const bodyIndex = source.indexOf('request.json()');
    assert.ok(authIndex !== -1, `${name} route authenticates`);
    assert.ok(authIndex < bodyIndex, `${name} route authenticates before reading the body`);
  }
  assert.match(fileRouteSource, /export async function DELETE\(/);
  assert.match(fileRouteSource, /export async function PATCH\(/);
  assert.match(directoryRouteSource, /export async function POST\(/);
  assert.match(worktreeFileRouteSource, /export async function DELETE\(/);
  assert.match(worktreeFileRouteSource, /export async function PATCH\(/);
  assert.match(worktreeDirectoryRouteSource, /export async function POST\(/);
});

test('the tree mutations run under the shared filesystem deadline', () => {
  const mutationsSource = read('../src/lib/workspace-files/workspace-file-mutations.ts');
  assert.match(mutationsSource, /withFsDeadline\(fs\.rename\(/);
  assert.match(mutationsSource, /withFsDeadline\(fs\.mkdir\(/);
  assert.match(mutationsSource, /withFsDeadline\(fs\.rm\(/);
  assert.match(mutationsSource, /withFsDeadline\(fs\.unlink\(/);
  // Every path is resolved by wave 1's write-side resolver, never trusted.
  assert.match(mutationsSource, /resolveWorkspaceWriteTargetOnDisk\(root, input\.path\)/);
});

test('the tree operations reach for no agent-environment escape hatch', () => {
  const sources = [
    ['workspace-file-mutations.ts', read('../src/lib/workspace-files/workspace-file-mutations.ts')],
    ['directory/route.ts', directoryRouteSource],
    ['file/route.ts', fileRouteSource],
    ['workspace-tab-sync.ts', tabSyncSource],
    ['use-workspace-inline-input.ts', inlineHookSource],
    ['workspace-inline-input-state.ts', inlineStateSource],
    ['workspace-inline-input-row.tsx', inlineRowSource],
  ];
  for (const [name, source] of sources) {
    for (const banned of ['os.homedir(', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME']) {
      assert.ok(!source.includes(banned), `${name} must not reach for ${banned}`);
    }
  }
});

test('the files API reports directories in their own right', () => {
  // The route delegates to a shared read helper post-merge; both sides of that
  // contract must still surface `directories`.
  const rootReaderSource = read('../src/lib/workspace-files/read-workspace-root.ts');
  assert.match(rootReaderSource, /directories: result\.directories/);
  assert.match(filesRouteSource, /readWorkspaceRootFiles/);
  // Every early return keeps the same shape, so the client reads one contract.
  for (const source of [filesRouteSource, rootReaderSource]) {
    const emptyListings = source.match(/files: \[\]/g) ?? [];
    const emptyDirectories = source.match(/directories: \[\]/g) ?? [];
    assert.equal(emptyDirectories.length, emptyListings.length);
  }
});

test('the unreachable second explorer is gone', () => {
  // Both wave 1 reviewers called for this: nothing ever built its session id,
  // so the copy could not be reached, tested, or kept in step (#320).
  assert.equal(
    fs.existsSync(new URL('../src/components/workspace/workspace-explorer-tab.tsx', import.meta.url)),
    false,
  );
  assert.ok(!panelContainerSource.includes('WorkspaceExplorerTab'));
  assert.ok(!panelContainerSource.includes('parseWorkspaceExplorerSessionId'));
});
