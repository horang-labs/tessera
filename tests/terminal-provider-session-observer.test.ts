import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCodexTerminalSessionObserver,
  resolveCodexSessionsDir,
} from '@/lib/cli/providers/codex/terminal-session-observer';
import {
  createClaudeTerminalSessionObserver,
  resolveClaudeBackgroundTerminalSessionFork,
  resolveClaudeJobsDir,
} from '@/lib/cli/providers/claude-code/terminal-session-observer';

/**
 * Forces the bridged topology (Windows server, WSL agent) the packaged app
 * ships. Without it every path helper is a no-op on this machine, which is
 * exactly why the same bug keeps reaching users unnoticed.
 */
function withBridgedPlatform(t: { after: (fn: () => void) => void }): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', original));
}

test('Codex fork artifacts report the child identity before its first prompt', async (t) => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-observer-'));
  t.after(() => fs.rmSync(sessionsDir, { recursive: true, force: true }));
  const observed: Array<Record<string, unknown>> = [];
  const observer = createCodexTerminalSessionObserver({
    sessionsDir,
    currentProviderSessionId: () => 'thread-parent',
    onObservation: (observation) => observed.push(observation),
  });
  t.after(observer.dispose);
  await observer.ready();

  const childPath = path.join(sessionsDir, 'rollout-child.jsonl');
  fs.writeFileSync(childPath, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'thread-child',
      session_id: 'thread-child',
      forked_from_id: 'thread-parent',
      cwd: '/workspace',
    },
  })}\n`);

  for (let attempt = 0; attempt < 500 && observed.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(observed, [{
    activation: 'active',
    providerSessionId: 'thread-child',
    transcriptPath: childPath,
  }]);
});

test('Claude background fork jobs are discovered without activating the parent PTY', async (t) => {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-claude-observer-'));
  t.after(() => fs.rmSync(jobsDir, { recursive: true, force: true }));
  const observed: Array<Record<string, unknown>> = [];
  const observer = createClaudeTerminalSessionObserver({
    jobsDir,
    currentProviderSessionId: () => 'claude-parent',
    onObservation: (observation) => observed.push(observation),
  });
  t.after(observer.dispose);
  await observer.ready();

  const jobDir = path.join(jobsDir, 'claude-c');
  fs.mkdirSync(jobDir);
  fs.writeFileSync(path.join(jobDir, 'state.json'), JSON.stringify({
    forkSessionId: 'claude-child',
    forkParentSessionId: 'claude-parent',
    interactiveLineage: true,
    cwd: '/home/u/origin-checkout',
  }));

  for (let attempt = 0; attempt < 500 && observed.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(observed, [{
    activation: 'background',
    providerSessionId: 'claude-child',
    workDir: '/home/u/origin-checkout',
  }]);
});

test('A Claude background fork reports the directory it actually runs in', async (t) => {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-claude-fork-'));
  t.after(() => fs.rmSync(jobsDir, { recursive: true, force: true }));
  const jobDir = path.join(jobsDir, 'claude-c');
  fs.mkdirSync(jobDir);
  // Forking out of a linked worktree runs the child in the origin checkout;
  // inheriting the parent's directory would resume it in the wrong tree.
  fs.writeFileSync(path.join(jobDir, 'state.json'), JSON.stringify({
    forkSessionId: 'claude-child',
    forkParentSessionId: 'claude-parent',
    interactiveLineage: true,
    cwd: '/home/u/origin-checkout',
  }));

  assert.deepEqual(await resolveClaudeBackgroundTerminalSessionFork({
    currentProviderSessionId: 'claude-parent',
    observedProviderSessionId: 'claude-child',
    environment: 'native',
    jobsDir,
  }), { workDir: '/home/u/origin-checkout' });

  // A hook from an unrelated conversation must not be mistaken for this fork.
  assert.equal(await resolveClaudeBackgroundTerminalSessionFork({
    currentProviderSessionId: 'someone-else',
    observedProviderSessionId: 'claude-child',
    environment: 'native',
    jobsDir,
  }), null);
});

test('Bridged CLI homes ignore this server\'s own config vars', async (t) => {
  withBridgedPlatform(t);
  const serverSideConfigDir = path.join(os.tmpdir(), 'tessera-server-side-config');
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = serverSideConfigDir;
  process.env.CODEX_HOME = serverSideConfigDir;
  t.after(() => {
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  // These vars belong to this server. The agent's CLI runs on the other side of
  // the bridge and never saw them, so a root derived from them points at files
  // the CLI has never written — the failure is silent, so assert it directly.
  const claudeJobsDir = await resolveClaudeJobsDir({ environment: 'wsl' });
  assert.equal(claudeJobsDir.startsWith(serverSideConfigDir), false, claudeJobsDir);
  assert.equal(path.basename(claudeJobsDir), 'jobs');

  const codexSessionsDir = await resolveCodexSessionsDir({ environment: 'wsl' });
  assert.equal(codexSessionsDir.startsWith(serverSideConfigDir), false, codexSessionsDir);
  assert.equal(path.basename(codexSessionsDir), 'sessions');

  // Not bridged: the same vars are the server's own CLI and must be honoured.
  assert.equal(
    await resolveClaudeJobsDir({ environment: 'native' }),
    path.join(path.resolve(serverSideConfigDir), 'jobs'),
  );
});
