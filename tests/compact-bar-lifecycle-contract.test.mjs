import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The compacting bar is opened optimistically for providers that only report a
// finished compaction (Codex sends `thread/compacted` and nothing before it).
// Every way that optimistic open can fail to be followed by a completion event
// therefore needs an explicit close, or the bar hangs until the staleness
// cutoff. These are source-level contracts because the paths span the server
// action, the client message handlers and the store.

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const serverActionsSource = read('../src/lib/ws/server-session-actions.ts');
const clientHandlersSource = read('../src/lib/ws/client-message-handlers.ts');
const wsHookSource = read('../src/hooks/use-websocket.ts');
const chatStoreSource = read('../src/stores/chat-store.ts');

test('every compact rejection code the server can send is closed by the client', () => {
  const compactAction = serverActionsSource.slice(
    serverActionsSource.indexOf('export async function compactSessionFromWebSocket'),
  );
  const serverCodes = [...compactAction.matchAll(/code: '(session_compact_[a-z_]+)'/g)]
    .map((m) => m[1]);

  assert.ok(serverCodes.length >= 3, `expected the rejection codes, saw ${serverCodes}`);

  const clientSet = clientHandlersSource.slice(
    clientHandlersSource.indexOf('COMPACT_REQUEST_ERROR_CODES = new Set(['),
  );
  const clientCodes = [...clientSet.slice(0, clientSet.indexOf(']')).matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1]);

  for (const code of serverCodes) {
    assert.ok(
      clientCodes.includes(code),
      `${code} is sent by the server but would leave the compacting bar open`,
    );
  }
});

test('the optimistic open lives on the /compact path, not on plain sends', () => {
  const compactFn = wsHookSource.slice(
    wsHookSource.indexOf('const compactSession'),
    wsHookSource.indexOf('const stopSession'),
  );
  assert.match(compactFn, /setCompacting\(sessionId, Date\.now\(\)\)/);

  const sendFn = wsHookSource.slice(
    wsHookSource.indexOf('const sendMessage'),
    wsHookSource.indexOf('const createSession'),
  );
  assert.doesNotMatch(sendFn, /setCompacting/);
});

test('a stopped or dead CLI closes the bar', () => {
  const stopped = clientHandlersSource.slice(
    clientHandlersSource.indexOf("case 'session_stopped'"),
  );
  assert.match(
    stopped.slice(0, 1200),
    /setCompacting\(msg\.sessionId, null\)/,
    'session_stopped must close the compacting bar',
  );

  const cliDown = clientHandlersSource.slice(clientHandlersSource.indexOf("case 'cli_down'"));
  assert.match(
    cliDown.slice(0, 1600),
    /setCompacting\(msg\.sessionId, null\)/,
    'cli_down must close the compacting bar',
  );
});

test('the store keeps the earliest start so the CLI frame cannot restart the bar', () => {
  const setter = chatStoreSource.slice(
    chatStoreSource.indexOf('setCompacting: (sessionId, startedAt)'),
  );
  const body = setter.slice(0, setter.indexOf('}),'));
  assert.match(body, /if \(current !== undefined\) return \{\};/);
});
