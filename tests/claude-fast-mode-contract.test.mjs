import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const processManagerSource = read('src/lib/cli/process-manager.ts');

test('ProcessManager.sendSetFastMode sends apply_flag_settings control_request', () => {
  assert.match(processManagerSource, /sendSetFastMode\(sessionId: string, fastMode: boolean \| null\): boolean/);
  assert.match(processManagerSource, /subtype: 'apply_flag_settings', settings: \{ fastMode: fastMode === true \? true : null \}/);
  assert.match(processManagerSource, /info\.fastMode = fastMode/);
  assert.match(processManagerSource, /if \(patch\.fastMode !== undefined\) \{\s*info\.fastMode = patch\.fastMode;/);
});

test('set_fast_mode has websocket + routing paths', () => {
  const wsMessageTypesSource = read('src/lib/ws/message-types.ts');
  const wsClientSource = read('src/lib/ws/client.ts');
  const wsHookSource = read('src/hooks/use-websocket.ts');
  const routingSource = read('src/lib/ws/server-message-routing.ts');

  assert.match(wsMessageTypesSource, /type: 'set_fast_mode'/);
  assert.match(wsClientSource, /setFastMode\(sessionId: string, fastMode: boolean \| null\)/);
  assert.match(wsClientSource, /this\.sendRequest\('set_fast_mode', \{ sessionId, fastMode \}\)/);
  assert.match(wsHookSource, /setFastMode/);
  assert.match(routingSource, /case 'set_fast_mode':/);
  assert.match(routingSource, /processManager\.sendSetFastMode\(sessionId, message\.fastMode\)/);
});

test('claude-code fast mode toggle + /fast are wired', () => {
  const composer = read('src/components/chat/composer-session-controls.tsx');
  const messageInput = read('src/components/chat/message-input.tsx');
  const skillPicker = read('src/hooks/use-skill-picker.ts');
  const claudeFastCmd = read('src/lib/chat/claude-fast-command.ts');

  // toggle branches for claude-code on a fastMode boolean
  assert.match(composer, /session\.fastMode === true/);
  assert.match(composer, /isClaudeCodeProvider/);
  assert.match(composer, /setFastMode\(sessionId/);
  assert.match(composer, /updateSessionRuntimeConfig\(sessionId, \{ fastMode/);

  // /fast command for claude-code
  assert.match(claudeFastCmd, /CLAUDE_FAST_BUILTIN_COMMAND = 'claude-fast'/);
  assert.match(skillPicker, /providerId === 'claude-code'/);
  assert.match(messageInput, /executeClaudeFastCommand/);
  assert.match(messageInput, /isClaudeFastCommandSkill/);
});

test('session store + claude-code defaults persist fastMode', () => {
  const sessionStore = read('src/stores/session-store.ts');
  const providerDefaults = read('src/lib/settings/provider-defaults.ts');

  assert.match(sessionStore, /'fastMode'/);
  assert.match(sessionStore, /runtimeConfig\.fastMode !== undefined/);
  assert.match(sessionStore, /fastMode: runtimeConfig\.fastMode/);
  assert.match(sessionStore, /fastMode: 'fastMode' in s \? s\.fastMode : undefined/);
  assert.match(providerDefaults, /fastMode/);
});
