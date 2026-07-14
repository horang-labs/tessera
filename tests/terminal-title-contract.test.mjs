import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const claudeAdapterSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/claude-code/adapter.ts', import.meta.url),
  'utf8',
);
const titleGeneratorSource = fs.readFileSync(
  new URL('../src/lib/session/ai-title-generator.ts', import.meta.url),
  'utf8',
);
const autoTitleSource = fs.readFileSync(
  new URL('../src/lib/cli/protocol-adapter-auto-title.ts', import.meta.url),
  'utf8',
);
const clientMessageHandlersSource = fs.readFileSync(
  new URL('../src/lib/ws/client-message-handlers.ts', import.meta.url),
  'utf8',
);
const generateTitleRouteSource = fs.readFileSync(
  new URL('../src/app/api/sessions/[id]/generate-title/route.ts', import.meta.url),
  'utf8',
);
const hookReceiverSource = fs.readFileSync(
  new URL('../src/lib/cli/hook-receiver.ts', import.meta.url),
  'utf8',
);

test('Claude title generation uses a title-only system prompt', () => {
  assert.match(claudeAdapterSource, /const TITLE_SYSTEM_PROMPT/);
  assert.match(claudeAdapterSource, /'--system-prompt',\s*TITLE_SYSTEM_PROMPT/);
  assert.match(claudeAdapterSource, /Return only one valid JSON object/);
});

test('automatic title fallback remains eligible for a later Stop retry', () => {
  assert.match(titleGeneratorSource, /firstUserMessage \?\?= text/);
  assert.match(titleGeneratorSource, /return \{ title: fallbackTitle, fallback: true \}/);
  assert.match(autoTitleSource, /fallbackToFirstUserMessage: true/);
  assert.match(autoTitleSource, /const latestSession = dbSessions\.getSession\(sessionId\)/);
  assert.match(autoTitleSource, /!latestSession \|\| latestSession\.has_custom_title/);
  assert.match(autoTitleSource, /has_custom_title: result\.fallback \? 0 : 1/);
  assert.match(autoTitleSource, /hasCustomTitle: result\.fallback !== true/);
  assert.match(autoTitleSource, /if \(result\.fallback\) \{\s*autoTitleTriggered\.delete\(sessionId\)/);
  assert.match(autoTitleSource, /catch \(error: any\) \{\s*autoTitleTriggered\.delete\(sessionId\)/);
  assert.match(clientMessageHandlersSource, /msg\.hasCustomTitle \?\? true/);
  assert.doesNotMatch(generateTitleRouteSource, /fallbackToFirstUserMessage/);
});

test('terminal prompts apply the immediate local title before the Stop event', () => {
  assert.match(
    hookReceiverSource,
    /event === 'UserPromptSubmit'[\s\S]*applyImmediateSessionTitle\(entry\.sessionId, prompt\)/,
  );
  assert.match(hookReceiverSource, /type: 'session_title_updated'[\s\S]*silent: true/);
});
