import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reduceClaudeGoalTranscriptLine } from '@/lib/cli/providers/claude-code/goal-transcript';
import { reduceCodexGoalTranscriptLine } from '@/lib/cli/providers/codex/goal-transcript';
import {
  GOAL_INITIAL_REPLAY_BYTES,
  TerminalGoalTracker,
  type TerminalGoalTarget,
} from '@/lib/terminal/terminal-goal-tracker';
import { CLAUDE_GOAL_LINE_MARKERS } from '@/lib/cli/providers/claude-code/goal-transcript';
import {
  TERMINAL_GOAL_HISTORY_LIMIT,
  mergeTerminalGoalHistory,
  parseTerminalGoalHistory,
  terminalGoalEnding,
  type TerminalGoalHistoryEntry,
  type TerminalGoalSnapshot,
} from '@/types/terminal-goal';

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
    lineMarkers: () => CLAUDE_GOAL_LINE_MARKERS,
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

test('tracker hides a goal that already ended in the replayed history', async () => {
  const filePath = tempTranscript();
  const { tracker, target, published } = makeTracker(filePath);
  try {
    const at = '2026-01-01T00:00:00.000Z';
    fs.appendFileSync(filePath, `${claudeGoal({ met: false, sentinel: true, condition: 'old' }, at)}\n`);
    fs.appendFileSync(filePath, `${claudeGoal({ met: true, condition: 'old', reason: 'ok', iterations: 1 }, at)}\n`);
    await tracker.observe(target);
    assert.deepEqual(published, []);
  } finally {
    tracker.dispose();
  }
});

test('Codex: an errored or aborted turn stalls an active goal until resume', () => {
  const set = codexGoalEvent({
    objective: 'o', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1792247004, updatedAt: 1792247004,
  }, '2026-10-17T14:23:24.504Z');
  const errored = JSON.stringify({
    timestamp: '2026-10-17T14:23:25.345Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message: '400' } },
  });
  const clean = JSON.stringify({
    timestamp: '2026-10-17T14:23:25.345Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'ok' },
  });
  const aborted = JSON.stringify({
    timestamp: '2026-10-17T14:23:26.000Z',
    type: 'event_msg',
    payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' },
  });
  const resumed = codexGoalEvent({
    objective: 'o', status: 'active', tokensUsed: 0, timeUsedSeconds: 1, createdAt: 1792247004, updatedAt: 1792247030,
  }, '2026-10-17T14:23:50.000Z');

  assert.equal(fold(reduceCodexGoalTranscriptLine, [set, clean])?.status, 'active', 'a clean turn keeps going');
  assert.equal(fold(reduceCodexGoalTranscriptLine, [set, errored])?.status, 'stalled');
  assert.equal(fold(reduceCodexGoalTranscriptLine, [set, aborted])?.status, 'stalled');
  assert.equal(fold(reduceCodexGoalTranscriptLine, [set, errored, resumed])?.status, 'active');
  assert.equal(reduceCodexGoalTranscriptLine(null, errored), undefined, 'no goal, nothing to stall');
});

test('first read replays only the transcript tail, starting on a line boundary', async () => {
  const filePath = tempTranscript();
  const { tracker, target, published } = makeTracker(filePath);
  try {
    const now = new Date().toISOString();
    // A goal set before the replay window is not seen…
    fs.appendFileSync(filePath, `${claudeGoal({ met: false, sentinel: true, condition: 'old' }, now)}\n`);
    // …followed by more history than the window holds, in non-ASCII so the
    // window boundary lands inside a multi-byte character.
    const filler = `${JSON.stringify({ type: 'user', message: { content: '한글'.repeat(2000) } })}\n`;
    const fillerLines = Math.ceil(GOAL_INITIAL_REPLAY_BYTES / Buffer.byteLength(filler)) + 1;
    fs.appendFileSync(filePath, filler.repeat(fillerLines));
    fs.appendFileSync(filePath, `${claudeGoal({ met: false, sentinel: true, condition: 'recent ✨' }, now)}\n`);
    await tracker.observe(target);
    assert.equal(published.length, 1);
    assert.equal(published[0]?.objective, 'recent ✨');
  } finally {
    tracker.dispose();
  }
});

