import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CompactProjectWorktreeRow,
  ProjectWorktreeRow,
} from '../src/components/worktree/project-worktree-row';
import { WorktreeOverview } from '../src/components/worktree/worktree-overview';
import { gitPanelDiffPath, gitPanelReadPath } from '../src/lib/git/git-panel-read';
import { workspaceFileListPath } from '../src/hooks/use-workspace-file-list';
import { usePanelStore } from '../src/stores/panel-store';
import { useTabStore } from '../src/stores/tab-store';
import { useWorkspacePeekStore } from '../src/stores/workspace-peek-store';
import { activateSessionPanel } from '../src/lib/session/focus-session-panel';
import {
  buildWorktreeFileSessionId,
  parseWorkspaceFileSessionId,
  parseWorktreeFileSessionId,
} from '../src/lib/workspace-tabs/special-session';
import {
  previewWorkspaceTargetFileTab,
  previewWorktreeFileTab,
} from '../src/lib/workspace-tabs/open-workspace-tab';
import { resolveWorkspaceTarget } from '../src/types/worktree';

const chatLayoutSource = fs.readFileSync(
  new URL('../src/components/chat/chat-layout.tsx', import.meta.url),
  'utf8',
);

test('Project Worktree rows render detailed and compact variants', () => {
  const row = renderToStaticMarkup(createElement(ProjectWorktreeRow, {
    active: true,
    branch: 'feature/root-target',
    name: 'tessera-dev',
    displayPath: '/repo/tessera-dev',
    onSelect: () => {},
  }));
  assert.match(row, /lucide-folder-git-2/);
  assert.match(row, /lucide-git-branch/);
  assert.match(row, /tessera-dev/);
  assert.match(row, /\/repo\/tessera-dev/);
  assert.match(row, /feature\/root-target/);
  assert.match(row, /aria-current="true"/);
  assert.match(row, /data-variant="detailed"/);

  const compactRow = renderToStaticMarkup(createElement(CompactProjectWorktreeRow, {
    active: false,
    branch: 'feature/root-target',
    displayPath: '/repo/tessera-dev',
    onSelect: () => {},
  }));
  assert.match(compactRow, /lucide-folder-git-2/);
  assert.match(compactRow, /lucide-git-branch/);
  assert.match(compactRow, /\/repo\/tessera-dev/);
  assert.match(compactRow, /feature\/root-target/);
  assert.match(compactRow, /data-variant="compact"/);
});

test('Worktree overview renders branch, path, and creation actions', () => {
  const overview = renderToStaticMarkup(createElement(WorktreeOverview, {
    branch: 'feature/root-target',
    displayPath: '/repo/root',
    onNewSession: () => {},
    onNewWorktree: () => {},
  }));
  assert.match(overview, /feature\/root-target/);
  assert.match(overview, /\/repo\/root/);
  assert.match(overview, /New Session/);
  assert.match(overview, /New Worktree/);
});

test('selecting a Worktree opens a replaceable Peek without mutating tabs or panels', () => {
  const panels = usePanelStore.getState();
  panels.initTab('worktree-tab', {
    layout: { type: 'leaf', panelId: 'worktree-panel' },
    panels: {
      'worktree-panel': { id: 'worktree-panel', sessionId: 'existing-session' },
    },
    activePanelId: 'worktree-panel',
  });
  panels.setActiveTabId('worktree-tab');
  useTabStore.setState({
    tabs: [{ id: 'worktree-tab', projectDir: 'project-a', title: null, isPreview: false }],
    activeTabId: 'worktree-tab',
    lruTabIds: ['worktree-tab'],
    currentProjectDir: 'project-a',
  });

  const tabsBefore = useTabStore.getState().tabs;
  const panelBefore = usePanelStore.getState().tabPanels['worktree-tab'];
  useWorkspacePeekStore.getState().openWorktree('wt_project_root', 'project-a');

  assert.deepEqual(useWorkspacePeekStore.getState().target, {
    kind: 'worktree',
    worktreeId: 'wt_project_root',
    projectDir: 'project-a',
  });
  assert.strictEqual(useTabStore.getState().tabs, tabsBefore);
  assert.strictEqual(usePanelStore.getState().tabPanels['worktree-tab'], panelBefore);

  useWorkspacePeekStore.getState().openWorktree('wt_linked', 'project-a');
  assert.equal(useWorkspacePeekStore.getState().target?.worktreeId, 'wt_linked');
  assert.equal(useTabStore.getState().tabs.length, 1);

  useWorkspacePeekStore.getState().close();
  assert.equal(useWorkspacePeekStore.getState().target, null);
});

