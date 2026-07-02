import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../src/components/chat/workflow/workflow-card.tsx', import.meta.url),
  'utf8',
);

test('workflow card header truncates the title before status metadata', () => {
  assert.match(source, /min-w-0 flex-1 truncate text-xs font-semibold text-\(--text-primary\)/);
});

test('workflow agent rows keep long previews inside a bounded flex track', () => {
  assert.match(source, /group\/agent flex min-w-0 items-center gap-2 overflow-hidden/);
  assert.match(source, /flex min-w-0 flex-1 items-center gap-1\.5/);
  assert.match(source, /hasDetail \? 'max-w-\[45%\]' : 'max-w-full'/);
  assert.match(source, /min-w-0 flex-1 truncate italic text-\(--text-muted\)/);
  assert.match(source, /min-w-0 flex-1 truncate font-mono text-\(--status-success-text\)/);
});
