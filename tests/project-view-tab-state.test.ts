import assert from 'node:assert/strict';
import test from 'node:test';

import { usePanelStore } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useTabStore } from '@/stores/tab-store';
import { TAB_STORE_KEY } from '@/types/tab';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import { reconcileActiveSessionSurface } from '@/lib/session/reconcile-active-session-surface';

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

test('All Projects collapses disposable New Tabs and keeps occupied tabs through reload and round trips', () => {
  resetWorkspace();
  for (const projectDir of ['project-a', 'project-c']) {
    openSharedSession(projectDir);
    useTabStore.getState().openNewTab();
  }
  useTabStore.getState().switchProject(ALL_PROJECTS_SENTINEL);
  const countEmpty = () => useTabStore.getState().tabs.filter((tab) => {
    const data = usePanelStore.getState().getTabPanelData(tab.id)!;
    return Object.values(data.panels).every((panel) => panel.sessionId === null);
  }).length;
  assert.equal(countEmpty(), 1);
  assert.equal(useTabStore.getState().tabs.length, 3);
  useTabStore.getState().persistToLocalStorage();
  resetWorkspace(false);
  useTabStore.getState().restoreFromLocalStorage();
  assert.equal(countEmpty(), 1);
  assert.equal(useTabStore.getState().tabs.length, 3);
  for (const projectDir of ['project-a', 'project-c']) {
    useTabStore.getState().switchProject(projectDir);
    assert.ok(useTabStore.getState().findSessionLocation(sharedSession.id));
    useTabStore.getState().openNewTab();
  }
  useTabStore.getState().switchProject(ALL_PROJECTS_SENTINEL);
  assert.equal(countEmpty(), 1);
  assert.equal(useTabStore.getState().tabs.length, 3);
});

test('All Projects keeps named, split, worktree and terminal surfaces when collapsing New Tabs', () => {
  resetWorkspace();
  useTabStore.getState().switchProject('project-a');
  const named = useTabStore.getState().createTab();
  useTabStore.getState().renameTab(named, 'Scratch');
  const split = useTabStore.getState().createTab();
  usePanelStore.getState().splitPanel(usePanelStore.getState().getTabPanelData(split)!.activePanelId, 'horizontal');
  const worktree = useTabStore.getState().createTab();
  usePanelStore.getState().assignWorktree(usePanelStore.getState().getTabPanelData(worktree)!.activePanelId, 'worktree-1');
  const terminal = useTabStore.getState().createTab();
  usePanelStore.getState().assignTerminal(usePanelStore.getState().getTabPanelData(terminal)!.activePanelId, 'terminal-1');
  const expectedPanels = structuredClone(usePanelStore.getState().tabPanels);
  useTabStore.getState().switchProject('project-c');
  const activeEmpty = useTabStore.getState().activeTabId;
  useTabStore.getState().switchProject(ALL_PROJECTS_SENTINEL);
  assert.deepEqual(new Set(useTabStore.getState().tabs.map((tab) => tab.id)), new Set([activeEmpty, named, split, worktree, terminal]));
  for (const id of [named, split, worktree, terminal]) {
    assert.deepEqual(usePanelStore.getState().getTabPanelData(id), expectedPanels[id]);
  }
});

test('collapsing New Tabs keeps the active empty surface and the preceding Session project', () => {
  resetWorkspace();
  useSessionStore.setState({projects: ['a', 'b'].map((name) => ({
    ...project(`project-${name}`),
    sessions: [{...sharedSession, id: name, projectDir: `project-${name}`}],
  }))});
  for (const name of ['a', 'b']) {
    useTabStore.getState().switchProject(`project-${name}`);
    useTabStore.getState().createTabWithSession(name);
    useTabStore.getState().openNewTab();
  }
  const emptyB = useTabStore.getState().activeTabId;
  assert.equal(useSessionStore.getState().lastActiveProjectDir, 'project-b');
  useTabStore.getState().switchProject(ALL_PROJECTS_SENTINEL);
  assert.equal(useTabStore.getState().activeTabId, emptyB);
  assert.equal(useSessionStore.getState().activeSessionId, null);
  assert.equal(useSessionStore.getState().lastActiveProjectDir, 'project-b');
});

