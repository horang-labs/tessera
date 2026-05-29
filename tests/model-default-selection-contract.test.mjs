import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const chatTypesSource = fs.readFileSync(
  new URL('../src/types/chat.ts', import.meta.url),
  'utf8',
);
const dbSessionsSource = fs.readFileSync(
  new URL('../src/lib/db/sessions.ts', import.meta.url),
  'utf8',
);
const sessionStoreSource = fs.readFileSync(
  new URL('../src/stores/session-store.ts', import.meta.url),
  'utf8',
);
const composerSessionControlsSource = fs.readFileSync(
  new URL('../src/components/chat/composer-session-controls.tsx', import.meta.url),
  'utf8',
);
const providerDefaultsSource = fs.readFileSync(
  new URL('../src/lib/settings/provider-defaults.ts', import.meta.url),
  'utf8',
);
const sessionLifecycleSource = fs.readFileSync(
  new URL('../src/lib/session/session-orchestrator-lifecycle.ts', import.meta.url),
  'utf8',
);
const collectionGroupSource = fs.readFileSync(
  new URL('../src/components/chat/collection-group.tsx', import.meta.url),
  'utf8',
);
const kanbanBoardSource = fs.readFileSync(
  new URL('../src/components/board/kanban-board.tsx', import.meta.url),
  'utf8',
);

test('sessions expose whether provider conversation state has started', () => {
  assert.match(chatTypesSource, /hasStarted\?: boolean/);
  assert.match(dbSessionsSource, /const hasStarted = isRunning \|\| hasProviderConversationState\(row\.provider_state\) \|\| hasSessionHistoryFile\(row\.id\)/);
  assert.match(dbSessionsSource, /hasStarted,/);
  assert.match(sessionStoreSource, /hasStarted: s\.hasStarted \?\? s\.isRunning \?\? false/);
  assert.match(sessionStoreSource, /status === 'running' && \{ hasStarted: true \}/);
  assert.match(sessionStoreSource, /hasStarted: true/);
});

test('non-running model changes persist defaults and update the selected session', () => {
  assert.match(composerSessionControlsSource, /function shouldPersistDefaultsForSession/);
  assert.match(composerSessionControlsSource, /return !session\.isRunning/);
  assert.match(composerSessionControlsSource, /buildProviderSessionDefaultsUpdate\([\s\S]*\{ model: nextModel, reasoningEffort: nextReasoningEffort \}[\s\S]*updateSessionRuntimeConfig\(sessionId, \{\s*model: nextModel,\s*reasoningEffort: nextReasoningEffort,/);
});

test('provider option loading does not auto-save model defaults', () => {
  assert.doesNotMatch(composerSessionControlsSource, /providerDefaults\.model/);
  assert.doesNotMatch(composerSessionControlsSource, /providerDefaults\.reasoningEffort/);
  assert.doesNotMatch(composerSessionControlsSource, /patch\.model = providerDefaultsWithOptions\.model/);
});

test('Codex model defaults are not special-cased by model id', () => {
  assert.doesNotMatch(providerDefaultsSource, /rawCodexProviderDefaults\.model === 'gpt-5\.4'/);
  assert.doesNotMatch(sessionLifecycleSource, /hasLegacyCodexDefault/);
});

test('deferred session creation stays pre-start until the provider starts', () => {
  assert.match(collectionGroupSource, /isRunning: false,[\s\S]*hasStarted: false,[\s\S]*status: sessionData\.status \|\| 'starting'/);
  assert.match(kanbanBoardSource, /isRunning: false,[\s\S]*hasStarted: false,[\s\S]*status: data\.status \|\| 'starting'/);
});
