import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CODEX_GOAL_LINE_MARKERS, reduceCodexGoalTranscriptLine } from '@/lib/cli/providers/codex/goal-transcript';
import { TerminalGoalTracker, type TerminalGoalTarget } from '@/lib/terminal/terminal-goal-tracker';
import { CodexHookLifecycleTracker } from '@/lib/cli/providers/codex/terminal-hook-lifecycle';

const target: TerminalGoalTarget = {
  userId: 'u', sessionId: 's', terminalId: 't', providerId: 'codex',
  providerSessionId: 'lead', transcriptPath: null,
};
const failure = JSON.stringify({
  timestamp: '2026-10-21T03:03:24.426Z', type: 'event_msg',
  payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: null,
    error: { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' } },
});

for (const goal of ['absent', 'complete', 'active'] as const) {
  test(`Codex failed turn is reported with ${goal} goal, without a Stop hook`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-turn-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'rollout.jsonl');
    const ended: Array<{ stateAt: number; preview?: string }> = [];
    fs.writeFileSync(file, goal === 'absent' ? '' : `${JSON.stringify({
      timestamp: '2026-10-21T03:00:00.000Z', type: 'event_msg',
      payload: { type: 'thread_goal_updated', goal: { objective: 'ship', status: goal } },
    })}\n`);
    const tracker = new TerminalGoalTracker({
      resolveTranscriptFile: async () => file,
      lineMarkers: () => CODEX_GOAL_LINE_MARKERS,
      reduceLine: (_provider, current, line) => reduceCodexGoalTranscriptLine(current, line),
      isLive: () => true, publish: () => {},
      onTurnEnded: (_target, boundary) => ended.push(boundary),
    });
    t.after(() => tracker.dispose());
    await tracker.observe(target);
    fs.appendFileSync(file, failure); // A partial append must not stop a turn.
    await tracker.observe(target);
    assert.equal(ended.length, 0);
    fs.appendFileSync(file, '\n');
    await tracker.observe(target);
    assert.deepEqual(ended, [{
      stateAt: Date.parse('2026-10-21T03:03:24.426Z'),
      preview: 'Selected model is at capacity. Please try a different model.',
    }]);
    await tracker.observe(target);
    assert.equal(ended.length, 1);
    assert.equal(tracker.getGoal('u', 's')?.status ?? 'absent', goal === 'active' ? 'stalled' : 'absent');
  });
}

test('replaying an active goal failure followed by a newer turn does not close the newer turn', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({
    timestamp: '2026-10-21T03:00:00.000Z', type: 'event_msg',
    payload: { type: 'thread_goal_updated', goal: { objective: 'ship', status: 'active' } },
  })}\n`);
  let ended = 0;
  const tracker = new TerminalGoalTracker({
    resolveTranscriptFile: async () => file,
    lineMarkers: () => CODEX_GOAL_LINE_MARKERS,
    reduceLine: (_provider, current, line) => reduceCodexGoalTranscriptLine(current, line),
    isLive: () => true, publish: () => {}, onTurnEnded: () => { ended += 1; },
  });
  t.after(() => tracker.dispose());
  await tracker.observe(target);
  fs.appendFileSync(file, `${failure}\n${JSON.stringify({
    timestamp: '2026-10-21T03:55:33.250Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' },
  })}\n`);
  await tracker.observe(target);
  assert.equal(ended, 0);
});

test('a failed turn closes despite later tool delivery, and stays closed until a new prompt', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const lifecycle = new CodexHookLifecycleTracker();
  lifecycle.apply('t', 'UserPromptSubmit', 'lead');
  t.mock.timers.tick(2000);
  lifecycle.apply('t', 'PostToolUse', 'lead');
  assert.equal(lifecycle.endTurnFromTranscript('t', 2000), true);
  assert.equal(lifecycle.apply('t', 'PostToolUse', 'lead'), null);
  assert.equal(lifecycle.apply('t', 'PreToolUse', 'subagent'), null);
  assert.deepEqual(lifecycle.apply('t', 'UserPromptSubmit', 'lead'), { status: 'running' });
  assert.equal(lifecycle.endTurnFromTranscript('t', 2000), false, 'an older error cannot close the new prompt');
  lifecycle.reopenTurn('t');
  assert.equal(lifecycle.endTurnFromTranscript('t', 2000), false, 'an older error cannot close a goal continuation');
});

test('a delayed goal observation uses its actual start time to accept a later failure', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 3000 });
  const lifecycle = new CodexHookLifecycleTracker();
  lifecycle.reopenTurn('t', 1000);
  assert.equal(lifecycle.endTurnFromTranscript('t', 2000), true);
  lifecycle.apply('t', 'UserPromptSubmit', 'lead');
  lifecycle.reopenTurn('t', 1000);
  assert.equal(lifecycle.endTurnFromTranscript('t', 2000), false, 'observing an older goal cannot replace a newer prompt start');
});

test('abort closes the turn; successful completion and quoted errors use normal hooks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, '');
  let ended = 0;
  const tracker = new TerminalGoalTracker({
    resolveTranscriptFile: async () => file, lineMarkers: () => CODEX_GOAL_LINE_MARKERS,
    reduceLine: (_provider, current, line) => reduceCodexGoalTranscriptLine(current, line),
    isLive: () => true, publish: () => {}, onTurnEnded: () => { ended += 1; },
  });
  t.after(() => tracker.dispose());
  await tracker.observe(target);
  const event = (type: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type } });
  fs.appendFileSync(file, `${failure}\n${event('task_complete')}\n`);
  await tracker.observe(target);
  assert.equal(ended, 0, 'a clean completion supersedes a replayed error');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'response_item', payload: { text: failure } })}\n`);
  await tracker.observe(target);
  assert.equal(ended, 0, 'quoting a failure in tool output is not an event');
  fs.appendFileSync(file, `${event('turn_aborted')}\n`);
  await tracker.observe(target);
  assert.equal(ended, 1);
});
