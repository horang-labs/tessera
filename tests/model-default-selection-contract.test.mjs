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

test('sessions expose whether provider conversation state has started', () => {
  assert.match(chatTypesSource, /hasStarted\?: boolean/);
  assert.match(dbSessionsSource, /const hasStarted = isRunning \|\| hasProviderConversationState\(row\.provider_state\) \|\| hasSessionHistoryFile\(row\.id\)/);
  assert.match(dbSessionsSource, /hasStarted,/);
  assert.match(sessionStoreSource, /hasStarted: s\.hasStarted \?\? s\.isRunning \?\? false/);
  assert.match(sessionStoreSource, /status === 'running' && \{ hasStarted: true \}/);
  assert.match(sessionStoreSource, /hasStarted: true/);
});

test('pre-start model changes persist defaults and update the pending session', () => {
  assert.match(composerSessionControlsSource, /return !session\.isRunning && session\.hasStarted !== true/);
  assert.match(composerSessionControlsSource, /buildProviderSessionDefaultsUpdate\([\s\S]*\{ model: nextModel, reasoningEffort: nextReasoningEffort \}[\s\S]*updateSessionRuntimeConfig\(sessionId, \{\s*model: nextModel,\s*reasoningEffort: nextReasoningEffort,/);
});
