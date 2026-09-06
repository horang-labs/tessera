import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.TESSERA_DATA_DIR = mkdtempSync(path.join(process.cwd(), '.runtime-recovery-test-'));
process.env.NODE_ENV = 'test';
after(async () => {
  const { getDb } = await import('@/lib/db/database');
  getDb().close();
  rmSync(process.env.TESSERA_DATA_DIR!, { recursive: true, force: true });
});

test('restart restores live sessions across projects without mounting a terminal', async () => {
  const { initDatabase } = await import('@/lib/db/database');
  await initDatabase();
  const { registerProject } = await import('@/lib/db/projects');
  const { createSession } = await import('@/lib/db/sessions');
  const { recordSessionRuntime, restoreSessionRuntimes } = await import('@/lib/session/session-runtime-recovery');
  for (const id of ['project-a', 'project-b']) {
    registerProject(id, process.cwd(), id);
    createSession(id + '-session', id, id, 'codex', { providerState: JSON.stringify({ kind: 'terminal' }) });
    recordSessionRuntime({ sessionId: id + '-session', userId: 'wsl-user', running: true });
  }
  createSession('stopped-session', 'project-a', 'stopped', 'codex', { providerState: JSON.stringify({ kind: 'terminal' }) });
  recordSessionRuntime({ sessionId: 'stopped-session', userId: 'wsl-user', running: true });
  recordSessionRuntime({ sessionId: 'stopped-session', userId: 'wsl-user', running: false });
  const { getDb } = await import('@/lib/db/database');
  createSession('archived-session', 'project-a', 'archived', 'codex', { providerState: JSON.stringify({ kind: 'terminal' }) });
  recordSessionRuntime({ sessionId: 'archived-session', userId: 'wsl-user', running: true });
  getDb().prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run('archived-session');
  const { markServerShuttingDown } = await import('@/lib/server-lifecycle');
  markServerShuttingDown();
  recordSessionRuntime({ sessionId: 'project-a-session', userId: 'wsl-user', running: false });
  recordSessionRuntime({ sessionId: 'project-b-session', userId: 'wsl-user', running: false });
  // Model the next server process while keeping the same persistent database.
  Reflect.deleteProperty(globalThis, Symbol.for('tessera.serverShuttingDown'));
  const launched: string[] = [];
  await restoreSessionRuntimes(async (request) => {
    assert.equal(request.userId, 'wsl-user');
    assert.equal(request.mode, 'detached');
    launched.push(request.sessionId);
  });
  assert.deepEqual(launched.sort(), ['project-a-session', 'project-b-session']);
  const attempted: string[] = [];
  await restoreSessionRuntimes(async (request) => {
    attempted.push(request.sessionId);
    if (request.sessionId === 'project-a-session') throw new Error('WSL temporarily unavailable');
  });
  assert.deepEqual(attempted.sort(), ['project-a-session', 'project-b-session']);
});
