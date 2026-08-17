import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CodexHookLifecycleTracker,
  classifyCodexHookOrigin,
} from '@/lib/cli/providers/codex/terminal-hook-lifecycle';

const ROLLOUT_TEST_OVERSIZE_BYTES = 70 * 1024;

function writeRollout(threadSource: 'user' | 'subagent'): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-hook-'));
  const filePath = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(filePath, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: `${threadSource}-thread`,
      session_id: 'lead-thread',
      thread_source: threadSource,
    },
  })}\n`);
  return { dir, filePath };
}

test('Codex hook origin follows rollout thread_source instead of shared session_id', async (t) => {
  const lead = writeRollout('user');
  const child = writeRollout('subagent');
  t.after(() => {
    fs.rmSync(lead.dir, { recursive: true, force: true });
    fs.rmSync(child.dir, { recursive: true, force: true });
  });

  assert.equal(await classifyCodexHookOrigin({
    session_id: 'lead-thread',
    transcript_path: lead.filePath,
  }, 'native'), 'lead');
  assert.equal(await classifyCodexHookOrigin({
    session_id: 'lead-thread',
    transcript_path: child.filePath,
  }, 'native'), 'subagent');

  fs.rmSync(child.filePath);
  assert.equal(await classifyCodexHookOrigin({
    transcript_path: child.filePath,
  }, 'native'), 'subagent');
});

test('legacy Codex session metadata with a source remains a lead rollout', async (t) => {
  const legacy = writeRollout('user');
  t.after(() => fs.rmSync(legacy.dir, { recursive: true, force: true }));
  fs.writeFileSync(legacy.filePath, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'legacy-lead',
      source: 'vscode',
    },
  })}\n`);

  assert.equal(await classifyCodexHookOrigin({
    transcript_path: legacy.filePath,
  }, 'native'), 'lead');
});

test('unreadable or malformed Codex rollouts keep ownership unknown', async (t) => {
  const malformed = writeRollout('user');
  const truncated = writeRollout('user');
  t.after(() => fs.rmSync(malformed.dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(truncated.dir, { recursive: true, force: true }));
  fs.writeFileSync(malformed.filePath, '{not-json}\n');
  fs.writeFileSync(truncated.filePath, JSON.stringify({
    type: 'session_meta',
    padding: 'x'.repeat(ROLLOUT_TEST_OVERSIZE_BYTES),
    payload: { thread_source: 'subagent' },
  }));

  assert.equal(await classifyCodexHookOrigin({}, 'native'), 'unknown');
  assert.equal(await classifyCodexHookOrigin({
    transcript_path: path.join(malformed.dir, 'missing.jsonl'),
  }, 'native'), 'unknown');
  assert.equal(await classifyCodexHookOrigin({
    transcript_path: malformed.filePath,
  }, 'native'), 'unknown');
  assert.equal(await classifyCodexHookOrigin({
    transcript_path: truncated.filePath,
  }, 'native'), 'unknown');
});

test('late Codex child hooks cannot resurrect a completed lead turn', () => {
  const tracker = new CodexHookLifecycleTracker();
  const terminalId = 'terminal-with-late-child';

  assert.deepEqual(tracker.apply(terminalId, 'UserPromptSubmit', 'lead'), {
    status: 'running',
  });
  assert.deepEqual(tracker.apply(terminalId, 'Stop', 'lead'), {
    status: 'completed',
  });
  assert.equal(tracker.apply(terminalId, 'PreToolUse', 'subagent'), null);
  assert.equal(tracker.apply(terminalId, 'PostToolUse', 'subagent'), null);
  assert.equal(tracker.apply(terminalId, 'Stop', 'subagent'), null);

  assert.deepEqual(tracker.apply(terminalId, 'UserPromptSubmit', 'lead'), {
    status: 'running',
  });
});

test('no Codex tool delivery reopens a completed turn without a prompt boundary', () => {
  const tracker = new CodexHookLifecycleTracker();
  const terminalId = 'terminal-with-reordered-hooks';

  tracker.apply(terminalId, 'UserPromptSubmit', 'lead');
  tracker.apply(terminalId, 'Stop', 'lead');

  assert.equal(tracker.apply(terminalId, 'PostToolUse', 'lead'), null);
  assert.equal(tracker.apply(terminalId, 'PreToolUse', 'lead'), null);
  assert.equal(tracker.apply(terminalId, 'PreToolUse', 'unknown'), null);
});

test('Codex child activity never overwrites foreground lead state', () => {
  const tracker = new CodexHookLifecycleTracker();
  const terminalId = 'terminal-with-active-child';

  tracker.apply(terminalId, 'UserPromptSubmit', 'lead');
  assert.deepEqual(tracker.apply(terminalId, 'PermissionRequest', 'lead'), {
    status: 'input_required',
  });
  assert.equal(tracker.apply(terminalId, 'PreToolUse', 'subagent'), null);
  assert.equal(tracker.apply(terminalId, 'PostToolUse', 'subagent'), null);
});

test('unknown Codex ownership cannot open, close, or reset foreground state', () => {
  const tracker = new CodexHookLifecycleTracker();
  const terminalId = 'terminal-with-unknown-rollout';

  assert.equal(tracker.apply(terminalId, 'SessionStart', 'unknown'), null);
  assert.equal(tracker.apply(terminalId, 'UserPromptSubmit', 'unknown'), null);
  assert.equal(tracker.apply(terminalId, 'PreToolUse', 'unknown'), null);
  assert.equal(tracker.apply(terminalId, 'PermissionRequest', 'unknown'), null);
  assert.equal(tracker.apply(terminalId, 'Stop', 'unknown'), null);

  tracker.apply(terminalId, 'UserPromptSubmit', 'lead');
  tracker.apply(terminalId, 'Stop', 'lead');
  assert.equal(tracker.apply(terminalId, 'SessionStart', 'unknown'), null);
  assert.equal(tracker.apply(terminalId, 'UserPromptSubmit', 'unknown'), null);
  assert.equal(tracker.apply(terminalId, 'Stop', 'unknown'), null);
  assert.equal(tracker.apply(terminalId, 'PreToolUse', 'lead'), null);
  assert.deepEqual(tracker.apply(terminalId, 'UserPromptSubmit', 'lead'), {
    status: 'running',
  });
});
