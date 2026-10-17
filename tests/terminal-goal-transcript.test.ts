import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reduceClaudeGoalTranscriptLine } from '@/lib/cli/providers/claude-code/goal-transcript';
import { reduceCodexGoalTranscriptLine } from '@/lib/cli/providers/codex/goal-transcript';
import { TerminalGoalTracker, type TerminalGoalTarget } from '@/lib/terminal/terminal-goal-tracker';
import type { TerminalGoalSnapshot } from '@/types/terminal-goal';

// Line shapes below are copied from real transcripts (Claude Code 2.1.284,
// Codex 0.162.1), trimmed to the fields the readers use.

function claudeGoal(attachment: Record<string, unknown>, timestamp: string): string {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    type: 'attachment',
    uuid: 'u',
    timestamp,
    attachment: { type: 'goal_status', ...attachment },
  });
}

function fold(
  reduce: (current: TerminalGoalSnapshot | null, line: string) => TerminalGoalSnapshot | null | undefined,
  lines: string[],
  start: TerminalGoalSnapshot | null = null,
): TerminalGoalSnapshot | null {
  let goal = start;
  for (const line of lines) {
    const next = reduce(goal, line);
    if (next !== undefined) goal = next;
  }
  return goal;
}

test('Claude: set, not-met evaluations, then achieved', () => {
  const set = claudeGoal({ met: false, sentinel: true, condition: 'ship it' }, '2026-10-17T13:36:23.118Z');
  const notMet = claudeGoal({ met: false, condition: 'ship it', reason: 'tests still failing' }, '2026-10-17T13:37:00.000Z');
  const met = claudeGoal({
    met: true,
    condition: 'ship it',
    reason: 'done',
    iterations: 2,
    durationMs: 137_978,
    tokens: 11_259,
  }, '2026-10-17T13:38:41.096Z');

  const afterSet = fold(reduceClaudeGoalTranscriptLine, [set]);
  assert.equal(afterSet?.status, 'active');
  assert.equal(afterSet?.objective, 'ship it');
  assert.equal(afterSet?.setAt, Date.parse('2026-10-17T13:36:23.118Z'));
  assert.equal(afterSet?.iterations, 0);

  const afterNotMet = fold(reduceClaudeGoalTranscriptLine, [set, notMet]);
  assert.equal(afterNotMet?.status, 'active');
  assert.equal(afterNotMet?.iterations, 1);
  assert.equal(afterNotMet?.lastReason, 'tests still failing');

  const done = fold(reduceClaudeGoalTranscriptLine, [set, notMet, met]);
  assert.equal(done?.status, 'complete');
  assert.equal(done?.iterations, 2);
  assert.equal(done?.elapsedSeconds, 138);
  assert.equal(done?.tokensUsed, 11_259);
  assert.equal(done?.setAt, afterSet?.setAt, 'goal identity survives its updates');
});

test('Claude: the met sentinel is /goal clear, failed is impossible', () => {
  const set = claudeGoal({ met: false, sentinel: true, condition: 'x' }, '2026-10-05T09:31:37.104Z');
  const cleared = claudeGoal({ met: true, sentinel: true, condition: 'x' }, '2026-10-05T13:27:18.626Z');
  assert.equal(fold(reduceClaudeGoalTranscriptLine, [set, cleared]), null);

  const failed = claudeGoal({ met: false, failed: true, condition: 'x', reason: 'cannot' }, '2026-10-05T10:00:00.000Z');
  assert.equal(fold(reduceClaudeGoalTranscriptLine, [set, failed])?.status, 'failed');
});

test('Claude: unrelated and sidechain lines are ignored', () => {
  assert.equal(reduceClaudeGoalTranscriptLine(null, '{"type":"user","message":{"content":"goal"}}'), undefined);
  const sidechain = JSON.stringify({
    isSidechain: true,
    type: 'attachment',
    attachment: { type: 'goal_status', met: false, sentinel: true, condition: 'child' },
  });
  assert.equal(reduceClaudeGoalTranscriptLine(null, sidechain), undefined);
});

