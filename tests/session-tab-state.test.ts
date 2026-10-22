import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSessionTabState, getSessionTabGroupState } from '../src/lib/workspace-tabs/session-tab-state';
import type { Tab } from '../src/types/tab';
import type { TabPanelData } from '../src/types/panel';

const tabs: Tab[] = [
  { id: 'a', projectDir: '/repo', title: null, isPreview: false },
  { id: 'b', projectDir: '/repo', title: null, isPreview: true },
];
const split: TabPanelData = {
  layout: { type: 'hsplit', ratio: 0.5, children: [{ type: 'leaf', panelId: 'p' }, { type: 'leaf', panelId: 'q' }] },
  panels: { p: { id: 'p', sessionId: 'focused' }, q: { id: 'q', sessionId: 'split-peer' } },
  activePanelId: 'p',
};
const panels = { a: split, b: { layout: { type: 'leaf' as const, panelId: 'r' }, panels: { r: { id: 'r', sessionId: 'background' } }, activePanelId: 'r' } };

test('only the focused pane is current; split peers and background preview tabs are open', () => {
  assert.equal(getSessionTabState(['focused'], tabs, 'a', panels), 'current');
  assert.equal(getSessionTabState(['split-peer'], tabs, 'a', panels), 'open');
  assert.equal(getSessionTabState(['background'], tabs, 'a', panels), 'open');
  assert.equal(getSessionTabState(['peek-only'], tabs, 'a', panels), 'closed');
  assert.equal(getSessionTabState(['focused'], tabs, 'b', panels), 'open');
  assert.equal(getSessionTabState(['background'], tabs, 'b', panels), 'current');
});

test('scope changes and tab removal ignore retained panel data; split focus changes immediately', () => {
  assert.equal(getSessionTabState(['background'], tabs.slice(0, 1), 'a', panels), 'closed');
  assert.equal(getSessionTabState(['focused'], tabs.slice(1), 'b', panels), 'closed');
  assert.equal(getSessionTabState(['split-peer'], tabs, 'a', { ...panels, a: { ...split, activePanelId: 'q' } }), 'current');
  assert.equal(getSessionTabState(['focused'], tabs, 'a', {}), 'closed');
});

test('task membership aggregates sessions without matching unrelated or empty panels', () => {
  assert.equal(getSessionTabState(['other', 'background'], tabs, 'a', panels), 'open');
  assert.equal(getSessionTabState(['focused', 'split-peer'], tabs, 'a', panels), 'current');
  assert.equal(getSessionTabState([], tabs, 'a', panels), 'closed');
});


test('expanded groups defer the current cue to a visible child, but keep it for capped or collapsed children', () => {
  const group = getSessionTabState(['focused', 'split-peer'], tabs, 'a', panels);
  const hiddenCurrent = getSessionTabState(['split-peer'], tabs, 'a', panels);
  const visibleCurrent = getSessionTabState(['focused'], tabs, 'a', panels);
  assert.equal(getSessionTabGroupState(group, visibleCurrent, true), 'open');
  assert.equal(getSessionTabGroupState(group, hiddenCurrent, true), 'current');
  assert.equal(getSessionTabGroupState(group, visibleCurrent, false), 'current');
  assert.equal(getSessionTabGroupState('open', 'open', true), 'open');
  assert.equal(getSessionTabGroupState('closed', 'closed', true), 'closed');
});
