import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AUTORUN_HOOK_OBSERVER } from '../src/lib/terminal/autorun-observer';
import { buildAutorunHookEvidence } from '../src/lib/cli/providers/autorun-hook-evidence';
async function observe(payload: Record<string, unknown>) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', AUTORUN_HOOK_OBSERVER], { stdio: 'pipe' });
    let output = ''; child.stdout.on('data', b => output += b); child.on('error', reject);
    child.on('close', code => { if (code !== 0) reject(new Error('observer failure')); else resolve(JSON.parse(output)); });
    child.stdin.end(JSON.stringify(payload));
  });
}
test('native observer persists one submission identity/cursor across retransmission and Stop, with no approval decision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autorun-hook-'));
  try {
    const file = root + '/native.jsonl'; await fs.writeFile(file, '');
    const submission = { hook_event_name: 'UserPromptSubmit', transcript_path: file, session_id: 'conversation', prompt_id: 'prompt', prompt: 'Fix login' };
    const first = await observe(submission); const duplicate = await observe(submission);
    assert.deepEqual(first.tessera_autorun, duplicate.tessera_autorun);
    await fs.writeFile(file, '{"type":"user"}\n');
    const stop = await observe({ ...submission, hook_event_name: 'Stop', last_assistant_message: 'Done' });
    assert.equal(stop.tessera_autorun.observerSubmissionId, first.tessera_autorun.observerSubmissionId);
    assert.equal(stop.tessera_autorun.startByte, 0);
    assert.ok(stop.tessera_autorun.completionHookId);
    assert.equal(stop.decision, undefined);
    const event = buildAutorunHookEvidence({ userId: 'owner', sessionId: 'session', agentEnvironment: 'wsl', provider: 'claude-code', payload: stop,
      observation: { userId: 'owner', sessionId: 'session', terminalId: 'terminal', serverInstanceId: 'server', generation: 3, sequence: 2,
        observedAt: 1, state: 'turn-complete', backgroundWork: 'clear', exitKind: null } });
    assert.equal(event?.kind, 'completion');
    assert.equal(event?.evidence.serverInstanceId, 'server');
    assert.equal(event?.evidence.terminalGeneration, 3);
  } finally { await fs.rm(root, { recursive: true }); }
});
test('first submission is instrumented before the native transcript exists and binds the eventual file generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autorun-first-hook-'));
  try {
    const file = root + '/new-project/native.jsonl';
    const submitted = await observe({ hook_event_name: 'UserPromptSubmit', transcript_path: file, session_id: 'conversation', prompt_id: 'first', prompt: 'Fix login' });
    assert.ok(submitted.tessera_autorun, 'first accepted turn must carry observer evidence');
    await fs.writeFile(file, '{"type":"user"}\n');
    const stop = await observe({ hook_event_name: 'Stop', transcript_path: file, session_id: 'conversation', prompt_id: 'first', last_assistant_message: 'Done' });
    assert.equal(stop.tessera_autorun.fileGeneration, submitted.tessera_autorun.fileGeneration);
    assert.equal(stop.tessera_autorun.observerSubmissionId, submitted.tessera_autorun.observerSubmissionId);
  } finally { await fs.rm(root, { recursive: true }); }
});
