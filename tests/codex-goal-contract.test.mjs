import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const codexAdapterSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/codex/adapter.ts', import.meta.url),
  'utf8',
);
const codexParserSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/codex/protocol-parser.ts', import.meta.url),
  'utf8',
);
const providerContractSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/provider-contract.ts', import.meta.url),
  'utf8',
);
const processManagerSource = fs.readFileSync(
  new URL('../src/lib/cli/process-manager.ts', import.meta.url),
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
const wsRoutingSource = fs.readFileSync(
  new URL('../src/lib/ws/server-message-routing.ts', import.meta.url),
  'utf8',
);
const wsActionsSource = fs.readFileSync(
  new URL('../src/lib/ws/server-session-actions.ts', import.meta.url),
  'utf8',
);
const wsClientHandlersSource = fs.readFileSync(
  new URL('../src/lib/ws/client-message-handlers.ts', import.meta.url),
  'utf8',
);
const sessionStoreSource = fs.readFileSync(
  new URL('../src/stores/session-store.ts', import.meta.url),
  'utf8',
);
const dbSessionsSource = fs.readFileSync(
  new URL('../src/lib/db/sessions.ts', import.meta.url),
  'utf8',
);
const messageInputSource = fs.readFileSync(
  new URL('../src/components/chat/message-input.tsx', import.meta.url),
  'utf8',
);
const headerSource = fs.readFileSync(
  new URL('../src/components/chat/header.tsx', import.meta.url),
  'utf8',
);
const goalControlSource = fs.readFileSync(
  new URL('../src/components/chat/session-goal-control.tsx', import.meta.url),
  'utf8',
);
const skillPickerSource = fs.readFileSync(
  new URL('../src/hooks/use-skill-picker.ts', import.meta.url),
  'utf8',
);
const goalCommandSource = fs.readFileSync(
  new URL('../src/lib/chat/codex-goal-command.ts', import.meta.url),
  'utf8',
);
const goalCommandEventSource = fs.readFileSync(
  new URL('../src/lib/chat/session-goal-command-event.ts', import.meta.url),
  'utf8',
);
const contextStatusBarSource = fs.readFileSync(
  new URL('../src/components/chat/context-status-bar.tsx', import.meta.url),
  'utf8',
);

test('Codex app-server starts with goals enabled and exposes goal RPCs', () => {
  assert.match(codexAdapterSource, /return \['app-server', '--enable', 'goals'\]/);
  assert.match(codexAdapterSource, /method: 'turn\/steer'/);
  assert.match(codexAdapterSource, /expectedTurnId: activeTurnId/);
  assert.match(codexAdapterSource, /threadParams\.effort = runtimeConfig\.reasoningEffort/);
  assert.match(codexAdapterSource, /method: 'thread\/goal\/set'/);
  assert.match(codexAdapterSource, /method: 'thread\/goal\/get'/);
  assert.match(codexAdapterSource, /method: 'thread\/goal\/clear'/);
  assert.match(codexAdapterSource, /on_session_ready_goal_get/);
  assert.match(providerContractSource, /setGoal\?/);
  assert.match(providerContractSource, /getGoal\?/);
  assert.match(providerContractSource, /clearGoal\?/);
  assert.match(processManagerSource, /setSessionGoal\(sessionId: string, update: SessionGoalUpdate\)/);
  assert.match(processManagerSource, /refreshSessionGoal\(sessionId: string\)/);
  assert.match(processManagerSource, /clearSessionGoal\(sessionId: string\)/);
});

test('Codex parser persists and broadcasts goal updates and clears', () => {
  assert.match(codexParserSource, /case 'thread\/goal\/updated':/);
  assert.match(codexParserSource, /case 'thread\/goal\/cleared':/);
  assert.match(codexParserSource, /buildGoalUpdatedMessages/);
  assert.match(codexParserSource, /type: 'session_goal_updated'/);
  assert.match(codexParserSource, /providerState: \{ goal \}/);
  assert.match(codexParserSource, /type: 'session_goal_cleared'/);
  assert.match(codexParserSource, /providerState: \{ goal: null \}/);
  assert.match(dbSessionsSource, /extractSessionGoal\(row\.provider_state\)/);
  assert.match(sessionStoreSource, /updateSessionGoal/);
});

test('goal controls are routed through websocket client and server actions', () => {
  assert.match(wsMessageTypesSource, /type: 'set_session_goal'/);
  assert.match(wsMessageTypesSource, /spawnConfig\?: SessionSpawnConfig/);
  assert.match(wsMessageTypesSource, /type: 'refresh_session_goal'/);
  assert.match(wsMessageTypesSource, /type: 'clear_session_goal'/);
  assert.match(wsMessageTypesSource, /type: 'session_goal_updated'/);
  assert.match(wsMessageTypesSource, /type: 'session_goal_cleared'/);
  assert.match(wsClientSource, /setSessionGoal\(sessionId: string, update: SessionGoalUpdate, spawnConfig\?: SessionSpawnConfig\)/);
  assert.match(wsHookSource, /setSessionGoal/);
  assert.match(wsRoutingSource, /case 'set_session_goal':/);
  assert.match(wsRoutingSource, /spawnConfig: message\.spawnConfig/);
  assert.match(wsRoutingSource, /case 'refresh_session_goal':/);
  assert.match(wsRoutingSource, /case 'clear_session_goal':/);
  assert.match(wsActionsSource, /processManager\.getProcess\(sessionId\)\?\.status === 'running'/);
  assert.match(wsActionsSource, /ensureSessionProcess\(\{ sessionId, userId, sendToUser, spawnConfig \}\)/);
  assert.match(wsActionsSource, /processManager\.setSessionGoal\(sessionId, update \?\? \{\}\)/);
});

test('/goal is intercepted by the composer and exposed in UI affordances', () => {
  assert.match(goalCommandSource, /CODEX_GOAL_COMMAND = `\/\$\{CODEX_GOAL_COMMAND_NAME\}`/);
  assert.match(goalCommandSource, /parseCodexGoalCommand/);
  assert.match(goalCommandSource, /kind: 'inspect'/);
  assert.match(goalCommandSource, /normalized === 'clear'/);
  assert.match(goalCommandSource, /normalized === 'pause'/);
  assert.match(goalCommandSource, /normalized === 'resume'/);
  assert.doesNotMatch(goalCommandSource, /normalized === 'complete'/);
  assert.match(messageInputSource, /parseCodexGoalCommand\(trimmed\)/);
  assert.match(messageInputSource, /insertGoalCommand/);
  assert.match(messageInputSource, /formatGoalStatusMessage\(session\?\.goal\)/);
  assert.doesNotMatch(messageInputSource, /const \[isGoalMode, setIsGoalMode\]/);
  assert.doesNotMatch(messageInputSource, /const \[goalDraft, setGoalDraft\]/);
  assert.doesNotMatch(messageInputSource, /submitGoalMode/);
  assert.match(messageInputSource, /value=\{inputValue\}/);
  assert.match(messageInputSource, /setSessionGoal\(sessionId, command\.update, buildSpawnConfigForCurrentSession\(\)\)/);
  assert.match(messageInputSource, /<SessionGoalControl[\s\S]*variant="composer"/);
  assert.match(headerSource, /<SessionGoalControl sessionId=\{sessionId\} variant="header" \/>/);
  assert.match(goalCommandEventSource, /SESSION_GOAL_COMMAND_INSERT_EVENT/);
  assert.match(goalControlSource, /emitSessionGoalCommandInsert\(sessionId\)/);
  assert.match(goalControlSource, /'session-goal-header-trigger'/);
  assert.match(goalControlSource, /'session-goal-composer-trigger'/);
  assert.match(goalControlSource, /data-testid="session-goal-popover"/);
  assert.match(goalControlSource, /setSessionGoal\(sessionId, \{ status: 'paused' \}, buildSpawnConfig\(\)\)/);
  assert.match(goalControlSource, /clearSessionGoal\(sessionId, buildSpawnConfig\(\)\)/);
  assert.doesNotMatch(goalControlSource, /data-testid="session-goal-composer-bar"/);
  assert.match(messageInputSource, /data-testid="composer-goal-status"/);
  assert.match(messageInputSource, /data-testid="send-during-generation-btn"/);
  assert.match(contextStatusBarSource, /Pursuing goal/);
  assert.match(contextStatusBarSource, /Goal paused \(\/goal resume\)/);
});

test('goal auto turns use the normal running composer lifecycle', () => {
  assert.match(wsClientHandlersSource, /containsTurnStartProgress/);
  assert.match(wsClientHandlersSource, /startTurnInFlight\(msg\.sessionId\)/);
  assert.match(wsClientHandlersSource, /event\.progressType === 'waiting_for_task'/);
  assert.match(messageInputSource, /const isGoalRunning = Boolean/);
  assert.match(messageInputSource, /t\('goal\.steerPlaceholder'\)/);
});

test('Codex /goal appears in the slash command palette', () => {
  assert.match(skillPickerSource, /CODEX_GOAL_COMMAND_NAME/);
  assert.match(skillPickerSource, /CODEX_GOAL_BUILTIN_COMMAND/);
  assert.match(messageInputSource, /isCodexGoalCommandSkill\(confirmedSkill\)/);
  assert.match(messageInputSource, /insertGoalCommand\(\)/);
});
