import assert from 'node:assert/strict';
import test from 'node:test';

import { usePanelStore } from '@/stores/panel-store';
import { useSelectionStore } from '@/stores/selection-store';
import { useSessionStore } from '@/stores/session-store';
import { buildBalancedPanelLayout, useTabStore } from '@/stores/tab-store';
import type { PanelNode, TabPanelData } from '@/types/panel';
import type { Tab } from '@/types/tab';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';

function leafIds(node: PanelNode): string[] {
  return node.type === 'leaf'
    ? [node.panelId]
    : [...leafIds(node.children[0]), ...leafIds(node.children[1])];
}

function leafTabData(panelId: string, sessionId: string | null): TabPanelData {
  return {
    layout: { type: 'leaf', panelId },
    panels: { [panelId]: { id: panelId, sessionId } },
    activePanelId: panelId,
  };
}

function setVisibleTabs(tabs: Tab[], tabPanels: Record<string, TabPanelData>, activeTabId: string): void {
  useTabStore.setState({
    tabs,
    activeTabId,
    lruTabIds: [activeTabId, ...tabs.map((tab) => tab.id).filter((id) => id !== activeTabId)],
    projectTabStates: {},
    globalTabState: null,
    tabOrderIdsByScope: {},
    currentProjectDir: null,
  });
  usePanelStore.setState({ tabPanels, activeTabId });
  useSelectionStore.getState().clearSelection();
}

test('balanced split layouts preserve panel order for 2, 3, 4, 5, and larger counts', () => {
  for (const count of [2, 3, 4, 5, 11]) {
    const ids = Array.from({ length: count }, (_, index) => `panel-${index + 1}`);
    const layout = buildBalancedPanelLayout(ids);

    assert.ok(layout);
    assert.deepEqual(leafIds(layout), ids);
  }

  const three = buildBalancedPanelLayout(['a', 'b', 'c'])!;
  assert.equal(three.type, 'hsplit');
  assert.equal(three.children[0].type, 'leaf');
  assert.equal(three.children[1].type, 'vsplit');

  const four = buildBalancedPanelLayout(['a', 'b', 'c', 'd'])!;
  assert.equal(four.type, 'hsplit');
  assert.equal(four.children[0].type, 'vsplit');
  assert.equal(four.children[1].type, 'vsplit');

  const five = buildBalancedPanelLayout(['a', 'b', 'c', 'd', 'e'])!;
  assert.equal(five.type, 'hsplit');
  assert.equal(five.children[0].type, 'hsplit');
  assert.equal(five.children[1].type, 'vsplit');
});

test('split view moves selected sessions, closes emptied tabs, retains unrelated surfaces, and activates its tab', () => {
  const sourceTab: Tab = { id: 'source', projectDir: null, title: null, isPreview: false };
  const emptiedTab: Tab = { id: 'emptied', projectDir: null, title: null, isPreview: false };
  const unrelatedTab: Tab = { id: 'unrelated', projectDir: null, title: null, isPreview: false };
  setVisibleTabs(
    [sourceTab, emptiedTab, unrelatedTab],
    {
      source: {
        layout: {
          type: 'hsplit',
          children: [
            { type: 'leaf', panelId: 'source-a' },
            { type: 'leaf', panelId: 'source-b' },
          ],
          ratio: 0.5,
        },
        panels: {
          'source-a': { id: 'source-a', sessionId: 'selected-a' },
          'source-b': { id: 'source-b', sessionId: 'kept-b' },
        },
        activePanelId: 'source-a',
      },
      emptied: leafTabData('emptied-panel', 'selected-c'),
      unrelated: leafTabData('unrelated-panel', 'unrelated-d'),
    },
    sourceTab.id,
  );

  const destinationTabId = useTabStore.getState().createTabWithSessions(['selected-a', 'selected-c']);

  assert.ok(destinationTabId);
  assert.equal(useTabStore.getState().activeTabId, destinationTabId);
  assert.equal(usePanelStore.getState().activeTabId, destinationTabId);
  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === 'emptied'), false);
  assert.deepEqual(
    Object.values(usePanelStore.getState().tabPanels.source!.panels).map((panel) => panel.sessionId),
    ['kept-b'],
  );
  assert.equal(usePanelStore.getState().tabPanels.unrelated?.panels['unrelated-panel']?.sessionId, 'unrelated-d');

  const destination = usePanelStore.getState().tabPanels[destinationTabId!];
  assert.deepEqual(leafIds(destination!.layout).map((panelId) => destination!.panels[panelId]!.sessionId), [
    'selected-a',
    'selected-c',
  ]);
  assert.equal(destination!.panels[destination!.activePanelId]?.sessionId, 'selected-a');
});

