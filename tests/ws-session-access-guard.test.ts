import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-ws-access-test-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

const USER_ID = 'user-1';
const MISSING_SESSION_ID = 'temp-00000000-0000-4000-8000-000000000000';

async function loadGuard() {
  const [{ initDatabase }, { verifyClientSessionAccess }] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/ws/server-message-routing'),
  ]);
  await initDatabase();
  return verifyClientSessionAccess;
}

function collectSent() {
  const sent: unknown[] = [];
  return {
    sent,
    sendToUser: (_userId: string, message: unknown) => {
      sent.push(message);
    },
  };
}

// Workspace file subscriptions use the session id only to look up a workspace
// root. Both the REST route and the watch manager already answer "no such
// session" with an empty list / a missing_work_dir fallback, so the guard must
// not turn them into a user-facing error — that is what surfaced a "Session
// does not exist" toast for the optimistic temp- session during creation.
test('workspace file subscriptions pass the guard for an unknown session', async () => {
  const verifyClientSessionAccess = await loadGuard();

  for (const type of ['subscribe_workspace_files', 'unsubscribe_workspace_files'] as const) {
    const { sendToUser, sent } = collectSent();
    const allowed = verifyClientSessionAccess(
      USER_ID,
      {
        type,
        requestId: 'req-1',
        sessionId: MISSING_SESSION_ID,
        subscriberId: 'workspace-file-panel:test',
      },
      sendToUser,
    );

    assert.equal(allowed, true, `${type} should be allowed`);
    assert.deepEqual(sent, [], `${type} should not emit an error`);
  }
});

test('other session messages still fail for an unknown session', async () => {
  const verifyClientSessionAccess = await loadGuard();
  const { sendToUser, sent } = collectSent();

  const allowed = verifyClientSessionAccess(
    USER_ID,
    { type: 'stop_session', requestId: 'req-2', sessionId: MISSING_SESSION_ID },
    sendToUser,
  );

  assert.equal(allowed, false);
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { code?: string }).code, 'session_not_found');
});

test('structured terminal launch can defer a missing Session to its launch module', async () => {
  const verifyClientSessionAccess = await loadGuard();
  const { sendToUser, sent } = collectSent();

  const allowed = verifyClientSessionAccess(
    USER_ID,
    {
      type: 'terminal_create',
      requestId: 'req-3',
      terminalId: 'terminal-missing-session',
      surfaceId: 'surface-missing-session',
      launch: {
        sessionId: MISSING_SESSION_ID,
        providerId: 'codex',
      },
    },
    sendToUser,
    { allowMissingSession: true },
  );

  assert.equal(allowed, true);
  assert.deepEqual(sent, []);
});