function codexGoalEvent(goal: Record<string, unknown>, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'thread_goal_updated', threadId: 't', goal: { threadId: 't', ...goal } },
  });
}

function codexUserContext(text: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `<codex_internal_context source="user_goal">\n${text}\n</codex_internal_context>` }],
    },
  });
}

test('Codex: set, pause, resume, complete via update_goal, then clear', () => {
  const objective = 'Count slowly from 1 to 30';
  const set = codexGoalEvent({
    objective, status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1792244804, updatedAt: 1792244804,
  }, '2026-10-17T13:46:44.602Z');
  const paused = codexGoalEvent({
    objective, status: 'paused', tokensUsed: 4104, timeUsedSeconds: 12, createdAt: 1792244804, updatedAt: 1792244816,
  }, '2026-10-17T13:46:56.894Z');
  const resumed = codexGoalEvent({
    objective, status: 'active', tokensUsed: 4104, timeUsedSeconds: 12, createdAt: 1792244804, updatedAt: 1792244832,
  }, '2026-10-17T13:47:12.326Z');
  const completed = JSON.stringify({
    timestamp: '2026-10-17T13:48:00.000Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'c',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
        {
          type: 'input_text',
          text: JSON.stringify({
            goal: {
              threadId: 't', objective, status: 'complete', tokensUsed: 5261, timeUsedSeconds: 40,
              createdAt: 1792244804, updatedAt: 1792244880,
            },
            remainingTokens: null,
          }),
        },
      ],
    },
  });
  const cleared = codexUserContext('User cleared the goal.', '2026-10-17T13:49:00.000Z');

  const active = fold(reduceCodexGoalTranscriptLine, [set]);
  assert.equal(active?.status, 'active');
  assert.equal(active?.setAt, 1792244804_000, 'Codex seconds become epoch ms');

  const afterPause = fold(reduceCodexGoalTranscriptLine, [set, paused]);
  assert.equal(afterPause?.status, 'paused');
  assert.equal(afterPause?.elapsedSeconds, 12);
  assert.equal(afterPause?.tokensUsed, 4104);

  assert.equal(fold(reduceCodexGoalTranscriptLine, [set, paused, resumed])?.status, 'active');

  const done = fold(reduceCodexGoalTranscriptLine, [set, paused, resumed, completed]);
  assert.equal(done?.status, 'complete');
  assert.equal(done?.tokensUsed, 5261);

  assert.equal(fold(reduceCodexGoalTranscriptLine, [set, paused, resumed, completed, cleared]), null);
});

test('Codex: a goal set message is not mistaken for a clear', () => {
  const setMessage = codexUserContext('User set the goal: "a"\nUser set goal status: "active".', '2026-10-17T13:45:43.565Z');
  assert.equal(reduceCodexGoalTranscriptLine(null, setMessage), undefined);
});

test('Codex: an update_goal result for an older goal does not resurrect it', () => {
  const current: TerminalGoalSnapshot = {
    provider: 'codex', objective: 'new', status: 'active', setAt: 2, updatedAt: 2,
  };
  const stale = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      output: [{ type: 'input_text', text: JSON.stringify({ goal: { objective: 'old', status: 'complete' } }) }],
    },
  });
  assert.equal(reduceCodexGoalTranscriptLine(current, stale), undefined);
});

function makeTracker(filePath: string, live = { value: true }) {
  const published: Array<TerminalGoalSnapshot | null> = [];
  const started: TerminalGoalSnapshot[] = [];
  const tracker = new TerminalGoalTracker({
    resolveTranscriptFile: async () => filePath,
    reduceLine: (_provider, current, line) => reduceClaudeGoalTranscriptLine(current, line),
    isLive: () => live.value,
    publish: (_target, goal) => published.push(goal),
    onGoalStarted: (_target, goal) => started.push(goal),
  });
  const target: TerminalGoalTarget = {
    sessionId: 's1',
    terminalId: 'term-1',
    userId: 'u1',
    providerId: 'claude-code',
    providerSessionId: 'p1',
    transcriptPath: null,
  };
  return { tracker, target, published, started };
}

