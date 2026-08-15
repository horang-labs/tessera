import assert from 'node:assert/strict';
import childProcess from 'child_process';
import fs, { mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

test('a transient WSL distro lookup failure is retried', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalExecFileSync = childProcess.execFileSync;
  const originalStatSync = fs.statSync;
  const originalWslDistroName = process.env.WSL_DISTRO_NAME;
  let lookupAttempts = 0;

  Object.defineProperty(process, 'platform', { value: 'win32' });
  delete process.env.WSL_DISTRO_NAME;
  childProcess.execFileSync = (() => {
    lookupAttempts += 1;
    if (lookupAttempts === 1) throw new Error('WSL is still starting');
    return 'Ubuntu-24.04';
  }) as typeof childProcess.execFileSync;
  fs.statSync = ((candidate: fs.PathLike) => {
    if (String(candidate).startsWith('\\\\wsl.localhost\\Ubuntu-24.04\\')) {
      return { isDirectory: () => true } as fs.Stats;
    }
    throw new Error('Not visible to the Windows host');
  }) as typeof fs.statSync;
  syncBuiltinESMExports();

  try {
    assert.deepEqual(
      resolveAllowedTerminalCwd({ cwd: projectB, sessionId: 'session-b' }),
      { ok: false, message: 'Terminal cwd does not exist or is not a directory.' },
    );
    assert.deepEqual(
      resolveAllowedTerminalCwd({ cwd: projectB, sessionId: 'session-b' }),
      {
        ok: true,
        cwd: `\\\\wsl.localhost\\Ubuntu-24.04${projectB.replaceAll('/', '\\')}`,
      },
    );
    assert.equal(lookupAttempts, 2);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    fs.statSync = originalStatSync;
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalWslDistroName === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = originalWslDistroName;
    syncBuiltinESMExports();
  }
});
