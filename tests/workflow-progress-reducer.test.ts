import assert from 'node:assert/strict';
import test from 'node:test';

import { serverMessageToReplayEvents } from '../src/lib/chat/server-message-to-replay-events';
import {
  createEmptySessionReplayState,
  applySessionReplayEvent,
  type SessionReplayState,
} from '../src/lib/session-replay-reducer';
import type { ServerMessage } from '../src/lib/ws/message-types';
import type { WorkflowMessage } from '../src/types/chat';

const SID = 'sess-1';
const TS = '2026-06-23T00:00:00.000Z';

function reduce(msgs: ServerMessage[]): SessionReplayState {
  let state = createEmptySessionReplayState();
  for (const msg of msgs) {
    for (const event of serverMessageToReplayEvents(msg)) {
      state = applySessionReplayEvent(SID, state, event);
    }
  }
  return state;
}

function workflowOf(state: SessionReplayState): WorkflowMessage {
  const wf = state.messages.find((m) => m.type === 'workflow');
  assert.ok(wf && wf.type === 'workflow', 'expected a workflow message');
  return wf;
}

// Mirrors the real Claude Code stream: task_started → task_progress (DELTA
// batches) → task_notification. Deltas must accumulate by index into one card.
test('accumulates delta progress into a single workflow card', () => {
  const state = reduce([
    {
      type: 'workflow_event', sessionId: SID, kind: 'started', taskId: 'wf1',
      toolUseId: 'toolu_1', workflowName: 'probe', description: 'probe run', timestamp: TS,
    },
    {
      type: 'workflow_event', sessionId: SID, kind: 'progress', taskId: 'wf1', timestamp: TS,
      progress: [
        { type: 'workflow_phase', index: 1, title: 'Answer' },
        { type: 'workflow_agent', index: 1, label: 'a1', phaseIndex: 1, state: 'start' },
        { type: 'workflow_agent', index: 1, label: 'a1', phaseIndex: 1, state: 'start', agentId: 'aaa1111' },
      ],
    },
    {
      type: 'workflow_event', sessionId: SID, kind: 'progress', taskId: 'wf1', timestamp: TS,
      usage: { totalTokens: 6928, toolUses: 0, durationMs: 1370 },
      progress: [
        { type: 'workflow_agent', index: 1, label: 'a1', state: 'done', agentId: 'aaa1111', tokens: 6928, durationMs: 1370, resultPreview: 'alpha' },
        { type: 'workflow_agent', index: 2, label: 'a2', phaseIndex: 1, state: 'start', agentId: 'bbb2222' },
      ],
    },
    {
      type: 'workflow_event', sessionId: SID, kind: 'progress', taskId: 'wf1', timestamp: TS,
      progress: [{ type: 'workflow_log', message: '2/2 found' } as any],
    },
    {
      type: 'workflow_event', sessionId: SID, kind: 'notification', taskId: 'wf1', timestamp: TS,
      status: 'completed', outputFile: '/tmp/out.txt',
      usage: { totalTokens: 13855, toolUses: 0, durationMs: 5548 },
    },
  ]);

  // Exactly one card despite many events.
  assert.equal(state.messages.filter((m) => m.type === 'workflow').length, 1);

  const wf = workflowOf(state);
  assert.equal(wf.id, 'hist-workflow-wf1');
  assert.equal(wf.workflowName, 'probe');
  assert.equal(wf.status, 'completed');
  assert.equal(wf.outputFile, '/tmp/out.txt');
  assert.equal(wf.usage?.totalTokens, 13855);
  assert.equal(wf.phases.length, 1);
  assert.equal(wf.agents.length, 2, 'agent index dedup keeps two agents');

  // a1 fully merged across its start → done deltas.
  const a1 = wf.agents.find((a) => a.index === 1)!;
  assert.equal(a1.state, 'done');
  assert.equal(a1.agentId, 'aaa1111', 'agentId from an earlier delta is retained');
  assert.equal(a1.resultPreview, 'alpha');
  assert.equal(a1.tokens, 6928);

  // a2 still mid-flight.
  const a2 = wf.agents.find((a) => a.index === 2)!;
  assert.equal(a2.state, 'start');

  assert.deepEqual(wf.logs, ['2/2 found']);
  // rev bumps once per applied event (1 started + 3 progress + 1 notification).
  assert.equal(wf.rev, 5);
});

test('updated patch with failed status marks the card failed', () => {
  const state = reduce([
    { type: 'workflow_event', sessionId: SID, kind: 'started', taskId: 'wf2', workflowName: 'x', timestamp: TS },
    { type: 'workflow_event', sessionId: SID, kind: 'updated', taskId: 'wf2', status: 'failed', endTime: 1782186940694, timestamp: TS },
  ]);
  const wf = workflowOf(state);
  assert.equal(wf.status, 'failed');
  assert.ok(wf.endedAt, 'endedAt set from patch end_time');
});

test('terminal/update events for an unknown task are ignored', () => {
  const state = reduce([
    { type: 'workflow_event', sessionId: SID, kind: 'notification', taskId: 'ghost', status: 'completed', timestamp: TS },
    { type: 'workflow_event', sessionId: SID, kind: 'updated', taskId: 'ghost', status: 'failed', timestamp: TS },
  ]);
  assert.equal(state.messages.length, 0, 'no card created for an unstarted run');
});
