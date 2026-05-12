import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const messageInputSource = fs.readFileSync(
  new URL('../src/components/chat/message-input.tsx', import.meta.url),
  'utf8',
);
const skillPickerHookSource = fs.readFileSync(
  new URL('../src/hooks/use-skill-picker.ts', import.meta.url),
  'utf8',
);
const wsMessageTypesSource = fs.readFileSync(
  new URL('../src/lib/ws/message-types.ts', import.meta.url),
  'utf8',
);
const wsClientSource = fs.readFileSync(
  new URL('../src/lib/ws/client.ts', import.meta.url),
  'utf8',
);
const wsHookSource = fs.readFileSync(
  new URL('../src/hooks/use-websocket.ts', import.meta.url),
  'utf8',
);
const routingSource = fs.readFileSync(
  new URL('../src/lib/ws/server-message-routing.ts', import.meta.url),
  'utf8',
);
const processManagerSource = fs.readFileSync(
  new URL('../src/lib/cli/process-manager.ts', import.meta.url),
  'utf8',
);
const codexAdapterSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/codex/adapter.ts', import.meta.url),
  'utf8',
);
const sessionStoreSource = fs.readFileSync(
  new URL('../src/stores/session-store.ts', import.meta.url),
  'utf8',
);
const providerOptionsSource = fs.readFileSync(
  new URL('../src/lib/cli/provider-session-options-codex.ts', import.meta.url),
  'utf8',
);
const composerSessionControlsSource = fs.readFileSync(
  new URL('../src/components/chat/composer-session-controls.tsx', import.meta.url),
  'utf8',
);

test('Codex /fast is intercepted by the composer as a service tier toggle', () => {
  assert.match(messageInputSource, /CODEX_FAST_COMMAND/);
  assert.match(messageInputSource, /CODEX_FAST_SERVICE_TIER/);
  assert.match(messageInputSource, /trimmed === CODEX_FAST_COMMAND/);
  assert.match(messageInputSource, /session\?\.provider\?\.trim\(\) !== 'codex'/);
  assert.match(messageInputSource, /updateSessionRuntimeConfig\(sessionId, \{ serviceTier: nextServiceTier \}\)/);
  assert.match(messageInputSource, /setServiceTier\(sessionId, nextServiceTier\)/);
  assert.ok(
    messageInputSource.indexOf('trimmed === CODEX_FAST_COMMAND') <
      messageInputSource.indexOf('const parsed = skillPicker.parseForSend(trimmed);'),
  );
});

test('Codex /fast is exposed through the slash command palette', () => {
  assert.match(skillPickerHookSource, /CODEX_FAST_COMMAND_NAME/);
  assert.match(skillPickerHookSource, /CODEX_FAST_BUILTIN_COMMAND/);
  assert.match(skillPickerHookSource, /providerId === 'codex'/);
  assert.match(skillPickerHookSource, /availableCommands/);
  assert.match(messageInputSource, /isCodexFastCommandSkill\(confirmedSkill\)/);
  assert.match(messageInputSource, /executeCodexFastCommand\(\)/);
  assert.match(messageInputSource, /inputValue\.trim\(\) === CODEX_FAST_COMMAND/);
});

test('Codex fast mode is visible to the left of the Plan control when enabled', () => {
  assert.match(composerSessionControlsSource, /CODEX_FAST_SERVICE_TIER/);
  assert.match(composerSessionControlsSource, /session\.serviceTier === CODEX_FAST_SERVICE_TIER/);
  assert.match(composerSessionControlsSource, /data-testid="fast-mode-indicator"/);
  assert.match(composerSessionControlsSource, /<ComposerFastModeIndicator compact=\{isInline\} \/>/);
  assert.ok(
    composerSessionControlsSource.indexOf('<ComposerFastModeIndicator compact={isInline} />') <
      composerSessionControlsSource.indexOf('testId="plan-mode-toggle"'),
  );
});

test('service tier updates have websocket and process-manager control paths', () => {
  assert.match(wsMessageTypesSource, /type: 'set_service_tier'/);
  assert.match(wsClientSource, /setServiceTier\(sessionId: string, serviceTier: string \| null\)/);
  assert.match(wsClientSource, /this\.sendRequest\('set_service_tier', \{ sessionId, serviceTier \}\)/);
  assert.match(wsHookSource, /setServiceTier/);
  assert.match(routingSource, /case 'set_service_tier':/);
  assert.match(routingSource, /processManager\.sendSetServiceTier\(sessionId, message\.serviceTier\)/);
  assert.match(processManagerSource, /sendSetServiceTier\(sessionId: string, serviceTier: string \| null\): boolean/);
  assert.match(processManagerSource, /this\.tryUpdateProviderSessionConfig\(\s*sessionId, \{ serviceTier \}/);
});

test('Codex app-server requests carry serviceTier on handshakes and turns', () => {
  assert.match(codexAdapterSource, /serviceTier\?: string \| null/);
  assert.match(codexAdapterSource, /serviceTier: options\.serviceTier/);
  assert.match(codexAdapterSource, /runtimeConfig\?\.serviceTier !== undefined/);
  assert.match(codexAdapterSource, /request\.params = \{ \.\.\.request\.params, serviceTier: runtimeConfig\.serviceTier \}/);
  assert.match(codexAdapterSource, /threadParams\.serviceTier = runtimeConfig\.serviceTier/);
  assert.match(codexAdapterSource, /patch\.serviceTier !== undefined/);
});

test('session runtime state and Codex model metadata preserve service tiers', () => {
  assert.match(sessionStoreSource, /serviceTier: 'serviceTier' in s \? s\.serviceTier : undefined/);
  assert.match(sessionStoreSource, /serviceTier: runtimeConfig\.serviceTier/);
  assert.match(providerOptionsSource, /buildCodexServiceTiers\(model\.serviceTiers\)/);
  assert.match(providerOptionsSource, /value = String\(tier\.id \?\? ''\)\.trim\(\)/);
});
