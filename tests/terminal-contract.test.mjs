import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const messageTypesSource = fs.readFileSync(new URL('../src/lib/ws/message-types.ts', import.meta.url), 'utf8');
const routingSource = fs.readFileSync(new URL('../src/lib/ws/server-message-routing.ts', import.meta.url), 'utf8');
const wsServerSource = fs.readFileSync(new URL('../src/lib/ws/server.ts', import.meta.url), 'utf8');
const terminalManagerSource = fs.readFileSync(new URL('../src/lib/terminal/terminal-manager.ts', import.meta.url), 'utf8');
const terminalResolverSource = fs.readFileSync(new URL('../src/lib/terminal/terminal-resolver.ts', import.meta.url), 'utf8');
const terminalPanelSource = fs.readFileSync(new URL('../src/components/terminal/terminal-panel.tsx', import.meta.url), 'utf8');
const wsClientSource = fs.readFileSync(new URL('../src/lib/ws/client.ts', import.meta.url), 'utf8');
const panelWrapperSource = fs.readFileSync(new URL('../src/components/panel/panel-wrapper.tsx', import.meta.url), 'utf8');
const panelStoreSource = fs.readFileSync(new URL('../src/stores/panel-store.ts', import.meta.url), 'utf8');
const tabItemSource = fs.readFileSync(new URL('../src/components/tab/tab-item.tsx', import.meta.url), 'utf8');
const tabBarSource = fs.readFileSync(new URL('../src/components/tab/tab-bar.tsx', import.meta.url), 'utf8');
const panelTypesSource = fs.readFileSync(new URL('../src/types/panel.ts', import.meta.url), 'utf8');
const prepareElectronRuntimeSource = fs.readFileSync(new URL('../scripts/prepare-electron-runtime.mjs', import.meta.url), 'utf8');

test('terminal feature declares browser UI and server PTY dependencies', () => {
  assert.ok(packageJson.dependencies['@xterm/xterm']);
  assert.ok(packageJson.dependencies['@xterm/addon-fit']);
  assert.ok(packageJson.dependencies['node-pty']);
});

test('terminal websocket protocol covers process lifecycle', () => {
  for (const type of [
    'terminal_create',
    'terminal_input',
    'terminal_resize',
    'terminal_close',
    'terminal_started',
    'terminal_output',
    'terminal_exit',
    'terminal_error',
  ]) {
    assert.match(messageTypesSource, new RegExp(`type: '${type}'`));
  }
});

test('terminal messages route through the server terminal manager', () => {
  assert.match(routingSource, /bindTerminalSender\(sendToUser\)\.create/);
  assert.match(routingSource, /case 'terminal_create':/);
  assert.match(routingSource, /case 'terminal_input':/);
  assert.match(routingSource, /case 'terminal_resize':/);
  assert.match(routingSource, /case 'terminal_close':/);
});

test('panels can own terminal process identity separately from agent sessions', () => {
  assert.match(panelTypesSource, /terminalId\?: string \| null/);
});

test('terminal processes are cleaned up after the final websocket disconnects', () => {
  assert.match(wsServerSource, /terminalManager\.closeAllForUser\(userId\)/);
});

test('terminal cwd is server validated before spawning a PTY', () => {
  assert.match(terminalManagerSource, /resolveAllowedTerminalCwd/);
  assert.match(terminalResolverSource, /getVisibleProjects/);
  assert.match(terminalResolverSource, /getSession/);
  assert.match(terminalResolverSource, /Terminal cwd must be inside a registered project or active worktree/);
});

test('terminal ownership keys include user id and terminal id', () => {
  assert.match(terminalManagerSource, /getKey\(userId: string, terminalId: string\)/);
  assert.match(terminalManagerSource, /`\$\{userId\}:\$\{terminalId\}`/);
  assert.match(terminalManagerSource, /this\.terminals\.delete\(this\.getKey\(userId, terminalId\)\)/);
});

test('terminal client subscribes before creating the server process', () => {
  assert.ok(
    terminalPanelSource.indexOf('subscribeServerMessages') <
      terminalPanelSource.indexOf('wsClient.createTerminal'),
  );
  assert.match(terminalPanelSource, /connectionStatus !== 'connected'/);
  assert.match(terminalPanelSource, /didCreateTerminal/);
  assert.match(wsClientSource, /createTerminal\(args: \{/);
  assert.match(wsClientSource, /\}\): boolean \{/);
});

test('terminal creation is not tied to active panel focus changes', () => {
  assert.doesNotMatch(terminalPanelSource, /useSessionStore\(\(state\) => state\.activeSessionId\)/);
  assert.doesNotMatch(terminalPanelSource, /useSessionStore\.getState\(\)\.activeSessionId/);
  assert.match(terminalPanelSource, /\}, \[connectionStatus, terminalId, terminalSessionId\]\);/);
});

