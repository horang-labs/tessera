import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTabDisplayTitle } from '@/lib/tab/tab-display-title';
import {
  ARCHIVE_DASHBOARD_SESSION_ID,
  SKILLS_DASHBOARD_SESSION_ID,
} from '@/lib/constants/special-sessions';
import { buildWorkspaceFileSessionId } from '@/lib/workspace-tabs/special-session';

/**
 * The name a tab carries is derived once and read in two places: the desktop
 * strip and the Phone viewport control that replaces it (#247). These cases are
 * the strip's rendered behaviour before the extraction, so a divergence between
 * the two surfaces shows up here rather than on a phone.
 */

/** Enough of the i18n `t` to name the keys this derivation reaches for. */
const t = (key: string) => {
  const known: Record<string, string> = {
    'chat.newTabDefault': 'New Tab',
    'skill.dashboardTitle': 'Skills',
    'archive.title': 'Archive',
  };
  return known[key] ?? key;
};

const emptyTab = {
  tabTitle: null,
  activePanelSessionId: null,
  activePanelTerminalId: null,
  session: undefined,
  t,
};

test('a tab with nothing on it falls back to the new-tab label', () => {
  assert.equal(resolveTabDisplayTitle(emptyTab), 'New Tab');
});

test('a renamed tab keeps its own title over everything else', () => {
  assert.equal(
    resolveTabDisplayTitle({
      ...emptyTab,
      tabTitle: 'Renamed',
      activePanelSessionId: 'session-1',
      activePanelTerminalId: 'terminal-1',
      session: { id: 'session-1', title: 'Session one' },
    }),
    'Renamed',
  );
});

test('a session tab is named after its session', () => {
  assert.equal(
    resolveTabDisplayTitle({
      ...emptyTab,
      activePanelSessionId: 'session-1',
      session: { id: 'session-1', title: 'Fix the tab strip' },
    }),
    'Fix the tab strip',
  );
});

test('a session with no title of its own falls back to its id', () => {
  assert.equal(
    resolveTabDisplayTitle({
      ...emptyTab,
      activePanelSessionId: 'session-1',
      session: { id: 'session-1', title: null },
    }),
    'session-1',
  );
});

test('a session the store has not loaded yet is not named after it', () => {
  assert.equal(
    resolveTabDisplayTitle({ ...emptyTab, activePanelSessionId: 'session-1' }),
    'New Tab',
  );
});

test('a terminal tab is named Terminal', () => {
  assert.equal(
    resolveTabDisplayTitle({ ...emptyTab, activePanelTerminalId: 'terminal-1' }),
    'Terminal',
  );
});

test('a special session is named through its own translation key', () => {
  assert.equal(
    resolveTabDisplayTitle({ ...emptyTab, activePanelSessionId: SKILLS_DASHBOARD_SESSION_ID }),
    'Skills',
  );
  assert.equal(
    resolveTabDisplayTitle({ ...emptyTab, activePanelSessionId: ARCHIVE_DASHBOARD_SESSION_ID }),
    'Archive',
  );
});

test('a workspace file tab is named after the file, not the new-tab label', () => {
  assert.equal(
    resolveTabDisplayTitle({
      ...emptyTab,
      activePanelSessionId: buildWorkspaceFileSessionId('session-1', 'file', '/repo/src/index.ts'),
    }),
    'index.ts',
  );
});

test('a terminal panel that also carries a session prefers Terminal', () => {
  assert.equal(
    resolveTabDisplayTitle({
      ...emptyTab,
      activePanelSessionId: 'session-1',
      activePanelTerminalId: 'terminal-1',
      session: { id: 'session-1', title: 'Fix the tab strip' },
    }),
    'Terminal',
  );
});
