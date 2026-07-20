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

test('a long-lived background shell task does not keep the turn spinning after Stop', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-with-dev-server';

  tracker.apply(terminalId, 'UserPromptSubmit', {});
  // dev 서버·워처 같은 셸 작업은 턴이 끝나도 계속 살아있다 — 스피너를 잡으면 안 된다.
  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [{ id: 'bash-dev-server', type: 'local_shell', status: 'running' }],
    session_crons: [],
  }), { status: 'completed' });
});

test('pending session crons do not keep the turn spinning after Stop', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-with-cron';

  tracker.apply(terminalId, 'UserPromptSubmit', {});
  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [],
    session_crons: [{ id: 'cron-1', schedule: '*/5 * * * *' }],
  }), { status: 'completed' });
});

test('a subagent can drain the turn while a background shell task stays alive', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-subagent-plus-shell';

  tracker.apply(terminalId, 'SubagentStart', { agent_id: 'agent-a' });
  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [
      { id: 'agent-a', type: 'subagent', status: 'running' },
      { id: 'bash-dev-server', type: 'local_shell', status: 'running' },
    ],
  }), { status: 'running' });

  // 셸 작업이 남아있어도 에이전트 작업이 빠지면 턴은 완료돼야 한다.
  assert.deepEqual(tracker.apply(terminalId, 'SubagentStop', {
    agent_id: 'agent-a',
    background_tasks: [{ id: 'bash-dev-server', type: 'local_shell', status: 'running' }],
  }), { status: 'completed' });
});

test('late subagent events after a clean Stop cannot resurrect the turn', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-with-post-turn-worker';

  tracker.apply(terminalId, 'UserPromptSubmit', {});
  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [],
    session_crons: [],
  }), { status: 'completed' });

  // 턴 종료 후 도착하는 후처리 워커(요약 생성 등)의 이벤트는 상태를 승격하면 안 된다.
  assert.equal(tracker.apply(terminalId, 'SubagentStart', { agent_id: 'recap-worker' }), null);
  assert.equal(tracker.apply(terminalId, 'SubagentStop', {
    agent_id: 'recap-worker',
    background_tasks: [],
  }), null);
});

test('a stray SubagentStop for an unknown terminal does not start a turn', () => {
  const tracker = new ClaudeHookLifecycleTracker();

  assert.equal(tracker.apply('never-seen-terminal', 'SubagentStop', {
    agent_id: 'ghost',
    background_tasks: [],
  }), null);
});

test('UserPromptSubmit reopens a turn that was closed by a clean Stop', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-reopened';

  tracker.apply(terminalId, 'UserPromptSubmit', {});
  tracker.apply(terminalId, 'Stop', { background_tasks: [], session_crons: [] });

  assert.deepEqual(tracker.apply(terminalId, 'UserPromptSubmit', {}), { status: 'running' });
  assert.deepEqual(tracker.apply(terminalId, 'SubagentStart', {
    agent_id: 'agent-next-turn',
  }), { status: 'running' });
  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [{ id: 'agent-next-turn', type: 'subagent', status: 'running' }],
  }), { status: 'running' });
  assert.deepEqual(tracker.apply(terminalId, 'SubagentStop', {
    agent_id: 'agent-next-turn',
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