test('A -> All Projects -> A preserves session panels and the project selection', () => {
  resetWorkspace();
  useSessionStore.setState({
    projects: [{
      ...project('project-a'),
      sessions: ['a1', 'a2', 'a3'].map((id) => ({ ...sharedSession, id })),
    }],
  });
  useTabStore.getState().switchProject('project-a');
  for (const id of ['a1', 'a2', 'a3']) useTabStore.getState().createTabWithSession(id);
  const tabs = [...useTabStore.getState().tabs];
  const panels = structuredClone(usePanelStore.getState().tabPanels);
  const selectedInA = tabs[2].id;

  for (let round = 0; round < 3; round++) {
    useTabStore.getState().switchProject(ALL_PROJECTS_SENTINEL);
    assert.deepEqual(useTabStore.getState().tabs, tabs);
    // ChatLayout runs this bridge after changing the visible project scope.
    for (const index of [2, 1, 0]) {
      useTabStore.getState().setActiveTab(tabs[index].id);
      reconcileActiveSessionSurface(`a${index + 1}`);
    }
    useTabStore.getState().switchProject('project-a');
    assert.deepEqual(useTabStore.getState().tabs, tabs);
    assert.deepEqual(usePanelStore.getState().tabPanels, panels, 'session panels must never become blank');
    assert.equal(useTabStore.getState().activeTabId, selectedInA, 'A remembers its own selection');
  }
});

test('All Projects shares open/close and panel edits while each scope retains order and selection after reload', () => {
  resetWorkspace();
  useSessionStore.setState({
    projects: ['a', 'b'].map((name) => ({
      ...project(`project-${name}`),
      sessions: [1, 2, 3, 4].map((index) => ({
        ...sharedSession,
        id: `${name}${index}`,
        projectDir: `project-${name}`,
        originProjectId: `project-${name}`,
      })),
    })),
  });
  useTabStore.getState().switchProject('project-a');
  for (const id of ['a1', 'a2']) useTabStore.getState().createTabWithSession(id);
  const tabsA = [...useTabStore.getState().tabs];
  useTabStore.getState().switchProject('project-b');
  for (const id of ['b1', 'b2', 'b3']) useTabStore.getState().createTabWithSession(id);
  const tabsB = [...useTabStore.getState().tabs];
  useTabStore.getState().switchProject(ALL_PROJECTS_SENTINEL);
  assert.equal(useTabStore.getState().tabs.length, 5);
  useTabStore.getState().createTabWithSession('a3');
  const tabA3 = useTabStore.getState().activeTabId;
  assert.equal(useTabStore.getState().tabs.find((tab) => tab.id === tabA3)?.projectDir, 'project-a');
  useTabStore.getState().createTabWithSession('a3');
  assert.equal(useTabStore.getState().tabs.length, 6, 'opening an existing session focuses its tab');
  useTabStore.getState().reorderTab(tabA3, tabsA[0].id);
  useTabStore.getState().closeTab(tabsB[0].id);
  const activePanelId = usePanelStore.getState().getTabPanelData(tabA3)!.activePanelId;
  assert.ok(usePanelStore.getState().splitPanel(activePanelId, 'horizontal', 'a4'));
  const split = structuredClone(usePanelStore.getState().getTabPanelData(tabA3));
  const allOrder = useTabStore.getState().tabs.map((tab) => tab.id);
  useTabStore.getState().persistToLocalStorage();
  resetWorkspace(false);
  useTabStore.getState().restoreFromLocalStorage();
  assert.equal(useTabStore.getState().activeTabId, tabA3);
  assert.deepEqual(useTabStore.getState().tabs.map((tab) => tab.id), allOrder);
  useTabStore.getState().switchProject('project-a');
  assert.deepEqual(useTabStore.getState().tabs.map((tab) => tab.id), [...tabsA.map((tab) => tab.id), tabA3]);
  assert.equal(useTabStore.getState().activeTabId, tabsA[1].id);
  assert.deepEqual(usePanelStore.getState().getTabPanelData(tabA3), split);
  useTabStore.getState().switchProject('project-b');
  assert.deepEqual(useTabStore.getState().tabs.map((tab) => tab.id), tabsB.slice(1).map((tab) => tab.id));
  assert.equal(useTabStore.getState().activeTabId, tabsB[2].id);
  useTabStore.getState().switchProject(ALL_PROJECTS_SENTINEL);
  assert.equal(useTabStore.getState().activeTabId, tabA3);
});

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

test('viewing a linked Session in All Projects keeps its existing Project View ownership', () => {
  resetWorkspace();
  const tabC = openSharedSession('project-c');
  useTabStore.getState().switchProject(ALL_PROJECTS_SENTINEL);
  reconcileActiveSessionSurface(sharedSession.id);
  useTabStore.getState().switchProject('project-c');
  assert.equal(useTabStore.getState().activeTabId, tabC);
  assert.equal(useTabStore.getState().tabs[0].projectDir, 'project-c');
});

