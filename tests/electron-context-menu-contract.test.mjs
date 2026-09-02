import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const contextMenuSource = fs.readFileSync(
  new URL('../electron/web-contents-context-menu.ts', import.meta.url),
  'utf8',
);

test('Electron context menu does not show Select All for inert app chrome', () => {
  assert.match(contextMenuSource, /if \(params\.isEditable\) \{/);
  assert.match(contextMenuSource, /params\.selectionText\.length > 0/);
  assert.doesNotMatch(
    contextMenuSource,
    /if \(editFlags\.canSelectAll\) \{\s*return \[\{ role: 'selectAll' \}\];\s*\}/,
  );
});
