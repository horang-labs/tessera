import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';
import type { TerminalCwdResolution } from '@/lib/terminal/types';

process.env.TESSERA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tessera-cwd-test-'));
process.env.NODE_ENV = 'test';

let projectA = '';
let projectB = '';
let resolveTerminalCwd: (candidate?: string | null) => string;
let resolveAllowedTerminalCwd: (options: {
  cwd?: string | null;
  sessionId?: string | null;
}) => TerminalCwdResolution;

before(async () => {
  const [{ initDatabase }, projects, sessions, resolver] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/terminal/terminal-resolver'),
  ]);
  await initDatabase();
  projectA = mkdtempSync(path.join(tmpdir(), 'tessera-project-a-'));
  projectB = mkdtempSync(path.join(tmpdir(), 'tessera-project-b-'));
  projects.registerProject('project-a', projectA, 'Project A');
  projects.registerProject('project-b', projectB, 'Project B');
  sessions.createSession('session-b', 'project-b', 'Session B', 'codex', {
    workDir: projectB,
  });
  resolveTerminalCwd = resolver.resolveTerminalCwd;
  resolveAllowedTerminalCwd = resolver.resolveAllowedTerminalCwd;
});

test('a project-B session rejects a project-A cwd', () => {
  assert.deepEqual(
    resolveAllowedTerminalCwd({ cwd: projectA, sessionId: 'session-b' }),
    {
      ok: false,
      message: 'Terminal cwd must be inside a registered project or active worktree.',
    },
  );
});

test('an unknown session id cannot be treated as a standalone terminal', () => {
  assert.deepEqual(
    resolveAllowedTerminalCwd({ cwd: projectA, sessionId: 'missing-session' }),
    { ok: false, message: 'The session workspace is unavailable.' },
  );
});

test('a terminal without a cwd fails instead of selecting a registered project', () => {
  assert.deepEqual(
    resolveAllowedTerminalCwd({ cwd: null, sessionId: null }),
    { ok: false, message: 'Terminal cwd is required.' },
  );
});

test('a missing cwd never degrades to the process home directory', () => {
  assert.throws(
    () => resolveTerminalCwd(path.join(projectB, 'deleted-worktree')),
    /Terminal cwd does not exist or is not a directory/,
  );
});

test('a session may still launch inside its own persisted workspace', () => {
  assert.deepEqual(
    resolveAllowedTerminalCwd({ cwd: projectB, sessionId: 'session-b' }),
    { ok: true, cwd: projectB },
  );
});
