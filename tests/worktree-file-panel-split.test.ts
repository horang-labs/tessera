import assert from 'node:assert/strict';
import test from 'node:test';
import { usePanelStore } from '../src/stores/panel-store';
import { buildWorktreeFileSessionId } from '../src/lib/workspace-tabs/special-session';
import { resolveWorkspaceTarget } from '../src/types/worktree';

test('splitting B beside A without a Session retains the Files Worktree target', () => {
  const store = usePanelStore.getState();
  store.initTab('file-split', {
    layout: { type: 'leaf', panelId: 'a' },
    panels: { a: { id: 'a', sessionId: buildWorktreeFileSessionId('wt-a', 'A.txt'), worktreeId: 'wt-a' } },
    activePanelId: 'a',
  });
  store.setActiveTabId('file-split');
  const b = store.splitPanel('a', 'horizontal', buildWorktreeFileSessionId('wt-a', 'B.mp4'))!;
  const state = usePanelStore.getState().tabPanels['file-split'];
  assert.equal(state.activePanelId, b);
  assert.deepEqual(resolveWorkspaceTarget(null, state.panels[b].worktreeId), { kind: 'worktree', id: 'wt-a' });
  const c = store.splitPanel(b, 'vertical', buildWorktreeFileSessionId('wt-other', 'C.png'))!;
  assert.equal(usePanelStore.getState().tabPanels['file-split'].panels[c].worktreeId, 'wt-other');
});
