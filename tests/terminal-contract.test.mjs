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
const panelTypesSource = fs.readFileSync(new URL('../src/types/panel.ts', import.meta.url), 'utf8');

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
});

test('terminal client subscribes before creating the server process', () => {
  assert.ok(
    terminalPanelSource.indexOf('subscribeServerMessages') <
      terminalPanelSource.indexOf('wsClient.createTerminal'),
  );
});

test('wsl terminal profiles are blocked until path conversion is implemented', () => {
  assert.match(terminalResolverSource, /WSL terminal profiles are not supported yet/);
});
