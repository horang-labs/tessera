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

// ─── reconcile: Stop의 background_tasks 스냅샷으로 명단을 self-heal ───

test('a lost SubagentStop is healed by the Stop payload marking the child done', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-lost-subagentstop';

  tracker.apply(terminalId, 'UserPromptSubmit', {});
  tracker.apply(terminalId, 'SubagentStart', { agent_id: 'agent-a' });
  // SubagentStop이 유실됐지만, Stop payload가 agent-a를 running이 아닌 상태로 보고하면
  // reconcile이 그 child를 idle로 강등해 턴을 완료시킨다.
  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [{ id: 'agent-a', type: 'subagent', status: 'completed' }],
  }), { status: 'completed' });
});

test('a running subagent never observed via SubagentStart is recreated from the Stop payload', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-restart-midrun';

  tracker.apply(terminalId, 'UserPromptSubmit', {});
  // SubagentStart를 놓쳤어도(서버/relay 재시작) Stop의 background_tasks에 running으로
  // 있으면 명단에 재생성해 pane이 child 살아있는데 done으로 읽지 않게 한다.
  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [{ id: 'agent-x', type: 'subagent', status: 'running' }],
  }), { status: 'running' });
  // 그 child가 다음 Stop에서 리스트에 없으면(끝남) 완료로 강등된다.
  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [],
  }), { status: 'completed' });
});

// ─── 재기동 턴: 백그라운드 작업 완료로 Claude가 자동으로 깨어난 턴의 감지 ───

test('a PreToolUse after the revive grace reopens a completed turn as running', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-revived-by-build';
  const t0 = 1_000_000;

  tracker.apply(terminalId, 'UserPromptSubmit', {}, t0);
  // 백그라운드 빌드를 남긴 채 턴 종료 — 셸 작업은 스피너를 잡지 않는다(의도).
  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [{ id: 'bash-build', type: 'local_shell', status: 'running' }],
  }, t0 + 1_000), { status: 'completed' });

  // 빌드가 끝나 Claude가 깨어나 결과를 확인한다 — UserPromptSubmit 없이 도구부터 쓴다.
  assert.deepEqual(tracker.apply(terminalId, 'PreToolUse', {
    tool_name: 'Bash',
  }, t0 + 60_000), { status: 'running' });

  assert.deepEqual(tracker.apply(terminalId, 'Stop', {
    background_tasks: [],
  }, t0 + 65_000), { status: 'completed' });
});

test('a PreToolUse inside the revive grace is treated as a late curl and ignored', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-late-pretooluse';
  const t0 = 2_000_000;

  tracker.apply(terminalId, 'UserPromptSubmit', {}, t0);
  tracker.apply(terminalId, 'Stop', { background_tasks: [] }, t0 + 1_000);

  // 턴 마지막 도구의 PreToolUse curl이 Stop보다 늦게 배달된 역전 — 턴을 되살리면 안 된다.
  assert.equal(tracker.apply(terminalId, 'PreToolUse', {
    tool_name: 'Read',
  }, t0 + 2_000), null);
});

test('a late PostToolUse never reopens a completed turn regardless of delay', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-late-posttooluse';
  const t0 = 3_000_000;

  tracker.apply(terminalId, 'UserPromptSubmit', {}, t0);
  tracker.apply(terminalId, 'Stop', { background_tasks: [] }, t0 + 1_000);

  assert.equal(tracker.apply(terminalId, 'PostToolUse', {
    tool_name: 'Bash',
  }, t0 + 60_000), null);
});

test('tool events during a live turn keep it running and refresh subagent liveness', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-tool-activity';

  tracker.apply(terminalId, 'UserPromptSubmit', {});
  assert.deepEqual(tracker.apply(terminalId, 'PreToolUse', { tool_name: 'Bash' }),
    { status: 'running' });
  assert.deepEqual(tracker.apply(terminalId, 'PostToolUse', { tool_name: 'Bash' }),
    { status: 'running' });

  // subagent 발 도구 이벤트는 그 child가 살아있다는 증거 — SubagentStart가 유실됐어도
  // 명단에 올라 Stop의 done 게이트가 그 child를 기다리게 된다.
  tracker.apply(terminalId, 'PreToolUse', { tool_name: 'Grep', agent_id: 'agent-live' });
  assert.deepEqual(tracker.apply(terminalId, 'Stop', {}), { status: 'running' });
  assert.deepEqual(tracker.apply(terminalId, 'SubagentStop', {
    agent_id: 'agent-live',
    background_tasks: [],
  }), { status: 'completed' });
});

// ─── StopFailure: 에러로 끝난 턴도 Stop처럼 닫는다 ───

test('StopFailure closes a turn with no live children just like Stop', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-stopfailure';

  tracker.apply(terminalId, 'UserPromptSubmit', {});
  assert.deepEqual(tracker.apply(terminalId, 'StopFailure', {
    background_tasks: [],
  }), { status: 'completed' });
});

test('StopFailure keeps the turn running while a child is still working', () => {
  const tracker = new ClaudeHookLifecycleTracker();
  const terminalId = 'terminal-stopfailure-with-child';

  tracker.apply(terminalId, 'UserPromptSubmit', {});
  tracker.apply(terminalId, 'SubagentStart', { agent_id: 'agent-a' });
  assert.deepEqual(tracker.apply(terminalId, 'StopFailure', {
    background_tasks: [{ id: 'agent-a', type: 'subagent', status: 'running' }],
  }), { status: 'running' });
  assert.deepEqual(tracker.apply(terminalId, 'SubagentStop', {
    agent_id: 'agent-a',
    background_tasks: [],
  }), { status: 'completed' });
});
