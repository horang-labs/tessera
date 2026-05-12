import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/lib/session/session-reference.ts', import.meta.url), 'utf8');

test('continue conversation prompt tells agents to recover the latest context from the export tail first', () => {
  assert.match(source, /Continue the conversation from the session export above/);
  assert.match(source, /Read the export from the end first/);
  assert.match(source, /last 200-300 lines/);
  assert.match(source, /latest user request/);
  assert.match(source, /source of truth/);
  assert.match(source, /Do not rely only on the beginning of the file/);
});
