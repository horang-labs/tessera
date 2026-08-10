import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const fileRouteSource = read('../src/app/api/sessions/[id]/file/route.ts');
const writeLibSource = read('../src/lib/workspace-files/workspace-file-write.ts');
const writeTargetSource = read('../src/lib/workspace-files/workspace-file-write-target.ts');
const fileTabSource = read('../src/components/workspace/workspace-file-tab.tsx');
const codeViewSource = read('../src/components/workspace/workspace-code-view.tsx');
const explorerSource = read('../src/components/workspace/workspace-explorer-tab.tsx');
const newFileDialogSource = read('../src/components/workspace/workspace-new-file-dialog.tsx');
const workspaceFileTypeSource = read('../src/types/workspace-file.ts');

test('the read route reports the mtime the optimistic lock is built on', () => {
  assert.match(fileRouteSource, /mtimeMs: fileStat\.mtimeMs/);
  assert.match(workspaceFileTypeSource, /mtimeMs: number/);
});

test('every write goes through the write-side resolver, never a raw client path', () => {
  // The route must not reach the filesystem with a client string itself: the
  // resolver is where containment and the symlink rule are decided.
  assert.doesNotMatch(fileRouteSource, /fs\.writeFile/);
  assert.match(writeLibSource, /resolveWorkspaceWriteTargetOnDisk/);
  assert.match(writeLibSource, /parseWorkspaceWritePath/);
  assert.match(writeLibSource, /resolveWorkspaceWriteTarget\(/);
  assert.match(writeTargetSource, /isInsideWorkspacePath\(rootRealPath, parentRealPath, pathModule\)/);
  assert.match(writeTargetSource, /resolveWorkspaceReadTarget\(/);
});

test('workspace roots come from the session resolver, never this server\'s home', () => {
  assert.match(fileRouteSource, /resolveSessionWorkspaceFilesystemRoot/);
  for (const source of [fileRouteSource, writeLibSource, writeTargetSource]) {
    assert.doesNotMatch(source, /homedir\(\)/);
    assert.doesNotMatch(source, /CLAUDE_CONFIG_DIR|CODEX_HOME|XDG_DATA_HOME/);
  }
});

test('write fs operations are bounded by the same deadline reads use', () => {
  assert.match(writeLibSource, /withFsDeadline\(fs\.writeFile\(/);
  assert.match(writeLibSource, /withFsDeadline\(fs\.stat\(/);
  assert.match(writeLibSource, /withFsDeadline\(fs\.realpath\(/);
  assert.match(writeLibSource, /withFsDeadline\(fs\.lstat\(/);
});

test('creation is atomic and reuses the read-side size ceiling', () => {
  assert.match(writeLibSource, /flag: "wx"/);
  assert.match(writeLibSource, /EEXIST/);
  assert.match(writeLibSource, /already_exists/);
  assert.match(writeLibSource, /MAX_TEXT_FILE_BYTES/);
  assert.match(writeLibSource, /file_too_large", "File is too large to save", 413/);
});

test('the save route authenticates before touching the filesystem', () => {
  assert.match(fileRouteSource, /export async function PUT/);
  assert.match(fileRouteSource, /export async function POST/);
  assert.match(fileRouteSource, /requireAuthenticatedUserId/);
  // Both writers resolve auth + root through the same helper.
  const putBody = fileRouteSource.slice(fileRouteSource.indexOf('export async function PUT'));
  assert.match(putBody, /authenticateAndResolveRoot/);
});

test('a background refresh can never overwrite an unsaved draft', () => {
  // Watcher events, window focus and WS replays all funnel through loadFile.
  assert.match(fileTabSource, /options\?\.silent && \(dirtyRef\.current \|\| activeLoadsRef\.current > 0\)/);
  assert.match(fileTabSource, /if \(options\?\.silent && dirtyRef\.current\) return;/);
  // And an external change while dirty raises the banner instead of reloading.
  assert.match(fileTabSource, /if \(dirtyRef\.current\) \{\s*setConflict\(true\);/);
});

test('our own save does not read as an external change', () => {
  assert.match(fileTabSource, /markSelfWrite\(sourceSessionId, path\)/);
  assert.match(fileTabSource, /if \(isSelfWrite\(sourceSessionId, path\)\) return;/);
  // A failed write wrote nothing, so nothing should stay suppressed.
  assert.match(fileTabSource, /clearSelfWrite\(sourceSessionId, path\)/);
  // The mtime returned by the save is the real defence: it becomes the baseline.
  assert.match(fileTabSource, /mtimeMs: payload\?\.mtimeMs \?\? data\.mtimeMs/);
});

test('the save is guarded by the optimistic lock unless the user chose to overwrite', () => {
  assert.match(fileTabSource, /options\?\.overwrite \? \{\} : \{ baseMtimeMs: data\.mtimeMs \}/);
  assert.match(fileTabSource, /response\.status === 409/);
  // A single in-flight PUT: no autosave queue.
  assert.match(fileTabSource, /draft === null \|\| saving\) return;/);
});

test('only a whole, textual buffer is editable', () => {
  assert.match(fileTabSource, /!fileData\.binary && !fileData\.truncated/);
  assert.match(fileTabSource, /data\.binary \|\| data\.truncated \|\| draft === null/);
  // Diff tabs get no editable buffer: editable is only ever computed for files.
  assert.match(fileTabSource, /kind === "file" \? \(state\.data as WorkspaceFileData \| null\) : null/);
  assert.match(codeViewSource, /readOnly=\{!editable\}/);
  assert.match(codeViewSource, /onChange=\{editable \? onDraftChange : undefined\}/);
});

test('the save shortcut is bound to this view, not to the window', () => {
  assert.match(codeViewSource, /onKeyDown=\{handleSaveShortcut\}/);
  assert.doesNotMatch(codeViewSource, /window\.addEventListener\("keydown"/);
  assert.match(codeViewSource, /event\.metaKey \|\| event\.ctrlKey/);
});

test('a dirty preview tab is pinned so it cannot be replaced out from under the draft', () => {
  assert.match(fileTabSource, /tabStore\.pinTab\(location\.tabId\)/);
});

test('the conflict banner offers reload, overwrite and cancel', () => {
  assert.match(codeViewSource, /workspace-conflict-banner/);
  assert.match(codeViewSource, /onClick=\{onReload\}/);
  assert.match(codeViewSource, /onClick=\{onOverwrite\}/);
  assert.match(codeViewSource, /onClick=\{onCancelConflict\}/);
  // Cancel keeps the draft: it only hides the banner.
  assert.match(fileTabSource, /onCancelConflict=\{\(\) => setConflict\(false\)\}/);
  assert.match(fileTabSource, /onOverwrite=\{\(\) => void saveFile\(\{ overwrite: true \}\)\}/);
});

test('the explorer can create a file at the root and inside a row\'s folder', () => {
  assert.match(explorerSource, /data-testid="workspace-new-file"/);
  assert.match(explorerSource, /data-testid="workspace-new-file-in-folder"/);
  assert.match(explorerSource, /setNewFileDirectory\(directory === "\." \? "" : directory\)/);
  assert.match(newFileDialogSource, /method: "POST"/);
  assert.match(newFileDialogSource, /openWorkspaceFileTab\(sessionId, "file", payload\.path\)/);
  // A name that already exists surfaces the server's message rather than silently succeeding.
  assert.match(newFileDialogSource, /setError\(/);
});