test('terminal panels preserve the source session context used to create them', () => {
  assert.match(panelTypesSource, /terminalSessionId\?: string \| null/);
  assert.match(panelStoreSource, /assignTerminal\(newPanelId, terminalId, activePanel\.sessionId\)/);
  assert.match(panelStoreSource, /terminalSessionId: oldPanel\.terminalSessionId \?\? null/);
  assert.match(panelStoreSource, /sessionId, terminalId: null, terminalSessionId: null/);
  assert.match(terminalPanelSource, /terminalSessionId: string \| null/);
  assert.match(terminalPanelSource, /sessionId: getSessionSelectionId\(terminalSessionId\)/);
  assert.doesNotMatch(terminalPanelSource, /useSessionStore\.getState\(\)\.activeSessionId/);
});

test('terminal panels expose a panel drag handle', () => {
  assert.match(terminalPanelSource, /setPanelNodeDragData/);
  assert.match(terminalPanelSource, /data-testid="terminal-panel-drag-handle"/);
  assert.match(terminalPanelSource, /data-testid="terminal-panel-empty-drag-region"/);
  assert.match(terminalPanelSource, /draggable/);
});

test('terminal-only tabs can be dragged into another panel tree', () => {
  assert.match(tabItemSource, /Object\.values\(panels\)\.some\(\(panel\) => panel\.terminalId\)/);
  assert.match(tabItemSource, /displayTitle = 'Terminal'/);
  assert.doesNotMatch(panelWrapperSource, /droppedTabTreeId && sourceTabData && Object\.keys\(sourceTabData\.panels\)\.length > 1/);
});

test('terminal panels can be pulled into a new tab from a multi-panel layout', () => {
  assert.match(tabBarSource, /parsePanelNodeDragData/);
  assert.match(tabBarSource, /const terminalId = sourcePanel\?\.terminalId \?\? null/);
  assert.match(tabBarSource, /const terminalSessionId = sourcePanel\?\.terminalSessionId \?\? null/);
  assert.match(tabBarSource, /panelStore\.closePanel\(payload\.panelId\)/);
  assert.match(tabBarSource, /tabStore\.createTab\(null, \{ insertAfterTabId: payload\.tabId \}\)/);
  assert.match(tabBarSource, /assignTerminal\(newPanelId, terminalId, terminalSessionId\)/);
});

test('terminal remount attaches to the existing server process', () => {
  assert.match(terminalManagerSource, /const existing = this\.terminals\.get\(key\)/);
  assert.match(terminalManagerSource, /this\.sendStarted\(existing\)/);
  assert.match(terminalManagerSource, /this\.replayBufferedOutput\(existing\)/);
  assert.doesNotMatch(terminalManagerSource, /this\.close\(options\.terminalId, options\.userId\);\n\n    try/);
});

test('panel node drag preserves terminal panel identity', () => {
  assert.match(panelWrapperSource, /movePanelNode/);
  assert.match(panelStoreSource, /movePanelNode:/);
  assert.match(panelStoreSource, /terminalId: sourcePanel\.terminalId \?\? null/);
  assert.match(panelStoreSource, /terminalId: targetPanel\.terminalId \?\? null/);
  assert.match(panelStoreSource, /terminalSessionId: sourcePanel\.terminalSessionId \?\? null/);
  assert.match(panelStoreSource, /terminalSessionId: targetPanel\.terminalSessionId \?\? null/);
});

test('terminal shell selection follows the configured agent environment', () => {
  assert.match(terminalManagerSource, /getAgentEnvironment/);
  assert.match(terminalManagerSource, /agentEnvironment === 'wsl'/);
  assert.match(terminalManagerSource, /useConpty: false/);
  assert.match(terminalResolverSource, /command: 'wsl\.exe'/);
  assert.match(terminalResolverSource, /args: \['-e', 'sh', '-c', buildWslTerminalScript\(wslCwd\)\]/);
  assert.doesNotMatch(terminalResolverSource, /'-lc'/);
  assert.match(terminalResolverSource, /getent passwd "\$\(id -un\)"/);
  assert.match(terminalResolverSource, /exec "\$shell" -i/);
  assert.match(terminalResolverSource, /resolveWindowsNativeTerminalCwd/);
  assert.match(terminalResolverSource, /isWindowsHostedWslPath/);
  assert.doesNotMatch(terminalResolverSource, /WSL terminal profiles are not supported yet/);
});

test('electron packages node-pty native runtime assets outside the asar', () => {
  assert.ok(packageJson.build.asarUnpack.includes('**/node_modules/node-pty/prebuilds/**'));
  assert.ok(packageJson.build.asarUnpack.includes('**/node_modules/node-pty/build/Release/*.node'));
  assert.match(prepareElectronRuntimeSource, /addDirectory\('node_modules\/node-pty\/lib\/worker'/);
  assert.match(prepareElectronRuntimeSource, /addDirectory\('node_modules\/node-pty\/prebuilds'/);
  assert.match(prepareElectronRuntimeSource, /addDirectory\('node_modules\/node-pty\/build\/Release'/);
  assert.match(prepareElectronRuntimeSource, /node_modules\/node-pty\/prebuilds\//);
  assert.match(prepareElectronRuntimeSource, /\.pdb/);
});
