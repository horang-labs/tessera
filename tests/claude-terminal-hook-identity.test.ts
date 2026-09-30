import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';

process.env.TESSERA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tessera-claude-hook-identity-'));
process.env.NODE_ENV = 'test';

let getDb: typeof import('@/lib/db/database').getDb;
let dbSessions: typeof import('@/lib/db/sessions');
let getTerminalProviderSession: typeof import('@/lib/db/terminal-provider-sessions').getTerminalProviderSession;
let handleHookRequest: typeof import('@/lib/cli/hook-receiver').handleHookRequest;
let mintPaneToken: typeof import('@/lib/terminal/pane-token-registry').mintPaneToken;
let revokePaneToken: typeof import('@/lib/terminal/pane-token-registry').revokePaneToken;
let terminalManager: typeof import('@/lib/terminal/shared-terminal-manager').terminalManager;
let cliProviderRegistry: typeof import('@/lib/cli/providers/registry').cliProviderRegistry;
let shouldIgnoreForeignClaudeHookIdentity: typeof import(
  '@/lib/cli/providers/claude-code/terminal-hook-identity'
).shouldIgnoreForeignClaudeHookIdentity;

before(async () => {
  await import('@/lib/cli/providers/bootstrap');
  const [database, projects, sessions, providerSessions, hookReceiver, paneTokens, sharedManager, hookIdentity, registry] =
    await Promise.all([
      import('@/lib/db/database'),
      import('@/lib/db/projects'),
      import('@/lib/db/sessions'),
      import('@/lib/db/terminal-provider-sessions'),
      import('@/lib/cli/hook-receiver'),
      import('@/lib/terminal/pane-token-registry'),
      import('@/lib/terminal/shared-terminal-manager'),
      import('@/lib/cli/providers/claude-code/terminal-hook-identity'),
      import('@/lib/cli/providers/registry'),
    ]);
  cliProviderRegistry = registry.cliProviderRegistry;
  await database.initDatabase();
  projects.registerProject('project-1', '/tmp/project-1', 'Project 1');
  getDb = database.getDb;
  dbSessions = sessions;
  getTerminalProviderSession = providerSessions.getTerminalProviderSession;
  handleHookRequest = hookReceiver.handleHookRequest;
  mintPaneToken = paneTokens.mintPaneToken;
  revokePaneToken = paneTokens.revokePaneToken;
  terminalManager = sharedManager.terminalManager;
  shouldIgnoreForeignClaudeHookIdentity = hookIdentity.shouldIgnoreForeignClaudeHookIdentity;
});

async function postHook(token: string, payload: Record<string, unknown>): Promise<number> {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage;
  Object.defineProperty(req, 'headers', { configurable: true, value: { 'x-tessera-pane-token': token } });
  const res = { statusCode: 0, end: () => {} } as unknown as ServerResponse;
  await handleHookRequest(req, res);
  return res.statusCode;
}

function sessionCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
}

/** A Claude PTY whose conversation is the Tessera session id, as Tessera launches it. */
function claudePane(t: test.TestContext, name: string) {
  const sessionId = `claude-pane-${name}`;
  dbSessions.createSession(sessionId, 'project-1', `Conversation ${name}`, 'claude-code', {
    providerState: JSON.stringify({ kind: 'terminal' }),
  });
  const token = mintPaneToken({
    terminalId: `session-${sessionId}`,
    userId: `user-${name}`,
    sessionId,
    providerId: 'claude-code',
  });
  t.after(() => revokePaneToken(token));
  // Hermetic: never read the real jobs directory of the machine running the tests.
  t.mock.method(cliProviderRegistry.getProvider('claude-code'), 'isTerminalConversationHeldInBackground', async () => false);
  t.mock.method(terminalManager, 'getSessionIdForTerminal', () => sessionId);
  const rebind = t.mock.method(terminalManager, 'rebindSession', () => true);
  const recordState = t.mock.method(terminalManager, 'recordSessionState', () => true);
  return { sessionId, token, rebind, recordState };
}

