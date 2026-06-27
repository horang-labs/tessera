import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const chatLayoutSource = fs.readFileSync(
  new URL('../src/components/chat/chat-layout.tsx', import.meta.url),
  'utf8',
);

test('workspace persistence subscribes to both tab and panel store changes', () => {
  assert.match(chatLayoutSource, /const unsubscribeTabs = useTabStore\.subscribe\(schedulePersist\);/);
  assert.match(chatLayoutSource, /const unsubscribePanels = usePanelStore\.subscribe\(schedulePersist\);/);
  assert.match(chatLayoutSource, /useTabStore\.getState\(\)\.persistToLocalStorage\(\);/);
});

test('workspace persistence flushes synchronously when the app is closed or hidden', () => {
  assert.match(chatLayoutSource, /function flushPersist\(\)/);
  assert.match(chatLayoutSource, /window\.addEventListener\("beforeunload", flushPersist\);/);
  assert.match(chatLayoutSource, /window\.addEventListener\("pagehide", flushPersist\);/);
  assert.match(chatLayoutSource, /window\.removeEventListener\("beforeunload", flushPersist\);/);
  assert.match(chatLayoutSource, /window\.removeEventListener\("pagehide", flushPersist\);/);
});
