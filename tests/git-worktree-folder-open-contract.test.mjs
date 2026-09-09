import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sectionsSource = fs.readFileSync(
  new URL('../src/components/git/git-panel-sections.tsx', import.meta.url),
  'utf8',
);
const telemetrySource = fs.readFileSync(
  new URL('../src/lib/telemetry/ui-click.ts', import.meta.url),
  'utf8',
);

test('Git panel Worktree summary exposes an Electron folder-open action', () => {
  assert.match(sectionsSource, /canUseElectronFileActions/);
  assert.match(sectionsSource, /canOpenWorktreeFolder \? \(/);
  assert.match(sectionsSource, /openFilePathOnHost\(data\.worktreePath\)/);
  assert.match(sectionsSource, /aria-label="Open worktree folder"/);
  assert.match(sectionsSource, /<FolderOpen className="h-3\.5 w-3\.5" \/>/);
  assert.match(telemetrySource, /'git\.worktree_folder\.open'/);
});
