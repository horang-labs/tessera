import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-execution-mode-test-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

test('effective execution mode is fixed on the persisted session', async () => {
  const [{ initDatabase }, sessions, { persistCreatedSessionRecord }] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/sessions'),
    import('@/lib/session/session-persistence'),
  ]);
  await initDatabase();

  persistCreatedSessionRecord({
    sessionId: 'opencode-pty',
    resolvedWorkDir: dataDir,
    title: 'OpenCode PTY',
    providerId: 'opencode',
    executionMode: 'pty',
  });
  persistCreatedSessionRecord({
    sessionId: 'claude-gui',
    resolvedWorkDir: dataDir,
    title: 'Claude GUI',
    providerId: 'claude-code',
    executionMode: 'gui',
  });

  assert.equal(
    sessions.extractSessionKind(sessions.getSession('opencode-pty')?.provider_state ?? null),
    'terminal',
  );
  assert.equal(
    sessions.extractSessionKind(sessions.getSession('claude-gui')?.provider_state ?? null),
    'chat',
  );

  sessions.updateSession('opencode-pty', {
    provider_state: JSON.stringify({
      kind: 'terminal',
      opencodeSessionId: 'gui-session',
    }),
  });
  sessions.markOpenCodeTerminalSession('opencode-pty', 'pty-session');
  const opencodeState = sessions.getSession('opencode-pty')?.provider_state ?? null;
  assert.equal(sessions.extractOpenCodeSessionId(opencodeState), 'gui-session');
  assert.equal(sessions.extractOpenCodeTerminalSessionId(opencodeState), 'pty-session');
});