test('a Claude process that is not on the pane cannot create or steer a session', async (t) => {
  const pane = claudePane(t, 'nested');
  const before = sessionCount();
  const foreign = 'aaaaaaaa-1111-4222-8333-444444444444';

  const statuses = [
    await postHook(pane.token, { hook_event_name: 'SessionStart', session_id: foreign, source: 'startup' }),
    await postHook(pane.token, { hook_event_name: 'UserPromptSubmit', session_id: foreign, prompt: 'nested prompt' }),
    await postHook(pane.token, { hook_event_name: 'Stop', session_id: foreign }),
  ];

  assert.deepEqual(statuses, [204, 204, 204]);
  assert.equal(sessionCount(), before, 'no session may be created');
  assert.equal(getTerminalProviderSession('claude-code', foreign), undefined);
  assert.equal(pane.rebind.mock.callCount(), 0);
  assert.equal(pane.recordState.mock.callCount(), 0, 'a foreign Stop must not complete the pane');
  assert.equal(dbSessions.getSession(pane.sessionId)?.title, 'Conversation nested');
});

test('Claude-reported transitions on the pane still create the session they announce', async (t) => {
  for (const source of ['fork', 'resume', 'clear'] as const) {
    const pane = claudePane(t, `own-${source}`);
    const before = sessionCount();
    const next = `${source.padEnd(8, 'x')}-2222-4333-8444-555555555555`;

    await postHook(pane.token, { hook_event_name: 'SessionStart', session_id: next, source });

    assert.equal(sessionCount(), before + 1, `${source} must be honored`);
    assert.equal(pane.rebind.mock.callCount(), 1, `${source} moves the pane`);
    const child = dbSessions.getSession(getTerminalProviderSession('claude-code', next)!.tessera_session_id);
    assert.ok(child);
    if (source === 'clear') assert.doesNotMatch(child.title, /\(Fork\)$/);
  }
});

test('a conversation moved to the background is ignored: no new session, the pane stays put', async (t) => {
  const pane = claudePane(t, 'handoff');
  const moved = 'bbbbbbbb-3333-4444-8555-666666666666';
  // A handoff has no fork link; the CLI only reports it as a background job. Its
  // worker resumes the conversation, so it may report `resume` as well as `startup`.
  t.mock.method(
    cliProviderRegistry.getProvider('claude-code'),
    'isTerminalConversationHeldInBackground',
    async ({ providerSessionId }: { providerSessionId: string }) => providerSessionId === moved,
  );
  const before = sessionCount();

  const statuses = [
    await postHook(pane.token, { hook_event_name: 'SessionStart', session_id: moved, source: 'startup' }),
    await postHook(pane.token, { hook_event_name: 'SessionStart', session_id: moved, source: 'resume' }),
    await postHook(pane.token, { hook_event_name: 'UserPromptSubmit', session_id: moved, prompt: 'worker prompt' }),
  ];

  assert.deepEqual(statuses, [204, 204, 204]);
  assert.equal(sessionCount(), before, 'the moved conversation must not become a new session');
  assert.equal(getTerminalProviderSession('claude-code', moved), undefined);
  assert.equal(pane.rebind.mock.callCount(), 0, 'the pane keeps its own conversation');
  assert.equal(dbSessions.getSession(pane.sessionId)?.title, 'Conversation handoff');
});

test('Claude hook identity classifier keeps legitimate ownership cases', () => {
  const base = { expectedProviderSessionId: 'own', observedProviderSessionId: 'other', handedOffToBackground: false };
  assert.equal(shouldIgnoreForeignClaudeHookIdentity({ ...base, expectedProviderSessionId: undefined, event: 'SessionStart', source: 'startup' }), false);
  assert.equal(shouldIgnoreForeignClaudeHookIdentity({ ...base, observedProviderSessionId: 'own', event: 'PostToolUse' }), false);
  for (const source of ['startup', 'resume', 'clear', 'fork']) {
    assert.equal(shouldIgnoreForeignClaudeHookIdentity({ ...base, event: 'SessionStart', source, handedOffToBackground: true }), true, `handoff ${source}`);
  }
  assert.equal(shouldIgnoreForeignClaudeHookIdentity({ ...base, observedProviderSessionId: 'own', event: 'PostToolUse', handedOffToBackground: true }), false, 'the pane\'s own id is never a handoff');
  for (const source of ['resume', 'clear', 'fork']) {
    assert.equal(shouldIgnoreForeignClaudeHookIdentity({ ...base, event: 'SessionStart', source }), false, source);
    assert.equal(shouldIgnoreForeignClaudeHookIdentity({ ...base, event: 'UserPromptSubmit', source }), true, `${source} is only trusted on SessionStart`);
  }
  for (const source of ['startup', 'compact', undefined]) {
    assert.equal(shouldIgnoreForeignClaudeHookIdentity({ ...base, event: 'SessionStart', source }), true, String(source));
  }
});
