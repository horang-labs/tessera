import assert from 'node:assert/strict';
import test from 'node:test';

import { usePanelStore } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useTabStore } from '@/stores/tab-store';
import { TAB_STORE_KEY } from '@/types/tab';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  },
});

const sharedSession: UnifiedSession = {
  id: 'canonical-session',
  title: 'One conversation',
  projectDir: 'project-a',
  originProjectId: 'project-a',
  workDir: '/repository-c',
  provider: 'codex',
  kind: 'chat',
  status: 'completed',
  isRunning: false,
  hasStarted: true,
  archived: false,
  sortOrder: 0,
  createdAt: '2026-08-09T00:00:00.000Z',
  lastModified: '2026-08-09T00:00:00.000Z',
};

function project(projectDir: string): ProjectGroup {
  return {
    encodedDir: projectDir,
    displayName: projectDir,
    decodedPath: '/repository-c',
    isCurrent: projectDir === 'project-a',
    sessions: [{ ...sharedSession, projectDir }],
    totalSessions: 1,
    allLoaded: true,
    loadedCount: 1,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function resetWorkspace(clearStorage = true): void {
  if (clearStorage) storage.clear();
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project('project-a'), project('project-c')],
  });
  useTabStore.setState({
    ...useTabStore.getInitialState(),
    tabs: [{ id: 'bootstrap-tab', projectDir: null, title: null, isPreview: false }],
    activeTabId: 'bootstrap-tab',
    lruTabIds: ['bootstrap-tab'],
    projectTabStates: {},
    globalTabState: null,
    currentProjectDir: null,
  });
  usePanelStore.setState({
    activeTabId: 'bootstrap-tab',
    tabPanels: {
      'bootstrap-tab': {
        layout: { type: 'leaf', panelId: 'bootstrap-panel' },
        panels: { 'bootstrap-panel': { id: 'bootstrap-panel', sessionId: null } },
        activePanelId: 'bootstrap-panel',
      },
    },
  });
}

function openSharedSession(projectDir: string): string {
  useTabStore.getState().switchProject(projectDir);
  useTabStore.getState().createTabWithSession(sharedSession.id);
  return useTabStore.getState().activeTabId;
}

test('the same canonical Session has independent tabs and active targets in A and C', () => {
  resetWorkspace();
  const tabA = openSharedSession('project-a');
  const tabC = openSharedSession('project-c');

  assert.notEqual(tabA, tabC);
  assert.equal(useTabStore.getState().tabs[0].projectDir, 'project-c');

  useTabStore.getState().switchProject('project-a');
  assert.equal(useTabStore.getState().activeTabId, tabA);
  const emptyTabA = useTabStore.getState().openNewTab();
  assert.equal(useTabStore.getState().activeTabId, emptyTabA);

  useTabStore.getState().switchProject('project-c');
  assert.equal(useTabStore.getState().activeTabId, tabC);
  assert.equal(usePanelStore.getState().activeTabId, tabC);
  assert.equal(useTabStore.getState().findSessionLocation(sharedSession.id)?.tabId, tabC);

  useTabStore.getState().switchProject('project-a');
  useTabStore.getState().closeTab(tabA);
  useTabStore.getState().switchProject('project-c');
  assert.equal(useTabStore.getState().findSessionLocation(sharedSession.id)?.tabId, tabC);
  assert.equal(usePanelStore.getState().activeTabId, tabC);
});

test('reload restores each tab through its selected Project projection', () => {
  resetWorkspace();
  const tabA = openSharedSession('project-a');
  const tabC = openSharedSession('project-c');
  useTabStore.getState().persistToLocalStorage();
  assert.ok(storage.get(TAB_STORE_KEY));

  resetWorkspace(false);
  useTabStore.getState().restoreFromLocalStorage();
  assert.equal(useTabStore.getState().currentProjectDir, 'project-c');
  assert.equal(useTabStore.getState().activeTabId, tabC);
  assert.equal(useTabStore.getState().tabs[0].projectDir, 'project-c');
  assert.equal(
    useSessionStore.getState().getSession(sharedSession.id, 'project-c')?.projectDir,
    'project-c',
  );

  useTabStore.getState().switchProject('project-a');
  assert.equal(useTabStore.getState().activeTabId, tabA);
  assert.equal(useTabStore.getState().tabs[0].projectDir, 'project-a');
});
