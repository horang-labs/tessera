import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const compactCommandSource = fs.readFileSync(
  new URL('../src/lib/chat/codex-compact-command.ts', import.meta.url),
  'utf8',
);
const messageInputSource = fs.readFileSync(
  new URL('../src/components/chat/message-input.tsx', import.meta.url),
  'utf8',
);
const skillPickerSource = fs.readFileSync(
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
const wsRoutingSource = fs.readFileSync(
  new URL('../src/lib/ws/server-message-routing.ts', import.meta.url),
  'utf8',
);
const wsActionsSource = fs.readFileSync(
  new URL('../src/lib/ws/server-session-actions.ts', import.meta.url),
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
const codexAdapterSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/codex/adapter.ts', import.meta.url),
  'utf8',
);
const codexParserSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/codex/protocol-parser.ts', import.meta.url),
  'utf8',
);

test('Codex /compact is a built-in composer command, not a Codex skill send', () => {
  assert.match(compactCommandSource, /CODEX_COMPACT_COMMAND_NAME = 'compact'/);
  assert.match(compactCommandSource, /CODEX_COMPACT_COMMAND = `\/\$\{CODEX_COMPACT_COMMAND_NAME\}`/);
  assert.match(compactCommandSource, /CODEX_COMPACT_BUILTIN_COMMAND = 'codex-compact'/);
  assert.match(compactCommandSource, /isCodexCompactCommandSkill/);
  assert.match(skillPickerSource, /CODEX_COMPACT_COMMAND_NAME/);
  assert.match(skillPickerSource, /CODEX_COMPACT_BUILTIN_COMMAND/);
  assert.match(skillPickerSource, /providerId === 'codex'/);
  assert.match(messageInputSource, /isCodexCompactCommandSkill\(skillPicker\.selectedSkill\)/);
  assert.match(messageInputSource, /trimmed === CODEX_COMPACT_COMMAND/);
  assert.match(messageInputSource, /executeCodexCompactCommand\(\)/);
  assert.ok(
    messageInputSource.indexOf('trimmed === CODEX_COMPACT_COMMAND') <
      messageInputSource.indexOf('const parsed = skillPicker.parseForSend(trimmed);'),
  );
});

test('Codex compact control is routed through websocket and process manager', () => {
  assert.match(wsMessageTypesSource, /type: 'compact_session'/);
  assert.match(wsMessageTypesSource, /spawnConfig\?: SessionSpawnConfig/);
  assert.match(wsMessageTypesSource, /displayContent\?: string/);
  assert.match(wsClientSource, /compactSession\(sessionId: string, spawnConfig\?: SessionSpawnConfig, displayContent\?: string\)/);
  assert.match(wsClientSource, /this\.sendRequest\('compact_session'/);
  assert.match(wsHookSource, /compactSession/);
  assert.match(wsRoutingSource, /case 'compact_session':/);
  assert.match(wsRoutingSource, /compactSessionFromWebSocket/);
  assert.match(wsActionsSource, /ensureSessionProcess\(\{ sessionId, userId, sendToUser, spawnConfig \}\)/);
  assert.match(wsActionsSource, /recordCompactCommandDisplayContent\(sessionId, displayContent\)/);
  assert.match(wsActionsSource, /processManager\.compactSession\(sessionId\)/);
  assert.match(providerContractSource, /compactThread\?/);
  assert.match(processManagerSource, /compactSession\(sessionId: string\): Promise<boolean>/);
  assert.match(processManagerSource, /provider\.compactThread/);
});

test('Codex adapter maps compact to the app-server compact RPC', () => {
  assert.match(codexAdapterSource, /method: 'initialized'/);
  assert.match(codexAdapterSource, /_writeStdin\(proc, 'handshake_initialized'/);
  assert.match(codexAdapterSource, /compactThread\(proc: ChildProcess, sessionId: string\): Promise<boolean>/);
  assert.match(codexAdapterSource, /method: 'thread\/compact\/start'/);
  assert.match(codexAdapterSource, /params: \{ threadId \}/);
  assert.match(codexAdapterSource, /trackPendingRequest\(sessionId, requestId, 'thread\/compact\/start'\)/);
  assert.match(codexAdapterSource, /_awaitResponse\(proc, requestId, 'thread\/compact\/start'\)/);
});

test('Codex compact completion is rendered as a compact boundary system message', () => {
  assert.match(codexParserSource, /case 'thread\/compacted':/);
  assert.match(codexParserSource, /handleThreadCompacted/);
  assert.match(codexParserSource, /itemType === 'contextCompaction'/);
  assert.match(codexParserSource, /itemType === 'compaction' \|\| itemType === 'context_compaction'/);
  assert.match(codexParserSource, /buildCompactBoundaryMessages/);
  assert.match(codexParserSource, /subtype: 'compact_boundary'/);
  assert.match(codexParserSource, /compactMetadata/);
  assert.match(codexParserSource, /trigger: 'manual'/);
  assert.match(codexParserSource, /provider: 'codex'/);
  assert.ok(
    codexParserSource.indexOf("message: 'Context compacted'") <
      codexParserSource.indexOf("private handleThreadGoalUpdated"),
  );
  assert.doesNotMatch(
    codexParserSource.slice(
      codexParserSource.indexOf('private buildCompactBoundaryMessages'),
      codexParserSource.indexOf('private handleThreadGoalUpdated'),
    ),
    /set_generating/,
  );
});
