import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const codexProtocolParserSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/codex/protocol-parser.ts', import.meta.url),
  'utf8',
);
const agentContextSummarySource = fs.readFileSync(
  new URL('../src/lib/agent-context-summary.ts', import.meta.url),
  'utf8',
);

test('Codex webSearch ThreadItems are emitted as web tool calls', () => {
  assert.match(codexProtocolParserSource, /itemType === 'webSearch'/);
  assert.match(codexProtocolParserSource, /buildWebSearchToolMetadata/);
  assert.match(codexProtocolParserSource, /toolName = toolKind === 'web_fetch' \? 'WebFetch' : 'WebSearch'/);
  assert.match(codexProtocolParserSource, /toolKind: ToolCallKind/);
  assert.match(codexProtocolParserSource, /'web_search'/);
  assert.match(codexProtocolParserSource, /'web_fetch'/);
  assert.match(codexProtocolParserSource, /type: 'add_pending_tool_call'[\s\S]*toolKind[\s\S]*toolParams/);
  assert.match(codexProtocolParserSource, /type: 'remove_pending_tool_call', toolUseId: itemId/);
});

test('Codex web.run dynamicToolCall items preserve web context metadata', () => {
  assert.match(codexProtocolParserSource, /itemType === 'dynamicToolCall'/);
  assert.match(codexProtocolParserSource, /buildDynamicToolMetadata/);
  assert.match(codexProtocolParserSource, /const toolName = namespace \? `\$\{namespace\}\.\$\{tool\}` : tool/);
  assert.match(codexProtocolParserSource, /isWebRunDynamicTool/);
  assert.match(codexProtocolParserSource, /normalizedNamespace === 'web' && normalizedTool === 'run'/);
  assert.match(codexProtocolParserSource, /Array\.isArray\(args\.open\)/);
  assert.match(codexProtocolParserSource, /args\.search_query/);
  assert.match(codexProtocolParserSource, /extractWebRunSummary/);
  assert.match(codexProtocolParserSource, /\.\.\.\(query \? \{ query \} : \{\}\)/);
});

test('Agent context summary renders web tool kinds in the timeline', () => {
  assert.match(agentContextSummarySource, /case 'web_search':\s*case 'web_fetch':\s*return \{ item: buildWebTimelineItem\(message\) \};/);
});

test('Unhandled Codex action items are not silently suppressed', () => {
  assert.match(codexProtocolParserSource, /DISPLAY_ONLY_CODEX_ITEM_TYPES/);
  assert.match(codexProtocolParserSource, /buildGenericCodexItemToolCallMessage/);
  assert.match(codexProtocolParserSource, /!this\.isDisplayOnlyCodexItem\(itemType\)/);
  assert.match(codexProtocolParserSource, /generic item mapped to tool_call/);
  assert.match(codexProtocolParserSource, /case 'mcpToolCall'/);
  assert.match(codexProtocolParserSource, /case 'collabAgentToolCall'/);
  assert.match(codexProtocolParserSource, /case 'imageGeneration'/);
  assert.match(codexProtocolParserSource, /case 'imageView'/);
});

test('Raw response tool items are converted instead of falling through unknown notification handling', () => {
  assert.match(codexProtocolParserSource, /case 'rawResponseItem\/completed':\s*return this\.handleRawResponseItemCompleted\(sessionId, params\);/);
  assert.match(codexProtocolParserSource, /DISPLAY_ONLY_RAW_RESPONSE_ITEM_TYPES/);
  assert.match(codexProtocolParserSource, /buildRawWebSearchToolCallMessage/);
  assert.match(codexProtocolParserSource, /buildRawGenericToolCallMessage/);
  assert.match(codexProtocolParserSource, /raw response item mapped to tool_call/);
  assert.match(codexProtocolParserSource, /responseItemType: 'web_search_call'/);
});
