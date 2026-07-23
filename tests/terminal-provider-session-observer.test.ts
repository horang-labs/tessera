import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexTerminalSessionObserver } from '@/lib/cli/providers/codex/terminal-session-observer';
import {
  createClaudeTerminalSessionObserver,
  isClaudeBackgroundTerminalSessionFork,
} from '@/lib/cli/providers/claude-code/terminal-session-observer';

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
  }));

  for (let attempt = 0; attempt < 500 && observed.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(observed, [{
    activation: 'background',
    providerSessionId: 'claude-child',
  }]);
  assert.equal(isClaudeBackgroundTerminalSessionFork({
    currentProviderSessionId: 'claude-parent',
    observedProviderSessionId: 'claude-child',
    jobsDir,
  }), true);
});