test('an evaluation inside the window revives a goal set before it', async () => {
  const filePath = tempTranscript();
  const { tracker, target, published } = makeTracker(filePath);
  try {
    const now = new Date().toISOString();
    fs.appendFileSync(filePath, `${claudeGoal({ met: false, sentinel: true, condition: 'long goal' }, now)}\n`);
    const filler = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4000) } })}\n`;
    fs.appendFileSync(filePath, filler.repeat(Math.ceil(GOAL_INITIAL_REPLAY_BYTES / filler.length) + 1));
    fs.appendFileSync(filePath, `${claudeGoal({ met: false, condition: 'long goal', reason: 'not yet' }, now)}\n`);
    await tracker.observe(target);
    assert.equal(published[0]?.objective, 'long goal');
    assert.equal(published[0]?.status, 'active');
  } finally {
    tracker.dispose();
  }
});

function claudeSystem(content: string, timestamp: string): string {
  return JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'system', subtype: 'informational', content, timestamp });
}

test('Claude: a "Goal paused" notice pauses the goal and keeps its reason', () => {
  const set = claudeGoal({ met: false, sentinel: true, condition: '뭐야' }, '2026-10-19T00:00:00.000Z');
  const notMet = claudeGoal({ met: false, condition: '뭐야', reason: 'open-ended' }, '2026-10-19T00:00:05.000Z');
  // Verbatim from a real transcript after the Stop-hook block cap (CLI 2.1.284).
  const paused = claudeSystem(
    'Goal paused · goal checks kept finding it unmet this turn · send a message to continue',
    '2026-10-19T00:01:43.000Z',
  );
  const goal = fold(reduceClaudeGoalTranscriptLine, [set, notMet, paused]);
  assert.equal(goal?.status, 'paused');
  assert.equal(goal?.lastReason, 'goal checks kept finding it unmet this turn');
  assert.equal(goal?.iterations, 1);

  // The next evaluation means Claude is pursuing it again.
  const again = claudeGoal({ met: false, condition: '뭐야', reason: 'still open' }, '2026-10-19T00:02:00.000Z');
  assert.equal(fold(reduceClaudeGoalTranscriptLine, [set, notMet, paused, again])?.status, 'active');

  // Without a goal, the notice means nothing.
  assert.equal(reduceClaudeGoalTranscriptLine(null, paused), undefined);
});

test('tracker: a Claude pause releases the deferred Stop, and a prompt resumes the goal', async () => {
  const filePath = tempTranscript();
  const { tracker, target, published } = makeTracker(filePath);
  try {
    const now = new Date().toISOString();
    fs.appendFileSync(filePath, `${claudeGoal({ met: false, sentinel: true, condition: 'c' }, now)}\n`);
    await tracker.observe(target);
    let released = 0;
    assert.equal(tracker.holdCompletion('u1', 's1', { release: () => { released += 1; } }), true);
    fs.appendFileSync(filePath, `${claudeSystem('Goal paused · a hook ended the turn · send a message to continue', now)}\n`);
    await tracker.observe(target);
    assert.equal(released, 1, 'the turn really ended');
    assert.equal(published.at(-1)?.status, 'paused');

    tracker.noteUserPrompt('u1', 's1');
    assert.equal(published.at(-1)?.status, 'active');
    // A later read with nothing new must not bring the pause back.
    await tracker.observe(target);
    assert.equal(tracker.getGoal('u1', 's1')?.status, 'active');
  } finally {
    tracker.dispose();
  }
});

function snapshot(overrides: Partial<TerminalGoalSnapshot> = {}): TerminalGoalSnapshot {
  return {
    provider: 'claude-code',
    objective: 'a',
    status: 'active',
    setAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

test('history: a goal ends once — achieved, impossible, cleared or replaced', () => {
  const live = snapshot();
  assert.equal(terminalGoalEnding(null, live), null, 'setting a goal ends nothing');
  assert.equal(terminalGoalEnding(live, { ...live, iterations: 1, updatedAt: 2_000 }), null);
  assert.equal(terminalGoalEnding(live, { ...live, status: 'paused' }), null, 'a pause is not an end');
  assert.equal(terminalGoalEnding(live, { ...live, status: 'complete' }), 'complete');
  assert.equal(terminalGoalEnding(live, { ...live, status: 'failed' }), 'failed');
  assert.equal(terminalGoalEnding(live, null), 'cleared');
  assert.equal(terminalGoalEnding({ ...live, status: 'paused' }, null), 'cleared');
  assert.equal(terminalGoalEnding(live, snapshot({ objective: 'b', setAt: 3_000 })), 'replaced');
  assert.equal(terminalGoalEnding(live, snapshot({ setAt: 3_000 })), 'replaced', 'the same text set again is a new goal');
  const achieved = { ...live, status: 'complete' as const };
  assert.equal(terminalGoalEnding(achieved, null), null, 'an achieved goal was already recorded');
  assert.equal(terminalGoalEnding(achieved, snapshot({ objective: 'b', setAt: 3_000 })), null);
});

test('history: merge deduplicates replays, keeps newest first, and caps the list', () => {
  const entry = (i: number): TerminalGoalHistoryEntry => ({
    provider: 'codex', objective: `goal ${i}`, ending: 'complete', setAt: i * 10, endedAt: i * 10 + 5,
  });
  const first = mergeTerminalGoalHistory([], [entry(1), entry(2)]);
  assert.deepEqual(first?.map((e) => e.objective), ['goal 2', 'goal 1']);
  assert.equal(mergeTerminalGoalHistory(first!, [entry(1)]), null, 'a replayed end is not recorded twice');

  const many = Array.from({ length: TERMINAL_GOAL_HISTORY_LIMIT + 3 }, (_, i) => entry(i + 1));
  const capped = mergeTerminalGoalHistory([], many)!;
  assert.equal(capped.length, TERMINAL_GOAL_HISTORY_LIMIT);
  assert.equal(capped[0]?.objective, `goal ${TERMINAL_GOAL_HISTORY_LIMIT + 3}`);
  assert.equal(mergeTerminalGoalHistory(capped, [entry(0)]), null, 'older than everything kept');

  assert.deepEqual(parseTerminalGoalHistory([entry(1), { objective: 'x' }, null, 'bad']), [entry(1)]);
  assert.deepEqual(parseTerminalGoalHistory('not a list'), []);
});

test('tracker reports ended goals with the time they ended', async () => {
  const filePath = tempTranscript();
  const recorded: TerminalGoalHistoryEntry[][] = [];
  const tracker = new TerminalGoalTracker({
    resolveTranscriptFile: async () => filePath,
    lineMarkers: () => CLAUDE_GOAL_LINE_MARKERS,
    reduceLine: (_provider, current, line) => reduceClaudeGoalTranscriptLine(current, line),
    isLive: () => true,
    publish: () => {},
    recordEndedGoals: (_target, entries) => recorded.push(entries),
  });
  const target: TerminalGoalTarget = {
    sessionId: 's1', terminalId: 'term-1', userId: 'u1', providerId: 'claude-code', providerSessionId: 'p1', transcriptPath: null,
  };
  try {
    const t0 = Date.now() - 60_000;
    const at = (offset: number) => new Date(t0 + offset).toISOString();
    fs.appendFileSync(filePath, [
      claudeGoal({ met: false, sentinel: true, condition: 'first' }, at(0)),
      claudeGoal({ met: false, condition: 'first', reason: 'not yet' }, at(1_000)),
      claudeGoal({ met: false, sentinel: true, condition: 'second' }, at(2_000)),
    ].join('\n') + '\n');
    await tracker.observe(target);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]?.map((e) => [e.objective, e.ending, e.endedAt, e.iterations]), [
      ['first', 'replaced', t0 + 2_000, 1],
    ]);

    fs.appendFileSync(filePath, `${claudeGoal({ met: true, sentinel: true, condition: 'second' }, at(5_000))}\n`);
    await tracker.observe(target);
    assert.deepEqual(recorded[1]?.map((e) => [e.objective, e.ending, e.endedAt]), [
      ['second', 'cleared', t0 + 5_000],
    ]);

    fs.appendFileSync(filePath, [
      claudeGoal({ met: false, sentinel: true, condition: 'third' }, at(6_000)),
      claudeGoal({ met: true, condition: 'third', reason: 'done', iterations: 2, durationMs: 9_000, tokens: 500 }, at(9_000)),
    ].join('\n') + '\n');
    await tracker.observe(target);
    assert.deepEqual(recorded[2]?.map((e) => [e.objective, e.ending, e.endedAt, e.iterations, e.tokensUsed, e.lastReason]), [
      ['third', 'complete', t0 + 9_000, 2, 500, 'done'],
    ]);
  } finally {
    tracker.dispose();
  }
});

test('Codex: the update_goal call completes the goal even when its output is silent', () => {
  const objective = 'Reply with only the word hi, then mark this goal complete.';
  const set = codexGoalEvent({
    objective, status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1792346040, updatedAt: 1792346040,
  }, '2026-10-18T17:54:00.644Z');
  // Codex 0.162: the model did not print the result, so the output has no goal.
  const call = (input: string) => JSON.stringify({
    timestamp: '2026-10-18T17:54:03.497Z',
    type: 'response_item',
    payload: { type: 'custom_tool_call', status: 'completed', call_id: 'c1', name: 'exec', input },
  });
  const silentOutput = JSON.stringify({
    timestamp: '2026-10-18T17:54:04.662Z',
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'Script completed\nWall time 1.1 seconds\nOutput:\n' },
  });

  const done = fold(reduceCodexGoalTranscriptLine, [set, call('await tools.update_goal({status:"complete"});\n'), silentOutput]);
  assert.equal(done?.status, 'complete');
  assert.equal(done?.updatedAt, Date.parse('2026-10-18T17:54:03.497Z'));
  assert.equal(done?.elapsedSeconds, 3, 'active from 17:54:00 (createdAt) to the call');
  assert.equal(done?.tokensUsed, undefined, 'the stale 0 from the set event is not a total');
  assert.equal(
    fold(reduceCodexGoalTranscriptLine, [set, call('text(await tools.update_goal({status:"complete"}));\n')])?.status,
    'complete',
  );
  assert.equal(
    fold(reduceCodexGoalTranscriptLine, [set, call('text(await tools.get_goal());\n')])?.status,
    'active',
    'reading the goal is not completing it',
  );

  const functionCall = JSON.stringify({
    timestamp: '2026-10-18T17:54:03.497Z',
    type: 'response_item',
    payload: { type: 'function_call', name: 'update_goal', arguments: '{"status":"complete"}', call_id: 'c2' },
  });
  assert.equal(fold(reduceCodexGoalTranscriptLine, [set, functionCall])?.status, 'complete');
  assert.equal(fold(reduceCodexGoalTranscriptLine, [call('await tools.update_goal({status:"complete"});')]), null,
    'no goal seen, nothing to complete');
});
