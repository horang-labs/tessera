import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const focusHelper = read('../src/lib/session/focus-session-panel.ts');
const panelWrapper = read('../src/components/panel/panel-wrapper.tsx');
const tabBar = read('../src/components/tab/tab-bar.tsx');
const clickHandlers = read('../src/hooks/use-session-click-handlers.ts');
const chatLayout = read('../src/components/chat/chat-layout.tsx');
const runningProcessPanel = read('../src/components/layout/running-process-panel.tsx');
const notificationCenter = read('../src/components/notifications/notification-center.tsx');
const toastContainer = read('../src/components/notifications/toast-container.tsx');

test('session activation helper selects tab, panel, and composer focus together', () => {
  assert.match(focusHelper, /export function activateSessionPanel/);
  assert.ok(
    focusHelper.indexOf('tabStore.setActiveTab(location.tabId)') <
      focusHelper.indexOf('setActivePanelId(location.panelId)'),
  );
  assert.ok(
    focusHelper.indexOf('setActivePanelId(location.panelId)') <
      focusHelper.indexOf('focusPanelControl(location.panelId)'),
  );
});

test('panel focus only treats a panel as active in the visible active tab', () => {
  assert.match(panelWrapper, /s\.activeTabId === tabId && s\.tabPanels\[tabId\]\?\.activePanelId === panelId/);
});

test('tab clicks refocus the active panel even when the tab is already active', () => {
  assert.match(tabBar, /focusPanelControl\(targetPanelId\)/);
  assert.doesNotMatch(tabBar, /if \(tabId === tabStore\.activeTabId\) return/);
});

test('session-open surfaces activate the located panel instead of only activeSessionId', () => {
  for (const source of [
    clickHandlers,
    chatLayout,
    runningProcessPanel,
    notificationCenter,
    toastContainer,
  ]) {
    assert.match(source, /activateSessionPanel\(/);
  }
  assert.doesNotMatch(chatLayout, /if \(location !== null\) return/);
});