test('Project switching preserves the visible order of interleaved global and Project tabs', () => {
  resetWorkspace();

  const tabs = [
    { id: 'project-a-first', projectDir: 'project-a', title: 'A first', isPreview: false },
    { id: 'global-middle', projectDir: null, title: 'Global middle', isPreview: false },
    { id: 'project-a-last', projectDir: 'project-a', title: 'A last', isPreview: false },
  ];
  const panelData = (tabId: string) => ({
    layout: { type: 'leaf' as const, panelId: `${tabId}-panel` },
    panels: { [`${tabId}-panel`]: { id: `${tabId}-panel`, sessionId: null } },
    activePanelId: `${tabId}-panel`,
  });
  const projectCTab = {
    id: 'project-c-only',
    projectDir: 'project-c',
    title: 'C only',
    isPreview: false,
  };

  useTabStore.setState({
    ...useTabStore.getInitialState(),
    tabs,
    activeTabId: 'project-a-first',
    lruTabIds: tabs.map((tab) => tab.id),
    currentProjectDir: 'project-a',
    projectTabStates: {
      'project-c': {
        tabs: [projectCTab],
        activeTabId: projectCTab.id,
        lruTabIds: [projectCTab.id],
        tabPanelSnapshots: { [projectCTab.id]: panelData(projectCTab.id) },
      },
    },
    globalTabState: null,
  });
  usePanelStore.setState({
    activeTabId: 'project-a-first',
    tabPanels: Object.fromEntries(tabs.map((tab) => [tab.id, panelData(tab.id)])),
  });

  const originalOrder = tabs.map((tab) => tab.id);
  useTabStore.getState().switchProject('project-c');
  useTabStore.getState().switchProject('project-a');

  assert.deepEqual(
    useTabStore.getState().tabs.map((tab) => tab.id),
    originalOrder,
  );

  useTabStore.getState().persistToLocalStorage();
  resetWorkspace(false);
  useTabStore.getState().restoreFromLocalStorage();
  assert.deepEqual(
    useTabStore.getState().tabs.map((tab) => tab.id),
    originalOrder,
    'reload must preserve the same visible order',
  );
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
    projectViewWorkspaceState.resolveSession(sharedSession.id, 'project-c')?.projectDir,
    'project-c',
  );

  useTabStore.getState().switchProject('project-a');
  assert.equal(useTabStore.getState().activeTabId, tabA);
  assert.equal(useTabStore.getState().tabs[0].projectDir, 'project-a');
});

test('reload restores the mounted-tab LRU so retained PTYs can resume in the background', () => {
  resetWorkspace();
  openSharedSession('project-a');
  const emptyTab = useTabStore.getState().openNewTab();
  const expectedLru = [...useTabStore.getState().lruTabIds];
  assert.equal(expectedLru[0], emptyTab);
  assert.equal(expectedLru.length, 2);
  useTabStore.getState().persistToLocalStorage();

  resetWorkspace(false);
  useTabStore.getState().restoreFromLocalStorage();

  assert.deepEqual(useTabStore.getState().lruTabIds, expectedLru);
});

test('an explicit Project lookup never leaks another Project Collection placement', () => {
  resetWorkspace();
  const sessionInA = {
    ...sharedSession,
    collectionId: 'collection-a',
  };
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [
      { ...project('project-a'), sessions: [sessionInA] },
      { ...project('project-c'), sessions: [] },
    ],
  });

  const sessionInC = projectViewWorkspaceState.resolveSession(sharedSession.id, 'project-c');
  assert.equal(sessionInC?.projectDir, 'project-c');
  assert.equal(sessionInC?.collectionId, undefined);
  assert.equal(sessionInC?.originProjectId, 'project-a');
});

test('a retained Session projection keeps a stable selector reference', () => {
  resetWorkspace();
  const retained = {
    ...sharedSession,
    collectionId: 'collection-a',
  };
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [
      { ...project('project-a'), sessions: [] },
      { ...project('project-c'), sessions: [] },
    ],
    retainedSessions: { [retained.id]: retained },
  });

  const first = projectViewWorkspaceState.resolveSession(retained.id, 'project-c');
  const second = projectViewWorkspaceState.resolveSession(retained.id, 'project-c');
  assert.strictEqual(second, first);
  assert.equal(first?.projectDir, 'project-c');
  assert.equal(first?.collectionId, undefined);

  const updated = { ...retained, title: 'Updated conversation' };
  useSessionStore.setState({ retainedSessions: { [updated.id]: updated } });
  const afterUpdate = projectViewWorkspaceState.resolveSession(updated.id, 'project-c');
  assert.notStrictEqual(afterUpdate, first);
  assert.equal(afterUpdate?.title, 'Updated conversation');
});
