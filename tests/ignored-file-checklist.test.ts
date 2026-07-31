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

test('a script with no block yet takes the defaults', () => {
  const { tickedPaths } = buildIgnoredFileChecklist(SCAN, 'npm install');

  assert.deepEqual([...tickedPaths].sort(), ['.claude', '.env.local']);
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

test('an emptied block is no block, so the defaults come back', () => {
  const cleared = rewriteCopyBlock(rewriteCopyBlock('npm install', [directory('.claude')]), []);

  const { tickedPaths } = buildIgnoredFileChecklist(SCAN, cleared);

  assert.deepEqual([...tickedPaths].sort(), ['.claude', '.env.local']);
});

test('an empty scan against an empty script offers nothing', () => {
  assert.deepEqual(buildIgnoredFileChecklist([], ''), { entries: [], tickedPaths: [] });
});
