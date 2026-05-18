import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const messagesRouteSource = fs.readFileSync(
  new URL('../src/app/api/sessions/[id]/messages/route.ts', import.meta.url),
  'utf8',
);
const sessionHistorySource = fs.readFileSync(
  new URL('../src/lib/session-history.ts', import.meta.url),
  'utf8',
);

test('session messages API returns empty history for sessions without Tessera JSONL', () => {
  assert.match(messagesRouteSource, /function buildEmptyHistoryResponse\(sessionId: string\): NextResponse/);
  assert.match(messagesRouteSource, /messages:\s*\[\]/);
  assert.match(messagesRouteSource, /pagination:\s*\{\s*hasMore:\s*false,\s*nextBeforeBytes:\s*0\s*\}/);
  assert.match(messagesRouteSource, /const hasHistory = await sessionHistory\.historyExists\(id\);/);
  assert.match(messagesRouteSource, /if \(!hasHistory\) \{[\s\S]*return buildEmptyHistoryResponse\(id\);[\s\S]*\}/);
});

test('session history preserves progress records without unbounded output snapshots', () => {
  assert.doesNotMatch(sessionHistorySource, /isRenderableProgressType/);
  assert.doesNotMatch(sessionHistorySource, /MAX_HISTORY_EVENT_LINE_CHARS/);
  assert.doesNotMatch(sessionHistorySource, /MAX_PROGRESS_STRING_CHARS/);
  assert.match(sessionHistorySource, /function normalizeHistoryEvent\(event: SessionHistoryEvent\): SessionHistoryEvent \| null/);
  assert.doesNotMatch(sessionHistorySource, /if \(!isRenderableProgressType\(event\.progressType\)\)/);
  assert.match(sessionHistorySource, /normalizedData\.type === 'bash_progress'/);
  assert.match(sessionHistorySource, /delete normalizedData\.fullOutput;/);
  assert.match(sessionHistorySource, /const normalizedEvent = normalizeHistoryEvent\(event\);/);
  assert.match(sessionHistorySource, /fs\.createReadStream\(filePath, \{ encoding: 'utf-8' \}\)/);
  assert.doesNotMatch(sessionHistorySource, /fsp\.readFile\(filePath, 'utf-8'\)/);
  assert.doesNotMatch(sessionHistorySource, /Skipping oversized session history event/);
  assert.doesNotMatch(sessionHistorySource, /Skipped oversized session history lines/);
});
