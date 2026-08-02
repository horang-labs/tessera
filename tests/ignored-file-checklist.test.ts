import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIgnoredFileChecklist } from '@/lib/projects/ignored-file-checklist';
import { rewriteCopyBlock } from '@/lib/projects/preparation-copy-block';

const file = (path: string) => ({ path, isDirectory: false });
const directory = (path: string) => ({ path, isDirectory: true });

const SCAN = [
  directory('node_modules'),
  file('.env.local'),
  directory('dist'),
  directory('.claude'),
  file('debug.log'),
  file('scratch.txt'),
];

test('an empty script takes the defaults, which is what it is about to be filled with', () => {
  const { tickedPaths } = buildIgnoredFileChecklist(SCAN, '');

  assert.deepEqual([...tickedPaths].sort(), ['.claude', '.env.local']);
});

test('a script somebody wrote arrives with nothing ticked', () => {
  // The defaults are not written into a script that already has lines in it,
  // so showing them ticked would claim copies the script does not make.
  const { tickedPaths } = buildIgnoredFileChecklist(SCAN, 'npm install');

  assert.deepEqual(tickedPaths, []);
});

test('once a block exists it decides the ticks, so unticking survives a reopen', () => {
  const script = rewriteCopyBlock('npm install', [directory('.claude')]);

  const { tickedPaths } = buildIgnoredFileChecklist(SCAN, script);

  // `.env.local` would be ticked by default, and is deliberately not.
  assert.deepEqual(tickedPaths, ['.claude']);
});

test('a candidate the block copies but the scan lost is listed, ticked, and marked', () => {
  const script = rewriteCopyBlock('', [file('.env.gone'), directory('.claude')]);

  const { entries, tickedPaths } = buildIgnoredFileChecklist(SCAN, script);

  const lost = entries.find((entry) => entry.path === '.env.gone');
  assert.ok(lost, 'the lost file is still listed');
  assert.equal(lost.inScriptOnly, true);
  assert.equal(entries[0].path, '.env.gone', 'and it leads, so it is not overlooked');
  assert.ok(tickedPaths.includes('.env.gone'), 'unticking stays the only way it leaves');
});

test('every scanned candidate is listed exactly once, whatever the block holds', () => {
  const script = rewriteCopyBlock('', [directory('.claude'), file('.env.gone')]);

  const { entries } = buildIgnoredFileChecklist(SCAN, script);

  assert.deepEqual(
    entries.map((entry) => entry.path).sort(),
    ['.claude', '.env.gone', '.env.local', 'debug.log', 'dist', 'node_modules', 'scratch.txt'],
  );
});

test('what a worktree is missing is read first, what it is better off without last', () => {
  const { entries } = buildIgnoredFileChecklist(SCAN, '');

  assert.deepEqual(entries.map((entry) => entry.path), [
    '.env.local',   // configuration
    '.claude',      // instructions
    'scratch.txt',  // unrecognised
    'debug.log',    // logs
    'dist',         // build output
    'node_modules', // dependencies
  ]);
});

test('unticking everything stays unticked, rather than the defaults coming back', () => {
  // Emptying the block leaves the user's own line, and that line is the script.
  // Reading the defaults back in would undo, on the next look, what they just
  // did — the tick and the command have to keep saying the same thing.
  const cleared = rewriteCopyBlock(rewriteCopyBlock('npm install', [directory('.claude')]), []);
  assert.equal(cleared, 'npm install');

  const { tickedPaths } = buildIgnoredFileChecklist(SCAN, cleared);

  assert.deepEqual(tickedPaths, []);
});

test('an empty scan against an empty script offers nothing', () => {
  assert.deepEqual(buildIgnoredFileChecklist([], ''), { entries: [], tickedPaths: [] });
});
