import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeHookLifecycleTracker } from '@/lib/cli/providers/claude-code/terminal-hook-lifecycle';

test('Claude turn stays running until a background subagent drains after lead Stop', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-a';

  assert.deepEqual(tracker.apply(terminalId, 'SubagentStart', {
    agent_id: 'agent-a',
  }), { status: 'running' });

  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [{ id: 'agent-a', type: 'subagent', status: 'running' }],
    session_crons: [],
  }), { status: 'running' });

  assert.deepEqual(tracker.apply(terminalId, 'SubagentStop', {
    agent_id: 'agent-a',
    background_tasks: [],
    session_crons: [],
  }), { status: 'completed' });
});

test('one child stopping cannot complete the turn while another tracked child remains', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-with-two-children';

  tracker.apply(terminalId, 'SubagentStart', { agent_id: 'agent-a' });
  tracker.apply(terminalId, 'SubagentStart', { agent_id: 'agent-b' });
  tracker.apply(terminalId, 'Stop', {
    background_tasks: [
      { id: 'agent-a', type: 'subagent', status: 'running' },
      { id: 'agent-b', type: 'subagent', status: 'running' },
    ],
  });

  assert.deepEqual(tracker.apply(terminalId, 'SubagentStop', {
    agent_id: 'agent-a',
    background_tasks: [],
  }), { status: 'running' });
  assert.deepEqual(tracker.apply(terminalId, 'SubagentStop', {
    agent_id: 'agent-b',
    background_tasks: [],
  }), { status: 'completed' });
});

test('a late TeammateIdle cannot move an already completed turn back to running', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'completed-terminal';

  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [],
    session_crons: [],
  }), { status: 'completed' });
  assert.equal(tracker.apply(terminalId, 'TeammateIdle', {
    teammate_name: 'researcher',
  }), null);
});

test('an idle-but-alive teammate stays running until its SubagentStop drains the turn', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-with-teammate';

  tracker.apply(terminalId, 'SubagentStart', {
    agent_id: 'aresearcher-123',
    agent_type: 'researcher',
  });
  tracker.apply(terminalId, 'Stop', {
    background_tasks: [{ id: 'team-task', type: 'teammate', status: 'running' }],
  });

  assert.deepEqual(tracker.apply(terminalId, 'TeammateIdle', {
    teammate_name: 'researcher',
  }), { status: 'running' });
  assert.deepEqual(tracker.apply(terminalId, 'SubagentStop', {
    agent_id: 'aresearcher-123',
    background_tasks: [],
  }), { status: 'completed' });
});

test('a later authoritative Stop can drain an idle teammate without SubagentStop', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-with-later-stop';

  tracker.apply(terminalId, 'SubagentStart', { agent_id: 'agent-a' });
  tracker.apply(terminalId, 'Stop', {
    background_tasks: [{ id: 'team-task', type: 'teammate', status: 'running' }],
    session_crons: [],
  });
  tracker.apply(terminalId, 'TeammateIdle', { teammate_name: 'researcher' });

  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [],
    session_crons: [],
  }), { status: 'completed' });
});
