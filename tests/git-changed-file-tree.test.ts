import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChangedFileRows } from '../src/lib/git/changed-file-tree';
import {
  expandCommitSelectionItems,
  nextCommitInclusion,
  resolveCommitSelectionRange,
  resolveCommitTreeKeyTarget,
} from '../src/components/git/git-commit-selection';
import type { GitChangedFile } from '../src/types/git';

function file(path: string): GitChangedFile {
  return { path, state: 'modified', displayStatus: 'M', indexStatus: ' ', workTreeStatus: 'M', staged: false, unstaged: true };
}

test('uses Files hierarchy, sorts folders first, and preserves original file objects', () => {
  const files = ['README.md', 'src/lib/z.ts', 'src/components/한글.tsx', 'src/lib/a.ts'].map(file);
  const rows = buildChangedFileRows(files, new Set());
  assert.deepEqual(rows.map(({ kind, path, depth }) => [kind, path, depth]), [
    ['folder', 'src', 0], ['folder', 'src/components', 1], ['file', 'src/components/한글.tsx', 2],
    ['folder', 'src/lib', 1], ['file', 'src/lib/a.ts', 2], ['file', 'src/lib/z.ts', 2], ['file', 'README.md', 0],
  ]);
  const compact = buildChangedFileRows([files[2]], new Set());
  assert.deepEqual(compact[0], { kind: 'folder', path: 'src/components', name: 'src/components', depth: 0, filePaths: ['src/components/한글.tsx'] });
  assert.equal(compact[1].kind === 'file' && compact[1].depth, 1);
  assert.equal(compact[1].kind === 'file' && compact[1].file, files[2]);
});

test('folds single-folder chains and lists every descendant file on each folder row', () => {
  const files = ['.agents/skills/a/SKILL.md', '.agents/skills/b/x/y.md', '.agents/skills/b/z.md'].map(file);
  const rows = buildChangedFileRows(files, new Set(['.agents/skills/b']));
  assert.deepEqual(rows.map((row) => [row.kind, row.name, row.depth, row.kind === 'folder' ? row.filePaths.length : null]), [
    ['folder', '.agents/skills', 0, 3], ['folder', 'a', 1, 1], ['file', 'SKILL.md', 2, null], ['folder', 'b', 1, 2],
  ]);
});

test('collapsed descendants are excluded from Shift selection while sibling files remain visible', () => {
  const files = ['src/a.ts', 'src/hidden/b.ts', 'src/z.ts', 'README.md'].map(file);
  const rows = buildChangedFileRows(files, new Set(['src/hidden']));
  const visible = rows.filter((row) => row.kind === 'file').map((row) => row.path);
  assert.deepEqual(resolveCommitSelectionRange(visible, 'src/a.ts', 'README.md', true).paths,
    ['src/a.ts', 'src/z.ts', 'README.md']);
  assert.deepEqual(buildChangedFileRows(files, new Set(['src'])).map((row) => row.path), ['src', 'README.md']);
});

test('keeps rename metadata, root files and backslashes in Git filenames intact', () => {
  const renamed = { ...file('folder/new.ts'), previousPath: 'old.ts', state: 'renamed' as const };
  const literal = file('literal\\name.ts');
  const rows = buildChangedFileRows([renamed, literal], new Set());
  assert.equal(rows.find((row) => row.kind === 'file' && row.file === renamed)?.path, 'folder/new.ts');
  assert.equal(rows.find((row) => row.path === literal.path)?.depth, 0);
  assert.deepEqual(buildChangedFileRows([], new Set()), []);
});

test('uses the Files tab natural, case-insensitive ordering', () => {
  const rows = buildChangedFileRows(['src/file10.ts', 'src/File2.ts', 'src/file1.ts'].map(file), new Set());
  assert.deepEqual(rows.filter((row) => row.kind === 'file').map((row) => row.name), ['file1.ts', 'File2.ts', 'file10.ts']);
});

test('a range over folder rows expands to every file the folders stand for, once each', () => {
  const files = ['a/x.ts', 'a/y.ts', 'b/z.ts', 'c.ts'].map(file);
  const rows = buildChangedFileRows(files, new Set(['a']));
  const items = rows.map((row) => ({ path: row.path, filePaths: row.kind === 'folder' ? row.filePaths : undefined }));
  const range = resolveCommitSelectionRange(rows.map((row) => row.path), 'a', 'b/z.ts', true).paths;
  assert.deepEqual(range, ['a', 'b', 'b/z.ts']);
  assert.deepEqual(expandCommitSelectionItems(items, range), ['a/x.ts', 'a/y.ts', 'b/z.ts']);
});

test('Space includes a mixed selection and excludes a fully included one', () => {
  const included = new Set(['a', 'b']);
  assert.equal(nextCommitInclusion(['a', 'c'], (path) => included.has(path)), true);
  assert.equal(nextCommitInclusion(['a', 'b'], (path) => included.has(path)), false);
});

test('tree keys follow the expand / step-in / collapse / climb pattern', () => {
  const rows = buildChangedFileRows(['src/lib/a.ts', 'src/b.ts', 'README.md'].map(file), new Set());
  // src, src/lib, src/lib/a.ts, src/b.ts, README.md
  const collapsed = new Set<string>();
  const expanded = (path: string) => !collapsed.has(path);
  assert.deepEqual(resolveCommitTreeKeyTarget(rows, 0, 'ArrowRight', expanded), { kind: 'move', index: 1 });
  assert.deepEqual(resolveCommitTreeKeyTarget(rows, 2, 'ArrowLeft', expanded), { kind: 'move', index: 1 });
  assert.deepEqual(resolveCommitTreeKeyTarget(rows, 1, 'ArrowLeft', expanded), { kind: 'toggle', path: 'src/lib' });
  collapsed.add('src/lib');
  assert.deepEqual(resolveCommitTreeKeyTarget(rows, 1, 'ArrowLeft', expanded), { kind: 'move', index: 0 });
  assert.deepEqual(resolveCommitTreeKeyTarget(rows, 1, 'ArrowRight', expanded), { kind: 'toggle', path: 'src/lib' });
  assert.equal(resolveCommitTreeKeyTarget(rows, 4, 'ArrowRight', expanded), null);
  assert.deepEqual(resolveCommitTreeKeyTarget(rows, 4, 'ArrowDown', expanded), { kind: 'move', index: 4 });
  assert.deepEqual(resolveCommitTreeKeyTarget(rows, -1, 'ArrowDown', expanded), { kind: 'move', index: 0 });
  assert.deepEqual(resolveCommitTreeKeyTarget(rows, 2, 'End', expanded), { kind: 'move', index: 4 });
});
