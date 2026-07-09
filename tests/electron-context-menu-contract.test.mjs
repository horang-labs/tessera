import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const electronMainSource = fs.readFileSync(
  new URL('../electron/main.ts', import.meta.url),
  'utf8',
);

test('Electron context menu does not show Select All for inert app chrome', () => {
  assert.match(electronMainSource, /if \(params\.isEditable\) \{/);
  assert.match(electronMainSource, /if \(params\.selectionText\.length > 0\) \{/);
  assert.doesNotMatch(
    electronMainSource,
    /if \(editFlags\.canSelectAll\) \{\s*return \[\{ role: 'selectAll' \}\];\s*\}/,
  );
});
