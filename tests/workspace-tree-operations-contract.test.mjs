import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relativePath) =>
  fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const filePanelSource = read('../src/components/workspace/workspace-file-panel.tsx');
const deleteDialogSource = read('../src/components/workspace/workspace-delete-dialog.tsx');
const nameDialogSource = read('../src/components/workspace/workspace-entry-name-dialog.tsx');
const mutationClientSource = read('../src/lib/workspace-files/workspace-file-mutation-client.ts');
const tabSyncSource = read('../src/lib/workspace-tabs/workspace-tab-sync.ts');
const fileRouteSource = read('../src/app/api/sessions/[id]/file/route.ts');
const directoryRouteSource = read('../src/app/api/sessions/[id]/directory/route.ts');
const filesRouteSource = read('../src/app/api/sessions/[id]/files/route.ts');
const fileTabSource = read('../src/components/workspace/workspace-file-tab.tsx');
const panelContainerSource = read('../src/components/panel/panel-container.tsx');

test('the explorer offers rename and delete on both kinds of row', () => {
  assert.match(filePanelSource, /data-testid="workspace-rename-entry"/);
  assert.match(filePanelSource, /data-testid="workspace-delete-entry"/);
  // A folder row deletes as a directory, a file row as a file: the two take
  // different confirmation copy and only one sends `recursive`.
  assert.match(filePanelSource, /setDeleteRequest\(\{ kind: "directory", path: node\.path \}\)/);
  assert.match(filePanelSource, /kind: "file",\s*\n\s*path: node\.path,/);
});

test('folders can be created at the root and inside a row', () => {
  assert.match(filePanelSource, /data-testid="workspace-new-folder"/);
  assert.match(filePanelSource, /data-testid="workspace-new-folder-in-folder"/);
  assert.match(filePanelSource, /onClick=\{\(\) => setNewFolderDirectory\(""\)\}/);
  assert.match(filePanelSource, /onClick=\{\(\) => setNewFolderDirectory\(node\.path\)\}/);
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
  assert.match(fileTabSource, /markWorkspaceFileDirty\(sourceSessionId, path\)/);
  assert.match(fileTabSource, /clearWorkspaceFileDirty\(sourceSessionId, path\)/);
  assert.match(filePanelSource, /dirty: hasUnsavedWorkspaceFileEdits\(sessionId, node\.path\)/);
});

test('only a folder delete asks the server to recurse', () => {
  assert.match(filePanelSource, /recursive: request\.kind === "directory"/);
  assert.match(mutationClientSource, /if \(options\.recursive\) search\.set\("recursive", "1"\)/);
});

test('open tabs follow a rename and close on a delete', () => {
  assert.match(filePanelSource, /repointWorkspaceFileTabs\(sessionId, renamed\.previousPath, renamed\.path\)/);
  assert.match(filePanelSource, /closeWorkspaceFileTabsFor\(sessionId, request\.path\)/);
  // A folder operation moves everything under it, so matching the path alone
  // would leave the tabs inside it pointed at nothing.
  assert.match(tabSyncSource, /openPath\.startsWith\(`\$\{mutatedPath\}\/`\)/);
});

test('the rename dialog refuses to be a move', () => {
  assert.match(filePanelSource, /a name cannot contain a slash/);
  assert.match(nameDialogSource, /data-testid=\{`\$\{testIdPrefix\}-error`\}/);
  // PATCH carries a bare name, never a path.
  assert.match(mutationClientSource, /body: JSON\.stringify\(\{ path, newName \}\)/);
});

test('the mutating routes authenticate before parsing a body', () => {
  for (const [name, source] of [['file', fileRouteSource], ['directory', directoryRouteSource]]) {
    const authIndex = source.indexOf('requireAuthenticatedUserId');
    const bodyIndex = source.indexOf('request.json()');
    assert.ok(authIndex !== -1, `${name} route authenticates`);
    assert.ok(authIndex < bodyIndex, `${name} route authenticates before reading the body`);
  }
  assert.match(fileRouteSource, /export async function DELETE\(/);
  assert.match(fileRouteSource, /export async function PATCH\(/);
  assert.match(directoryRouteSource, /export async function POST\(/);
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
  ];
  for (const [name, source] of sources) {
    for (const banned of ['os.homedir(', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME']) {
      assert.ok(!source.includes(banned), `${name} must not reach for ${banned}`);
    }
  }
});

test('the files API reports directories in their own right', () => {
  assert.match(filesRouteSource, /directories: result\.directories/);
  // Every early return keeps the same shape, so the client reads one contract.
  const emptyListings = filesRouteSource.match(/files: \[\]/g) ?? [];
  const emptyDirectories = filesRouteSource.match(/directories: \[\]/g) ?? [];
  assert.equal(emptyDirectories.length, emptyListings.length);
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
