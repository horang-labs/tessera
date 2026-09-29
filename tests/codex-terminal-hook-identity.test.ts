import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';

process.env.TESSERA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tessera-codex-hook-identity-'));
process.env.NODE_ENV = 'test';

let getDb: typeof import('@/lib/db/database').getDb;
let dbSessions: typeof import('@/lib/db/sessions');
let bindTerminalProviderSession: typeof import('@/lib/db/terminal-provider-sessions').bindTerminalProviderSession;
let getTerminalProviderSession: typeof import('@/lib/db/terminal-provider-sessions').getTerminalProviderSession;
let handleHookRequest: typeof import('@/lib/cli/hook-receiver').handleHookRequest;
let mintPaneToken: typeof import('@/lib/terminal/pane-token-registry').mintPaneToken;
let revokePaneToken: typeof import('@/lib/terminal/pane-token-registry').revokePaneToken;
let terminalManager: typeof import('@/lib/terminal/shared-terminal-manager').terminalManager;
let sessionHistory: typeof import('@/lib/session-history').sessionHistory;
let shouldIgnoreForeignCodexHookIdentity: typeof import(
  '@/lib/cli/providers/codex/terminal-hook-identity'
).shouldIgnoreForeignCodexHookIdentity;
let isCodexHookPayloadOnForeignPane: typeof import(
  '@/lib/cli/providers/codex/terminal-hook-identity'
).isCodexHookPayloadOnForeignPane;

before(async () => {
  await import('@/lib/cli/providers/bootstrap');
  const [
    database,
    projects,
    sessions,
    providerSessions,
    hookReceiver,
    paneTokens,
    sharedManager,
    hookIdentity,
    history,
  ] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/db/terminal-provider-sessions'),
    import('@/lib/cli/hook-receiver'),
    import('@/lib/terminal/pane-token-registry'),
    import('@/lib/terminal/shared-terminal-manager'),
    import('@/lib/cli/providers/codex/terminal-hook-identity'),
    import('@/lib/session-history'),
  ]);
  await database.initDatabase();
  projects.registerProject('project-1', '/tmp/project-1', 'Project 1');
  getDb = database.getDb;
  dbSessions = sessions;
  bindTerminalProviderSession = providerSessions.bindTerminalProviderSession;
  getTerminalProviderSession = providerSessions.getTerminalProviderSession;
  handleHookRequest = hookReceiver.handleHookRequest;
  mintPaneToken = paneTokens.mintPaneToken;
  revokePaneToken = paneTokens.revokePaneToken;
  terminalManager = sharedManager.terminalManager;
  shouldIgnoreForeignCodexHookIdentity = hookIdentity.shouldIgnoreForeignCodexHookIdentity;
  isCodexHookPayloadOnForeignPane = hookIdentity.isCodexHookPayloadOnForeignPane;
  sessionHistory = history.sessionHistory;
});

async function postHook(token: string, payload: Record<string, unknown>): Promise<number> {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage;
  Object.defineProperty(req, 'headers', {
    configurable: true,
    value: { 'x-tessera-pane-token': token },
  });
  let ended = false;
  const res = {
    statusCode: 0,
    end: () => { ended = true; },
  } as unknown as ServerResponse;

  await handleHookRequest(req, res);
  assert.equal(ended, true);
  return res.statusCode;
}

