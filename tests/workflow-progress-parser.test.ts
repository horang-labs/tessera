import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeCodeProtocolParser } from '../src/lib/cli/providers/claude-code/protocol-parser';

type WorkflowEvent = {
  type: 'workflow_event';
  kind: string;
  taskId: string;
  [k: string]: unknown;
};

function workflowEvents(sessionId: string, line: object): WorkflowEvent[] {
  const parsed = claudeCodeProtocolParser.parseStdout(sessionId, JSON.stringify(line));
  return parsed
    .map((p) => p.serverMessage)
    .filter((m): m is WorkflowEvent => !!m && (m as any).type === 'workflow_event') as WorkflowEvent[];
}

test('local_workflow task_started emits a started workflow_event', () => {
  const sid = 'p1';
  const events = workflowEvents(sid, {
    type: 'system', subtype: 'task_started', task_id: 'wf1', tool_use_id: 'toolu_1',
    task_type: 'local_workflow', workflow_name: 'probe', description: 'd',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'started');
  assert.equal(events[0].taskId, 'wf1');
  assert.equal(events[0].workflowName, 'probe');
});

test('non-workflow background task_started is dropped', () => {
  const sid = 'p2';
  const events = workflowEvents(sid, {
    type: 'system', subtype: 'task_started', task_id: 'bg1',
    task_type: 'local_agent', description: 'a subagent',
  });
  assert.equal(events.length, 0);
});

test('progress + notification only flow for a tracked workflow run', () => {
  const sid = 'p3';
  // Start the workflow so its task id is tracked.
  workflowEvents(sid, {
    type: 'system', subtype: 'task_started', task_id: 'wf1',
    task_type: 'local_workflow', workflow_name: 'probe',
  });

  const progress = workflowEvents(sid, {
    type: 'system', subtype: 'task_progress', task_id: 'wf1',
    usage: { total_tokens: 100, tool_uses: 0, duration_ms: 50 },
    workflow_progress: [
      { type: 'workflow_phase', index: 1, title: 'Answer' },
      { type: 'workflow_agent', index: 1, label: 'a1', state: 'start' },
    ],
  });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].kind, 'progress');
  assert.deepEqual((progress[0].usage as any), { totalTokens: 100, toolUses: 0, durationMs: 50 });
  assert.equal((progress[0].progress as unknown[]).length, 2);

  const notif = workflowEvents(sid, {
    type: 'system', subtype: 'task_notification', task_id: 'wf1',
    status: 'completed', output_file: '/tmp/o.txt',
  });
  assert.equal(notif.length, 1);
  assert.equal(notif[0].kind, 'notification');
  assert.equal(notif[0].outputFile, '/tmp/o.txt');
});

test('notification for an untracked (non-workflow) task is dropped', () => {
  const sid = 'p4';
  const events = workflowEvents(sid, {
    type: 'system', subtype: 'task_notification', task_id: 'bg-unknown',
    status: 'completed', output_file: '/tmp/x',
  });
  assert.equal(events.length, 0);
});

test('task_progress carrying workflow_progress is recognized even without a seen task_started', () => {
  const sid = 'p5';
  const events = workflowEvents(sid, {
    type: 'system', subtype: 'task_progress', task_id: 'wf-mid',
    workflow_progress: [{ type: 'workflow_agent', index: 1, label: 'a1', state: 'done', resultPreview: 'ok' }],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'progress');
});
