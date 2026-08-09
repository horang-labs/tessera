import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectWorktreeRow } from '../src/components/worktree/project-worktree-row';
import { WorktreeOverview } from '../src/components/worktree/worktree-overview';
import { gitPanelReadPath } from '../src/lib/git/git-panel-read';
import { workspaceFileListPath } from '../src/hooks/use-workspace-file-list';
import { usePanelStore } from '../src/stores/panel-store';

test('Project Worktree row and overview render branch, path, and creation actions', () => {
  const row = renderToStaticMarkup(createElement(ProjectWorktreeRow, {
    active: true,
    branch: 'feature/root-target',
    label: 'Project Worktree',
    onSelect: () => {},
  }));
  assert.match(row, /lucide-git-branch/);
  assert.match(row, /Project Worktree/);
  assert.match(row, /feature\/root-target/);
  assert.match(row, /aria-current="true"/);

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

test('selecting a Worktree stores a real Worktree target without a placeholder Session', () => {
  const panels = usePanelStore.getState();
  panels.initTab('worktree-tab', {
    layout: { type: 'leaf', panelId: 'worktree-panel' },
    panels: {
      'worktree-panel': { id: 'worktree-panel', sessionId: 'existing-session' },
    },
    activePanelId: 'worktree-panel',
  });
  panels.setActiveTabId('worktree-tab');

  usePanelStore.getState().assignWorktree('worktree-panel', 'wt_project_root');

  const selected = usePanelStore.getState().tabPanels['worktree-tab'].panels['worktree-panel'];
  assert.equal(selected.sessionId, null);
  assert.equal(selected.worktreeId, 'wt_project_root');
  assert.equal(
    Object.values(usePanelStore.getState().tabPanels['worktree-tab'].panels)
      .some((panel) => panel.sessionId === 'wt_project_root'),
    false,
  );
});

test('sessionless Git and Files reads route by canonical Worktree identity', () => {
  const target = { kind: 'worktree', id: 'wt_project_root' } as const;
  assert.equal(gitPanelReadPath(target), '/api/worktrees/wt_project_root/git');
  assert.equal(workspaceFileListPath(target), '/api/worktrees/wt_project_root/files');
});