test('activating a Session through the shared navigation seam dismisses Worktree Peek', () => {
  const panelStore = usePanelStore.getState();
  panelStore.initTab('peek-navigation-tab', {
    layout: { type: 'leaf', panelId: 'peek-navigation-panel' },
    panels: {
      'peek-navigation-panel': {
        id: 'peek-navigation-panel',
        sessionId: 'session-a',
      },
    },
    activePanelId: 'peek-navigation-panel',
  });
  panelStore.setActiveTabId('peek-navigation-tab');
  useTabStore.setState({
    tabs: [{ id: 'peek-navigation-tab', projectDir: 'project-a', title: null, isPreview: false }],
    activeTabId: 'peek-navigation-tab',
    lruTabIds: ['peek-navigation-tab'],
    currentProjectDir: 'project-a',
  });
  useWorkspacePeekStore.getState().openWorktree('wt_project_root', 'project-a');

  assert.equal(activateSessionPanel('session-a'), true);
  assert.equal(useWorkspacePeekStore.getState().target, null);
});

test('opening a Worktree file dismisses Peek and targets a Worktree-scoped preview tab', () => {
  const panelStore = usePanelStore.getState();
  panelStore.initTab('worktree-file-tab', {
    layout: { type: 'leaf', panelId: 'worktree-file-panel' },
    panels: {
      'worktree-file-panel': { id: 'worktree-file-panel', sessionId: null },
    },
    activePanelId: 'worktree-file-panel',
  });
  panelStore.setActiveTabId('worktree-file-tab');
  useTabStore.setState({
    tabs: [{ id: 'worktree-file-tab', projectDir: 'project-a', title: null, isPreview: false }],
    activeTabId: 'worktree-file-tab',
    lruTabIds: ['worktree-file-tab'],
    currentProjectDir: 'project-a',
  });
  useWorkspacePeekStore.getState().openWorktree('wt_project_root', 'project-a');

  previewWorktreeFileTab('wt_project_root', 'README.md', 'project-a');

  assert.equal(useWorkspacePeekStore.getState().target, null);
  const activeTabId = useTabStore.getState().activeTabId;
  const activePanel = usePanelStore.getState().tabPanels[activeTabId];
  const specialSessionId = activePanel?.panels[activePanel.activePanelId]?.sessionId;
  assert.deepEqual(parseWorktreeFileSessionId(specialSessionId ?? ''), {
    type: 'worktree-file',
    sourceWorktreeId: 'wt_project_root',
    kind: 'file',
    path: 'README.md',
  });
  assert.equal(useTabStore.getState().tabs.find((tab) => tab.id === activeTabId)?.projectDir, 'project-a');
  assert.equal(
    specialSessionId,
    buildWorktreeFileSessionId('wt_project_root', 'README.md'),
  );
});

test('a composite panel stores its Session and owning Worktree together', () => {
  const state = usePanelStore.getState();
  state.assignSessionInTab('worktree-tab', 'worktree-panel', 'session-composite', 'wt-composite');

  const panel = usePanelStore.getState().tabPanels['worktree-tab']?.panels['worktree-panel'];
  assert.equal(panel?.sessionId, 'session-composite');
  assert.equal(panel?.worktreeId, 'wt-composite');
});

test('a composite target keeps its Session capabilities', () => {
  const target = resolveWorkspaceTarget('session-composite', 'wt-composite');
  assert.deepEqual(target, { kind: 'session', id: 'session-composite' });

  previewWorkspaceTargetFileTab(target!, 'file', 'README.md');
  const activeTabId = useTabStore.getState().activeTabId;
  const activePanel = usePanelStore.getState().tabPanels[activeTabId];
  const specialSessionId = activePanel?.panels[activePanel.activePanelId]?.sessionId ?? '';
  assert.deepEqual(parseWorkspaceFileSessionId(specialSessionId), {
    type: 'workspace-file',
    sourceSessionId: 'session-composite',
    kind: 'file',
    path: 'README.md',
  });
});

test('ChatLayout only drops the active Session for an explicit Worktree Peek', () => {
  assert.match(
    chatLayoutSource,
    /const activeGitTargetSessionId = peekWorktreeId\s*\? null\s*:\s*activeGitSessionId;/,
  );
  assert.equal(
    (chatLayoutSource.match(/sessionId=\{activeGitTargetSessionId\}/g) ?? []).length,
    2,
  );
});

test('sessionless Git and Files reads route by canonical Worktree identity', () => {
  const target = { kind: 'worktree', id: 'wt_project_root' } as const;
  assert.equal(gitPanelReadPath(target), '/api/worktrees/wt_project_root/git');
  assert.equal(
    gitPanelDiffPath(target, 'src/a file.ts'),
    '/api/worktrees/wt_project_root/git/diff?path=src%2Fa%20file.ts',
  );
  assert.equal(workspaceFileListPath(target), '/api/worktrees/wt_project_root/files');
});

test('Worktree diff tabs retain their Worktree target and kind', () => {
  const id = buildWorktreeFileSessionId('wt_project_root', 'src/app.ts', 'diff');
  assert.deepEqual(parseWorktreeFileSessionId(id), {
    type: 'worktree-file',
    sourceWorktreeId: 'wt_project_root',
    kind: 'diff',
    path: 'src/app.ts',
  });
});
