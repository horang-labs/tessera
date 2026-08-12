import assert from 'node:assert/strict';
import test from 'node:test';

import { moveTerminalPanelToNewTab } from '@/lib/tab/terminal-panel-to-new-tab';
import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';

function seedSplitTerminal(): void {
  useTabStore.setState({
    tabs: [{ id: 'source-tab', projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: 'source-tab',
    lruTabIds: ['source-tab'],
    currentProjectDir: '/workspace',
  });
  usePanelStore.setState({
    activeTabId: 'source-tab',
    tabPanels: {
      'source-tab': {
        layout: {
          type: 'hsplit',
          children: [
            { type: 'leaf', panelId: 'chat-panel' },
            { type: 'leaf', panelId: 'terminal-panel' },
          ],
          ratio: 0.5,
        },
        panels: {
          'chat-panel': { id: 'chat-panel', sessionId: 'chat-session' },
          'terminal-panel': {
            id: 'terminal-panel',
            sessionId: null,
            terminalId: 'terminal-1',
            terminalSessionId: 'source-session',
            terminalCwd: '/workspace/worktree',
          },
        },
        activePanelId: 'terminal-panel',
      },
    },
  });
}

test('creating a terminal panel preserves its source session context', () => {
  usePanelStore.setState({
    activeTabId: 'source-context-tab',
    tabPanels: {
      'source-context-tab': {
        layout: { type: 'leaf', panelId: 'source-panel' },
        panels: { 'source-panel': { id: 'source-panel', sessionId: 'source-session' } },
        activePanelId: 'source-panel',
      },
    },
  });

  const terminalPanelId = usePanelStore.getState().createTerminalPanel(
    'source-panel',
    'terminal-1',
  );
  assert.ok(terminalPanelId);
  const panel = usePanelStore.getState().tabPanels['source-context-tab']?.panels[terminalPanelId];
  assert.equal(panel?.sessionId, null);
  assert.equal(panel?.terminalId, 'terminal-1');
  assert.equal(panel?.terminalSessionId, 'source-session');
});

test('moving a terminal panel to a new tab preserves runtime identity and cwd', () => {
  seedSplitTerminal();

  assert.equal(moveTerminalPanelToNewTab({
    tabId: 'source-tab',
    panelId: 'terminal-panel',
  }), true);

  const tabs = useTabStore.getState().tabs;
  const destinationTab = tabs.find((tab) => tab.id !== 'source-tab');
  assert.ok(destinationTab);
  const destination = usePanelStore.getState().tabPanels[destinationTab.id];
  assert.ok(destination);
  const terminal = destination.panels[destination.activePanelId];
  assert.deepEqual(
    {
      terminalId: terminal?.terminalId,
      terminalSessionId: terminal?.terminalSessionId,
      terminalCwd: terminal?.terminalCwd,
    },
    {
      terminalId: 'terminal-1',
      terminalSessionId: 'source-session',
      terminalCwd: '/workspace/worktree',
    },
  );
  assert.equal(useTabStore.getState().activeTabId, 'source-tab');
  assert.equal(usePanelStore.getState().tabPanels['source-tab']?.panels['terminal-panel'], undefined);
});