test('a nested codex exec that inherits the pane token cannot fork or rebind the parent PTY', async (t) => {
  const tesseraSessionId = 'codex-hook-parent';
  const parentProviderSessionId = 'codex-parent-provider';
  const nestedProviderSessionId = 'codex-nested-exec-provider';
  const terminalId = `session-${tesseraSessionId}`;
  const userId = 'codex-hook-user';

  dbSessions.createSession(tesseraSessionId, 'project-1', 'Parent conversation', 'codex', {
    providerState: JSON.stringify({
      kind: 'terminal',
      launched: true,
      codexSessionId: parentProviderSessionId,
    }),
  });
  bindTerminalProviderSession({
    providerId: 'codex',
    providerSessionId: parentProviderSessionId,
    tesseraSessionId,
  });

  const token = mintPaneToken({ terminalId, userId, sessionId: tesseraSessionId, providerId: 'codex' });
  t.after(() => revokePaneToken(token));
  t.mock.method(terminalManager, 'getSessionIdForTerminal', () => tesseraSessionId);
  const rebind = t.mock.method(terminalManager, 'rebindSession', () => true);
  const recordState = t.mock.method(terminalManager, 'recordSessionState', () => true);
  const sessionsBefore = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;

  const status = await postHook(token, {
    hook_event_name: 'SessionStart',
    session_id: nestedProviderSessionId,
    source: 'startup',
  });
  const promptStatus = await postHook(token, {
    hook_event_name: 'UserPromptSubmit',
    session_id: nestedProviderSessionId,
    prompt: 'nested process prompt must not rename the parent',
  });

  const sessionsAfter = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
  assert.equal(status, 204);
  assert.equal(promptStatus, 204);
  assert.equal(sessionsAfter, sessionsBefore, 'foreign hook must not create a Tessera child session');
  assert.equal(getTerminalProviderSession('codex', nestedProviderSessionId), undefined);
  assert.equal(rebind.mock.callCount(), 0, 'foreign hook must not move the parent PTY');
  assert.equal(recordState.mock.callCount(), 0, 'foreign hooks must not update the parent runtime state');
  assert.equal(await sessionHistory.historyExists(tesseraSessionId), false);
  assert.equal(dbSessions.getSession(tesseraSessionId)?.title, 'Parent conversation');
  assert.equal(
    JSON.parse(dbSessions.getSession(tesseraSessionId)?.provider_state ?? '{}').codexSessionId,
    parentProviderSessionId,
  );
});

test('a persisted Codex identity guards cold-resumed panes before the binding table is rebuilt', async (t) => {
  const tesseraSessionId = 'codex-hook-persisted-parent';
  const parentProviderSessionId = 'codex-persisted-parent-provider';
  const nestedProviderSessionId = 'codex-persisted-nested-provider';
  const terminalId = `session-${tesseraSessionId}`;
  const userId = 'codex-hook-persisted-user';

  dbSessions.createSession(tesseraSessionId, 'project-1', 'Cold-resumed conversation', 'codex', {
    providerState: JSON.stringify({
      kind: 'terminal',
      launched: true,
      codexSessionId: parentProviderSessionId,
    }),
  });

  const token = mintPaneToken({ terminalId, userId, sessionId: tesseraSessionId, providerId: 'codex' });
  t.after(() => revokePaneToken(token));
  t.mock.method(terminalManager, 'getSessionIdForTerminal', () => tesseraSessionId);
  const rebind = t.mock.method(terminalManager, 'rebindSession', () => true);
  const sessionsBefore = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;

  const status = await postHook(token, {
    hook_event_name: 'SessionStart',
    session_id: nestedProviderSessionId,
    source: 'startup',
  });

  const sessionsAfter = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
  assert.equal(status, 204);
  assert.equal(sessionsAfter, sessionsBefore);
  assert.equal(getTerminalProviderSession('codex', nestedProviderSessionId), undefined);
  assert.equal(rebind.mock.callCount(), 0);
});

