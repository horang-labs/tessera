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
  assert.match(messageInputSource, /getCodexFastToggleServiceTier/);
  assert.match(messageInputSource, /dispatchCodexSlashCommand/);
  assert.match(messageInputSource, /sessionProviderId !== 'codex'/);
  assert.match(messageInputSource, /updateSessionRuntimeConfig\(sessionId, \{ serviceTier: nextServiceTier \}\)/);
  assert.match(messageInputSource, /setServiceTier\(sessionId, nextServiceTier\)/);
  assert.ok(
    messageInputSource.indexOf('dispatchCodexSlashCommand(commandInput)') <
      messageInputSource.indexOf('const parsed = skillPicker.parseForSend(trimmed);'),
  );
  assert.doesNotMatch(
    messageInputSource,
    /serviceTier: resolveCodexServiceTierForModel/,
    'spawn config must preserve the preference; lifecycle sanitizes runtime application',
  );
});

test('Codex /fast is exposed through the slash command palette', () => {
  assert.match(skillPickerHookSource, /CODEX_FAST_COMMAND_NAME/);
  assert.match(skillPickerHookSource, /CODEX_FAST_BUILTIN_COMMAND/);
  assert.match(skillPickerHookSource, /providerId === 'codex'/);
  assert.match(skillPickerHookSource, /availableCommands/);
  assert.match(messageInputSource, /isCodexFastCommandSkill\(confirmedSkill\)/);
  assert.match(messageInputSource, /dispatchCodexSlashCommand\(CODEX_FAST_COMMAND, 'picker'\)/);
  assert.match(skillPickerHookSource, /codexFastAvailable/);
});

test('Codex fast mode is visible only when the selected model advertises a Fast tier', () => {
  assert.match(composerSessionControlsSource, /getCodexFastServiceTier\(selectedModelOption\)/);
  assert.match(composerSessionControlsSource, /getCodexFastToggleServiceTier/);
  assert.match(composerSessionControlsSource, /codexFastTier !== null/);
  assert.match(composerSessionControlsSource, /isCodexFastModeEnabled/);
  assert.match(composerSessionControlsSource, /if \(runtimeServiceTier !== undefined\)/);
  assert.doesNotMatch(composerSessionControlsSource, /runtimeServiceTier \?\? null/);
  assert.match(composerSessionControlsSource, /testId="fast-mode-toggle"/);
  assert.match(composerSessionControlsSource, /pressed=\{isFastModeEnabled\}/);
  assert.match(composerSessionControlsSource, /controlId="service-tier"/);
  assert.ok(
    composerSessionControlsSource.indexOf('testId="fast-mode-toggle"') <
      composerSessionControlsSource.indexOf('testId="plan-mode-toggle"'),
  );
});

test('Codex fast mode has a configurable keyboard shortcut', () => {
  const keyboardRegistrySource = fs.readFileSync(
    new URL('../src/lib/keyboard/registry.ts', import.meta.url),
    'utf8',
  );
  const i18nTypesSource = fs.readFileSync(
    new URL('../src/lib/i18n/types.ts', import.meta.url),
    'utf8',
  );

  assert.match(keyboardRegistrySource, /'toggle-fast-mode':\s*\{ default: '\$mod\+Alt\+f'/);
  assert.match(keyboardRegistrySource, /descKey: 'shortcut\.toggleFastMode'/);
  assert.match(i18nTypesSource, /toggleFastMode: string;/);
  assert.match(composerSessionControlsSource, /const fastModeShortcut = useEffectiveShortcut\('toggle-fast-mode'\);/);
  assert.match(composerSessionControlsSource, /bindings\[fastModeShortcut\]/);
  assert.match(composerSessionControlsSource, /handleFastModeToggle\(\);/);
  assert.match(composerSessionControlsSource, /shortcutId="toggle-fast-mode"/);
});

test('composer running state omits the Running text label', () => {
  const runStateSource = fs.readFileSync(
    new URL('../src/components/chat/composer-session-control-sections.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(runStateSource, /runningLabel/);
  assert.match(runStateSource, /data-testid="composer-stop-session"/);
});

test('service tier updates have websocket and process-manager control paths', () => {
  assert.match(wsMessageTypesSource, /type: 'set_service_tier'/);
  assert.match(wsClientSource, /setServiceTier\(sessionId: string, serviceTier: string \| null, persist = true\)/);
  assert.match(wsClientSource, /this\.sendRequest\('set_service_tier', \{ sessionId, serviceTier, persist \}\)/);
  assert.match(wsHookSource, /setServiceTier/);
  assert.match(routingSource, /case 'set_service_tier':/);
  assert.match(routingSource, /processManager\.sendSetServiceTier\(message\.sessionId, message\.serviceTier\)/);
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
  assert.match(providerOptionsSource, /defaultServiceTier: model\.defaultServiceTier/);
  assert.match(providerOptionsSource, /value = String\(tier\.id \?\? ''\)\.trim\(\)/);
});
