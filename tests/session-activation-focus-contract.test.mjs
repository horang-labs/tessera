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
const sessionNavigation = read('../src/hooks/use-session-navigation.ts');
const sessionCrud = read('../src/hooks/use-session-crud.ts');
const sessionResume = read('../src/hooks/use-session-resume.ts');
const chatArea = read('../src/components/chat/chat-area.tsx');

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

test('tab click focus restoration does not steal focus from the title editor', () => {
  assert.match(focusHelper, /activeElement\?\.getAttribute\('data-tab-title-editor'\) === 'true'/);
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

test('global session-open surfaces resolve one canonical origin Project', () => {
  assert.match(runningProcessPanel, /projectViewWorkspaceState\.getCanonicalRunningSessions\(\)/);
  assert.match(sessionNavigation, /projectViewWorkspaceState\.getCanonicalSessions\(\)/);
  assert.match(notificationCenter, /getSessionOriginProjectId\(session\)/);
  assert.match(toastContainer, /getSessionOriginProjectId\(session\)/);
});

test('normal session clicks become Shift range anchors before navigation starts', () => {
  const anchorUpdate = clickHandlers.indexOf('setRangeAnchor(session.id)');
  const navigationBranch = clickHandlers.indexOf('// BRANCH B — Normal click');

  assert.notEqual(anchorUpdate, -1);
  assert.ok(anchorUpdate < navigationBranch);
});

test('a late session creation response replaces only its optimistic surface', () => {
  assert.match(sessionCrud, /sessionStore\.addSession\(newSession, \{ activate: false \}\)/);
  assert.match(
    sessionCrud,
    /rebindSessionSurface\(\s*\[tempSessionId\],\s*result\.sessionId,/,
  );

  const responseCompletion = sessionCrud.slice(
    sessionCrud.indexOf('const result = await response.json()'),
    sessionCrud.indexOf("chatStore.loadHistory(result.sessionId, [])"),
  );
  assert.doesNotMatch(
    responseCompletion,
    /selectActiveTab\(ps\).*assignSession/s,
    'the response must not target whichever panel became active while the request was pending',
  );
});

test('late history and resume responses cannot reactivate an abandoned session', () => {
  const historyRequest = sessionNavigation.indexOf('const response = await fetch');
  assert.notEqual(historyRequest, -1);
  assert.match(
    sessionNavigation.slice(0, historyRequest),
    /if \(shouldActivate\) sessionStore\.setActiveSession\(session\.id\)/,
    'an explicit navigation intent should activate before waiting for history',
  );
  assert.doesNotMatch(
    sessionNavigation.slice(historyRequest),
    /setActiveSession\(session\.id\)/,
    'history completion must only hydrate data, never restore stale focus',
  );

  const resumeRequest = sessionResume.indexOf('const response = await fetch');
  assert.notEqual(resumeRequest, -1);
  assert.doesNotMatch(
    sessionResume.slice(resumeRequest),
    /setActiveSession\(sessionId\)/,
    'resume completion must not restore a session after the user moved away',
  );
});

test('passive panel history loading never requests session activation', () => {
  assert.match(
    chatArea,
    /void viewSession\(session, \{ activate: false \}\)/,
  );
});

test('notification toasts choose their surface before awaiting history', () => {
  const openPreview = toastContainer.indexOf('tabStore.openPreview(sessionId)');
  const loadHistory = toastContainer.indexOf('await viewSession(session)');
  assert.notEqual(openPreview, -1);
  assert.notEqual(loadHistory, -1);
  assert.ok(openPreview < loadHistory);
});