test('Codex /clear remains an allowed hook-driven identity transition', async (t) => {
  const tesseraSessionId = 'codex-hook-clear-parent';
  const parentProviderSessionId = 'codex-clear-parent-provider';
  const clearedProviderSessionId = 'codex-clear-child-provider';
  const terminalId = `session-${tesseraSessionId}`;
  const userId = 'codex-hook-clear-user';

  dbSessions.createSession(tesseraSessionId, 'project-1', 'Conversation to clear', 'codex', {
    providerState: JSON.stringify({
      kind: 'terminal',
      launched: true,
      codexSessionId: parentProviderSessionId,
    }),
  });
  bindTerminalProviderSession({
    providerId: 'codex',
    providerSessionId: parentProviderSessionId,
    tesseraSessionId,
  });

  const token = mintPaneToken({ terminalId, userId, sessionId: tesseraSessionId, providerId: 'codex' });
  t.after(() => revokePaneToken(token));
  t.mock.method(terminalManager, 'getSessionIdForTerminal', () => tesseraSessionId);
  const rebind = t.mock.method(terminalManager, 'rebindSession', () => true);
  const sessionsBefore = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;

  const status = await postHook(token, {
    hook_event_name: 'SessionStart',
    session_id: clearedProviderSessionId,
    source: 'clear',
  });

  const childBinding = getTerminalProviderSession('codex', clearedProviderSessionId);
  const child = childBinding ? dbSessions.getSession(childBinding.tessera_session_id) : undefined;
  const sessionsAfter = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
  assert.equal(status, 204);
  assert.equal(sessionsAfter, sessionsBefore + 1);
  assert.equal(rebind.mock.callCount(), 1);
  assert.ok(child);
  assert.doesNotMatch(child.title, /\(Fork\)$/);
});

test('a codex exec launched from a Claude pane cannot spawn a phantom fork session', async (t) => {
  const tesseraSessionId = 'claude-pane-codex-exec-parent';
  const codexRolloutId = '01a0ecc2-b21f-7793-8d7e-6c4659a8fc1b';
  const terminalId = `session-${tesseraSessionId}`;
  const userId = 'claude-pane-codex-exec-user';

  dbSessions.createSession(tesseraSessionId, 'project-1', 'Claude conversation', 'claude-code', {
    providerState: JSON.stringify({ kind: 'terminal' }),
  });
  const token = mintPaneToken({ terminalId, userId, sessionId: tesseraSessionId, providerId: 'claude-code' });
  t.after(() => revokePaneToken(token));
  t.mock.method(terminalManager, 'getSessionIdForTerminal', () => tesseraSessionId);
  const rebind = t.mock.method(terminalManager, 'rebindSession', () => true);
  const sessionsBefore = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;

  const transcriptPath = `/home/work/.codex/sessions/2026/09/29/rollout-2026-09-29T19-42-57-${codexRolloutId}.jsonl`;
  const statuses = [
    await postHook(token, {
      hook_event_name: 'SessionStart',
      session_id: codexRolloutId,
      transcript_path: transcriptPath,
      source: 'startup',
    }),
    await postHook(token, {
      hook_event_name: 'UserPromptSubmit',
      session_id: codexRolloutId,
      transcript_path: transcriptPath,
      prompt: 'codex exec prompt must not rename the Claude session',
    }),
  ];

  const sessionsAfter = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
  assert.deepEqual(statuses, [204, 204]);
  assert.equal(sessionsAfter, sessionsBefore, 'a Codex hook must not create a session on a Claude pane');
  assert.equal(getTerminalProviderSession('claude-code', codexRolloutId), undefined);
  assert.equal(rebind.mock.callCount(), 0);
  assert.equal(await sessionHistory.historyExists(tesseraSessionId), false);
  assert.equal(dbSessions.getSession(tesseraSessionId)?.title, 'Claude conversation');
});

