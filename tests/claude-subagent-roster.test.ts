import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type SubagentRoster,
  upsertWorkingSubagent,
  markSubagentIdle,
  markTeammateIdleByName,
  rosterHasWorkingSubagent,
  readBackgroundAgentTasks,
  foldBackgroundTasksIntoRoster,
  teammateIdMatchesName,
} from '@/lib/cli/providers/claude-code/claude-subagent-roster';

function roster(): SubagentRoster {
  return new Map();
}

test('upsert/markIdle drive rosterHasWorkingSubagent', () => {
  const r = roster();
  assert.equal(rosterHasWorkingSubagent(r), false);
  upsertWorkingSubagent(r, 'a');
  assert.equal(rosterHasWorkingSubagent(r), true);
  markSubagentIdle(r, 'a');
  assert.equal(rosterHasWorkingSubagent(r), false);
});

test('upsert rejects empty and over-long ids', () => {
  const r = roster();
  upsertWorkingSubagent(r, '');
  upsertWorkingSubagent(r, 'x'.repeat(65));
  assert.equal(r.size, 0);
});

test('readBackgroundAgentTasks marks absent field as not present', () => {
  assert.deepEqual(readBackgroundAgentTasks({}), { present: false, tasks: [] });
  assert.deepEqual(readBackgroundAgentTasks({ background_tasks: 'oops' }), { present: false, tasks: [] });
});

test('readBackgroundAgentTasks keeps only subagent/teammate entries', () => {
  const result = readBackgroundAgentTasks({
    background_tasks: [
      { id: 'a', type: 'subagent', status: 'running' },
      { id: 'shell', type: 'local_shell', status: 'running' },
      { id: 't', type: 'teammate', status: 'running' },
      { id: '', type: 'subagent', status: 'running' },
      { type: 'subagent', status: 'running' },
      null,
    ],
  });
  assert.equal(result.present, true);
  assert.deepEqual(result.tasks, [
    { id: 'a', running: true, teammate: false },
    { id: 't', running: true, teammate: true },
  ]);
});

test('readBackgroundAgentTasks reads non-running status as not running', () => {
  const result = readBackgroundAgentTasks({
    background_tasks: [{ id: 'a', type: 'subagent', status: 'completed' }],
  });
  assert.deepEqual(result.tasks, [{ id: 'a', running: false, teammate: false }]);
});

test('fold with empty list clears the roster', () => {
  const r = roster();
  upsertWorkingSubagent(r, 'a');
  foldBackgroundTasksIntoRoster(r, []);
  assert.equal(r.size, 0);
});

test('fold reflects an id-exact run state onto a tracked child', () => {
  const r = roster();
  upsertWorkingSubagent(r, 'a');
  foldBackgroundTasksIntoRoster(r, [{ id: 'a', running: false, teammate: false }]);
  assert.equal(rosterHasWorkingSubagent(r), false);
});

test('fold recreates an unobserved running subagent as authoritative', () => {
  const r = roster();
  foldBackgroundTasksIntoRoster(r, [{ id: 'x', running: true, teammate: false }]);
  assert.equal(rosterHasWorkingSubagent(r), true);
  // authoritative이므로 다음 fold에서 리스트에 빠지면 idle로 강등된다.
  foldBackgroundTasksIntoRoster(r, [{ id: 'other', running: true, teammate: false }]);
  assert.equal(r.get('x')?.state, 'idle');
});

test('fold does not create teammate entries, nor non-running ones', () => {
  const r = roster();
  foldBackgroundTasksIntoRoster(r, [
    { id: 'team', running: true, teammate: true },
    { id: 'done-oneshot', running: false, teammate: false },
  ]);
  assert.equal(r.has('team'), false);
  assert.equal(r.has('done-oneshot'), false);
});

test('fold does not demote a lifecycle-tracked child absent from the list', () => {
  const r = roster();
  upsertWorkingSubagent(r, 'lifecycle-child'); // not authoritative
  foldBackgroundTasksIntoRoster(r, [{ id: 'other', running: true, teammate: false }]);
  // teammate ids never appear in background_tasks — absence must not demote them.
  assert.equal(r.get('lifecycle-child')?.state, 'working');
});

test('teammateIdMatchesName distinguishes rev from rev-two', () => {
  assert.equal(teammateIdMatchesName('arev-123', 'rev'), true);
  assert.equal(teammateIdMatchesName('arev-two-123', 'rev'), false);
  assert.equal(teammateIdMatchesName('arev-two-123', 'rev-two'), true);
  assert.equal(teammateIdMatchesName('agent-a', 'rev'), false);
});

test('markTeammateIdleByName idles matching teammate ids only', () => {
  const r = roster();
  upsertWorkingSubagent(r, 'arev-123');
  upsertWorkingSubagent(r, 'aother-456');
  markTeammateIdleByName(r, 'rev');
  assert.equal(r.get('arev-123')?.state, 'idle');
  assert.equal(r.get('aother-456')?.state, 'working');
});
