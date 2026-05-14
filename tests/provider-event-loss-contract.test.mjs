import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const claudeParserSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/claude-code/protocol-parser.ts', import.meta.url),
  'utf8',
);
const openCodeParserSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/opencode/protocol-parser.ts', import.meta.url),
  'utf8',
);

test('Claude Code parser records unmatched and malformed tool events', () => {
  assert.match(claudeParserSource, /buildUnmatchedClaudeToolResultMessage/);
  assert.match(claudeParserSource, /claude_tool_result_missing_id/);
  assert.match(claudeParserSource, /claude_malformed_tool_use/);
  assert.match(claudeParserSource, /ClaudeToolResult/);
  assert.match(claudeParserSource, /sideEffect: \{ type: 'remove_pending_tool_call', toolUseId \}/);
});

test('Claude Code stream tool_use blocks are converted before assistant snapshots', () => {
  assert.match(claudeParserSource, /block\.type === 'tool_use'/);
  assert.match(claudeParserSource, /delta\.type === 'input_json_delta'/);
  assert.match(claudeParserSource, /buildStreamToolUseBlock\(state\.activeToolUseBlock\)/);
  assert.match(claudeParserSource, /state\.processedToolUseIds\.add\(toolUse\.id\)/);
  assert.match(claudeParserSource, /\.\.\.this\.parseToolUse\(sessionId, toolUse\)/);
  assert.match(claudeParserSource, /\.\.\.this\.handleInteractivePrompt\(sessionId, toolUse\)/);
});

test('OpenCode parser records unknown notifications and unsupported tool-like updates', () => {
  assert.match(openCodeParserSource, /opencode_unknown_stdout/);
  assert.match(openCodeParserSource, /opencode_unknown_server_request/);
  assert.match(openCodeParserSource, /opencode_unknown_notification/);
  assert.match(openCodeParserSource, /opencode_malformed_session_update/);
  assert.match(openCodeParserSource, /handleUnsupportedSessionUpdate/);
  assert.match(openCodeParserSource, /looksLikeOpenCodeToolUpdate/);
  assert.match(openCodeParserSource, /buildGenericOpenCodeToolCall/);
});