test('a real Claude fork on a Claude pane still creates a child session', async (t) => {
  const tesseraSessionId = 'claude-pane-real-fork-parent';
  const forkedClaudeSessionId = '3f1c9a52-7d0e-4b8a-9c11-2e5d6f7a8b90';
  const terminalId = `session-${tesseraSessionId}`;
  const userId = 'claude-pane-real-fork-user';

  dbSessions.createSession(tesseraSessionId, 'project-1', 'Claude parent', 'claude-code', {
    providerState: JSON.stringify({ kind: 'terminal' }),
  });
  const token = mintPaneToken({ terminalId, userId, sessionId: tesseraSessionId, providerId: 'claude-code' });
  t.after(() => revokePaneToken(token));
  t.mock.method(terminalManager, 'getSessionIdForTerminal', () => tesseraSessionId);
  t.mock.method(terminalManager, 'rebindSession', () => true);
  const sessionsBefore = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;

  const status = await postHook(token, {
    hook_event_name: 'SessionStart',
    session_id: forkedClaudeSessionId,
    transcript_path: `/home/work/.claude/projects/-tmp-project-1/${forkedClaudeSessionId}.jsonl`,
    source: 'fork',
  });

  const sessionsAfter = (getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
  assert.equal(status, 204);
  assert.equal(sessionsAfter, sessionsBefore + 1, 'Claude /fork discovery must keep working');
  assert.ok(getTerminalProviderSession('claude-code', forkedClaudeSessionId));
});

test('foreign-pane Codex payload detection keys on the rollout file name only', () => {
  const rollout = 'rollout-2026-09-29T19-42-57-01a0ecc2-b21f-7793-8d7e-6c4659a8fc1b.jsonl';
  for (const transcriptPath of [
    `/home/work/.codex/sessions/2026/09/29/${rollout}`,
    `/home/work/.tessera/codex-overlay/session-abc/sessions/2026/09/28/${rollout}`,
    `C:\\Users\\work\\.codex\\sessions\\2026\\09\\29\\${rollout}`,
    `\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\.codex\\sessions\\${rollout}`,
  ]) {
    assert.equal(isCodexHookPayloadOnForeignPane('claude-code', transcriptPath), true, transcriptPath);
    assert.equal(isCodexHookPayloadOnForeignPane('opencode', transcriptPath), true, transcriptPath);
    assert.equal(isCodexHookPayloadOnForeignPane('codex', transcriptPath), false, 'Codex panes keep their own rollouts');
  }
  assert.equal(
    isCodexHookPayloadOnForeignPane('claude-code', '/home/work/.claude/projects/-x/3f1c9a52-7d0e-4b8a-9c11-2e5d6f7a8b90.jsonl'),
    false,
  );
  assert.equal(isCodexHookPayloadOnForeignPane('claude-code', undefined), false);
  assert.equal(isCodexHookPayloadOnForeignPane('claude-code', ''), false);
});

test('Codex hook identity classifier preserves legitimate ownership cases', () => {
  assert.equal(shouldIgnoreForeignCodexHookIdentity({
    observedProviderSessionId: 'first-provider-id',
    event: 'SessionStart',
    source: 'startup',
  }), false, 'an unbound pane may adopt its first provider identity');
  assert.equal(shouldIgnoreForeignCodexHookIdentity({
    expectedProviderSessionId: 'same-provider-id',
    observedProviderSessionId: 'same-provider-id',
    event: 'PostToolUse',
  }), false, 'the owning provider identity remains accepted');
  assert.equal(shouldIgnoreForeignCodexHookIdentity({
    expectedProviderSessionId: 'old-provider-id',
    observedProviderSessionId: 'cleared-provider-id',
    event: 'SessionStart',
    source: 'clear',
  }), false, '/clear may replace the owning identity');
  for (const event of [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PermissionRequest',
    'Stop',
  ]) {
    assert.equal(shouldIgnoreForeignCodexHookIdentity({
      expectedProviderSessionId: 'parent-provider-id',
      observedProviderSessionId: 'foreign-provider-id',
      event,
    }), true, `${event} from a mismatched Codex identity is foreign`);
  }
  assert.equal(shouldIgnoreForeignCodexHookIdentity({
    expectedProviderSessionId: 'parent-provider-id',
    observedProviderSessionId: 'foreign-provider-id',
    event: 'UserPromptSubmit',
    source: 'clear',
  }), true, 'source=clear is only trusted on SessionStart');
});