test('split view retires a selected session from a hidden global snapshot', () => {
  const visibleTab: Tab = { id: 'visible', projectDir: null, title: null, isPreview: false };
  const hiddenTab: Tab = { id: 'hidden-global', projectDir: null, title: null, isPreview: false };
  setVisibleTabs([visibleTab], { visible: leafTabData('visible-panel', 'visible-session') }, visibleTab.id);
  useTabStore.setState({
    globalTabState: {
      tabs: [hiddenTab],
      activeTabId: hiddenTab.id,
      lruTabIds: [hiddenTab.id],
      tabPanelSnapshots: { [hiddenTab.id]: leafTabData('hidden-panel', 'selected-hidden') },
    },
  });

  const destinationTabId = useTabStore.getState().createTabWithSessions(['selected-hidden']);

  assert.ok(destinationTabId);
  assert.equal(useTabStore.getState().globalTabState, null);
  assert.equal(
    usePanelStore.getState().tabPanels[destinationTabId!]?.panels[
      usePanelStore.getState().tabPanels[destinationTabId!]!.activePanelId
    ]?.sessionId,
    'selected-hidden',
  );
});

test('mixed-project selections create a global tab and retain each session worktree', (t) => {
  const originalSessionState = useSessionStore.getState();
  t.after(() => useSessionStore.setState(originalSessionState, true));

  const session = (id: string, projectDir: string, worktreeId: string): UnifiedSession => ({
    id,
    title: id,
    projectDir,
    originProjectId: projectDir,
    worktreeId,
    isRunning: false,
    status: 'completed',
    lastModified: '',
    createdAt: '',
    archived: false,
  });
  const project = (projectDir: string, worktreeId: string): ProjectGroup => ({
    encodedDir: projectDir,
    displayName: projectDir,
    decodedPath: `/${projectDir}`,
    isCurrent: false,
    sessions: [session(`session-${projectDir}`, projectDir, worktreeId)],
    totalSessions: 1,
    loadedCount: 1,
    allLoaded: true,
    nextCursor: null,
    loadBatchIndex: 0,
  });
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project('project-a', 'worktree-a'), project('project-b', 'worktree-b')],
  }, true);

  const sourceA: Tab = { id: 'source-a', projectDir: 'project-a', title: null, isPreview: false };
  const sourceB: Tab = { id: 'source-b', projectDir: 'project-b', title: null, isPreview: false };
  setVisibleTabs(
    [sourceA, sourceB],
    {
      [sourceA.id]: leafTabData('panel-a', 'session-project-a'),
      [sourceB.id]: leafTabData('panel-b', 'session-project-b'),
    },
    sourceA.id,
  );
  useTabStore.setState({ currentProjectDir: ALL_PROJECTS_SENTINEL });

  const destinationTabId = useTabStore.getState().createTabWithSessions([
    'session-project-a',
    'session-project-b',
  ]);

  assert.ok(destinationTabId);
  assert.equal(
    useTabStore.getState().tabs.find((tab) => tab.id === destinationTabId)?.projectDir,
    null,
  );
  const destination = usePanelStore.getState().tabPanels[destinationTabId!];
  const panelsBySession = Object.fromEntries(
    Object.values(destination!.panels).map((panel) => [panel.sessionId, panel]),
  );
  assert.equal(panelsBySession['session-project-a']?.worktreeId, 'worktree-a');
  assert.equal(panelsBySession['session-project-b']?.worktreeId, 'worktree-b');
});

test('opening the current selection in split view clears it after the tab is created', () => {
  const sourceTab: Tab = { id: 'source', projectDir: null, title: null, isPreview: false };
  setVisibleTabs([sourceTab], { source: leafTabData('source-panel', 'selected-a') }, sourceTab.id);
  useSelectionStore.setState({
    selectedIds: new Set(['selected-a']),
    lastClickedId: 'selected-a',
    barAnchorId: 'selected-a',
  });

  useSelectionStore.getState().openInSplitView();

  const selection = useSelectionStore.getState();
  assert.equal(selection.selectedIds.size, 0);
  assert.equal(selection.lastClickedId, null);
  assert.equal(selection.barAnchorId, null);
  assert.equal(useTabStore.getState().tabs.length, 1);
  assert.equal(
    usePanelStore.getState().tabPanels[useTabStore.getState().activeTabId]?.panels[
      usePanelStore.getState().tabPanels[useTabStore.getState().activeTabId]!.activePanelId
    ]?.sessionId,
    'selected-a',
  );
});
