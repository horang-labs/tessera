import assert from 'node:assert/strict';
import test from 'node:test';
import { planTabMerge } from '@/lib/tab/tab-merge';
import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import type { Tab } from '@/types/tab';
import type { TabPanelData } from '@/types/panel';

const tabs: Tab[] = ['a', 'b', 'c'].map((id) => ({ id, projectDir: '/p', title: null, isPreview: false }));
const panel = (id: string, sessionId: string | null): TabPanelData => ({ layout: { type: 'leaf', panelId: id }, panels: { [id]: { id, sessionId } }, activePanelId: id });

test('merge plan uses tab and DFS order, not click or object insertion order', () => {
  const plan = planTabMerge(tabs, { a: panel('a-panel', 'a'), b: panel('b-panel', 'b'), c: panel('c-panel', 'c') }, ['c', 'b']);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(plan.sourceTabIds, ['b', 'c']);
  assert.deepEqual(plan.panels.map((item) => item.id), ['b-panel', 'c-panel']);
  assert.equal(plan.insertionIndex, 1);
});

test('merge plan rejects stale selections and conflicting duplicate sessions before mutations', () => {
  assert.deepEqual(planTabMerge(tabs, { a: panel('a-panel', 'a'), b: panel('b-panel', 'b'), c: panel('c-panel', 'c') }, ['a', 'gone']), { ok: false, reason: 'stale-selection' });
  assert.deepEqual(planTabMerge(tabs, { a: panel('a-panel', 'same'), b: panel('b-panel', 'same'), c: panel('c-panel', 'c') }, ['a', 'b']), { ok: false, reason: 'duplicate-session-conflict' });
});

test('store merge replaces sources at the first selected position and preserves panel IDs', () => {
  useTabStore.setState({ tabs, activeTabId: 'a', lruTabIds: ['a', 'b', 'c'], projectTabStates: {}, globalTabState: null, tabOrderIdsByScope: {}, activeTabIdsByScope: {}, currentProjectDir: null });
  usePanelStore.setState({ tabPanels: { a: panel('a-panel', 'a'), b: panel('b-panel', 'b'), c: panel('c-panel', 'c') }, activeTabId: 'a' });
  const result = useTabStore.getState().mergeTabs(['c', 'b']);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(useTabStore.getState().tabs.map((tab) => tab.id), ['a', result.tabId]);
  assert.equal(useTabStore.getState().activeTabId, result.tabId);
  assert.deepEqual(Object.keys(usePanelStore.getState().tabPanels[result.tabId]!.panels), ['b-panel', 'c-panel']);
  assert.equal(usePanelStore.getState().tabPanels.b, undefined);
});