function tempTranscript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-goal-'));
  const filePath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(filePath, '');
  return filePath;
}

test('tracker reads incrementally, publishes changes once, and waits for whole lines', async () => {
  const filePath = tempTranscript();
  const { tracker, target, published, started } = makeTracker(filePath);
  try {
    const now = new Date().toISOString();
    const set = claudeGoal({ met: false, sentinel: true, condition: '한글 목표 ✨' }, now);
    // Half a line first: nothing is decoded until the newline lands.
    fs.appendFileSync(filePath, set.slice(0, 40));
    await tracker.observe(target);
    assert.deepEqual(published, []);

    fs.appendFileSync(filePath, `${set.slice(40)}\n`);
    await tracker.observe(target);
    assert.equal(published.length, 1);
    assert.equal(published[0]?.objective, '한글 목표 ✨');
    assert.equal(started.length, 1, 'a freshly set goal starts a turn');

    // No growth, no republish.
    await tracker.observe(target);
    assert.equal(published.length, 1);

    fs.appendFileSync(filePath, `${claudeGoal({ met: true, sentinel: true, condition: '한글 목표 ✨' }, now)}\n`);
    await tracker.observe(target);
    assert.equal(published.at(-1), null);
  } finally {
    tracker.dispose();
  }
});

test('tracker holds a Stop until the evaluator verdict, then releases or continues', async () => {
  const filePath = tempTranscript();
  const { tracker, target } = makeTracker(filePath);
  try {
    const now = new Date().toISOString();
    fs.appendFileSync(filePath, `${claudeGoal({ met: false, sentinel: true, condition: 'c' }, now)}\n`);
    await tracker.observe(target);

    let released = 0;
    let continued = 0;
    const handlers = { release: () => { released += 1; }, onContinue: () => { continued += 1; } };

    assert.equal(tracker.holdCompletion('u1', 's1', handlers), true);
    // Evaluator: not yet → Claude keeps working, the Stop never completes.
    fs.appendFileSync(filePath, `${claudeGoal({ met: false, condition: 'c', reason: 'no' }, now)}\n`);
    await tracker.observe(target);
    assert.equal(released, 0);
    assert.equal(continued, 1);
    assert.equal(tracker.isHoldingCompletion('u1', 's1'), false);

    // Next Stop: evaluator says met → the deferred completion fires once.
    assert.equal(tracker.holdCompletion('u1', 's1', handlers), true);
    fs.appendFileSync(filePath, `${claudeGoal({ met: true, condition: 'c', reason: 'yes', iterations: 2 }, now)}\n`);
    await tracker.observe(target);
    assert.equal(released, 1);
    assert.equal(tracker.isHoldingCompletion('u1', 's1'), false);

    // No active goal any more: Stops complete immediately.
    assert.equal(tracker.holdCompletion('u1', 's1', handlers), false);
  } finally {
    tracker.dispose();
  }
});

test('tracker ignores history: an old active goal on first read is not a new turn', async () => {
  const filePath = tempTranscript();
  const { tracker, target, published, started } = makeTracker(filePath);
  try {
    fs.appendFileSync(filePath, `${claudeGoal({ met: false, sentinel: true, condition: 'old' }, '2026-01-01T00:00:00.000Z')}\n`);
    await tracker.observe(target);
    assert.equal(published[0]?.status, 'active');
    assert.equal(started.length, 0);
  } finally {
    tracker.dispose();
  }
});

test('tracker drops a session whose runtime ended and clears its goal', async () => {
  const filePath = tempTranscript();
  const live = { value: true };
  const { tracker, target, published } = makeTracker(filePath, live);
  try {
    fs.appendFileSync(filePath, `${claudeGoal({ met: false, sentinel: true, condition: 'c' }, new Date().toISOString())}\n`);
    await tracker.observe(target);
    live.value = false;
    await tracker.observe(target);
    assert.equal(published.at(-1), null);
    assert.equal(tracker.getGoal('u1', 's1'), null);
  } finally {
    tracker.dispose();
  }
});
