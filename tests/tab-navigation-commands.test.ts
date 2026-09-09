import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { SHORTCUT_REGISTRY } from '@/lib/keyboard/registry';
import { isGlobalShortcutKeydown, setGlobalShortcutKeys } from '@/lib/keyboard/terminal-passthrough';
import { getAdjacentTabId } from '@/lib/tab/adjacent-tab';

const tabs = ['first', 'second', 'third'].map((id) => ({
  id,
  projectDir: null,
  title: null,
  isPreview: false,
}));

test('adjacent tab navigation commands use the requested shortcuts', () => {
  assert.equal(SHORTCUT_REGISTRY['prev-tab'].default, 'Control+Alt+Shift+PageUp');
  assert.equal(SHORTCUT_REGISTRY['next-tab'].default, 'Control+Alt+Shift+PageDown');
});

test('tab navigation shortcuts pass through a focused terminal to the app', () => {
  setGlobalShortcutKeys([
    SHORTCUT_REGISTRY['prev-tab'].default,
    SHORTCUT_REGISTRY['next-tab'].default,
  ]);

  const event = {
    type: 'keydown',
    key: 'PageUp',
    code: 'PageUp',
    getModifierState: (modifier: string) => ['Control', 'Alt', 'Shift'].includes(modifier),
  } as KeyboardEvent;

  assert.equal(isGlobalShortcutKeydown(event), true);
  setGlobalShortcutKeys([]);
});

test('hovering a tab title exposes both navigation shortcuts', () => {
  const tabItemSource = fs.readFileSync(
    new URL('../src/components/tab/tab-item.tsx', import.meta.url),
    'utf8',
  );

  assert.match(tabItemSource, /id="prev-tab"/);
  assert.match(tabItemSource, /secondaryId="next-tab"/);
});

test('adjacent tab navigation follows visual order and wraps', () => {
  assert.equal(getAdjacentTabId(tabs, 'second', 'previous'), 'first');
  assert.equal(getAdjacentTabId(tabs, 'second', 'next'), 'third');
  assert.equal(getAdjacentTabId(tabs, 'first', 'previous'), 'third');
  assert.equal(getAdjacentTabId(tabs, 'third', 'next'), 'first');
});

test('adjacent tab navigation is a no-op without another valid tab', () => {
  assert.equal(getAdjacentTabId(tabs.slice(0, 1), 'first', 'next'), null);
  assert.equal(getAdjacentTabId(tabs, 'missing', 'next'), null);
});
