import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { useChatStore } from '../src/stores/chat-store';
import type { WorkflowMessage } from '../src/types/chat';

const SID = 'sess-wf';

function makeWorkflow(overrides: Partial<WorkflowMessage> = {}): WorkflowMessage {
  const taskId = overrides.taskId ?? 'wf1';
  return {
    id: `hist-workflow-${taskId}`,
    type: 'workflow',
    sessionId: SID,
    taskId,
    workflowName: 'probe',
    status: 'running',
    phases: [],
    agents: [],
    logs: [],
    startedAt: '2026-06-23T00:00:00.000Z',
    timestamp: '2026-06-23T00:00:00.000Z',
    rev: 3,
    ...overrides,
  };
}

function seed(messages: WorkflowMessage[]): void {
  useChatStore.setState({
    messages: new Map([[SID, messages]]),
    dismissedWorkflowTaskIds: new Set(),
  });
}

beforeEach(() => {
  useChatStore.setState({ messages: new Map(), dismissedWorkflowTaskIds: new Set() });
});

test('settleRunningWorkflows marks running cards failed and stamps endedAt', () => {
  seed([makeWorkflow()]);
  useChatStore.getState().settleRunningWorkflows(SID, 'failed');

  const card = useChatStore.getState().messages.get(SID)![0] as WorkflowMessage;
  assert.equal(card.status, 'failed');
  assert.ok(card.endedAt, 'endedAt should be stamped when the run is force-settled');
  assert.equal(card.rev, 4, 'rev must bump so the memoized card re-renders');
});

test('settleRunningWorkflows leaves already-finished cards untouched (no-op keeps refs)', () => {
  const finished = makeWorkflow({
    status: 'completed',
    endedAt: '2026-06-23T01:00:00.000Z',
    rev: 5,
  });
  seed([finished]);

  const before = useChatStore.getState().messages;
  useChatStore.getState().settleRunningWorkflows(SID, 'failed');
  const after = useChatStore.getState().messages;

  const card = after.get(SID)![0] as WorkflowMessage;
  assert.equal(card.status, 'completed');
  assert.equal(card.endedAt, '2026-06-23T01:00:00.000Z');
  assert.equal(card.rev, 5);
  assert.equal(before, after, 'a no-op settle must not replace the messages map');
});

test('settleRunningWorkflows preserves an existing endedAt on a running card', () => {
  seed([makeWorkflow({ endedAt: '2026-06-23T00:30:00.000Z' })]);
  useChatStore.getState().settleRunningWorkflows(SID, 'failed');

  const card = useChatStore.getState().messages.get(SID)![0] as WorkflowMessage;
  assert.equal(card.status, 'failed');
  assert.equal(card.endedAt, '2026-06-23T00:30:00.000Z', 'existing endedAt should be kept');
});

test('settleRunningWorkflows only touches running workflow cards, not siblings', () => {
  seed([
    makeWorkflow({ taskId: 'wf-run', status: 'running' }),
    makeWorkflow({ taskId: 'wf-done', status: 'completed', rev: 9 }),
  ]);
  useChatStore.getState().settleRunningWorkflows(SID, 'failed');

  const cards = useChatStore.getState().messages.get(SID)! as WorkflowMessage[];
  assert.equal(cards.find((c) => c.taskId === 'wf-run')!.status, 'failed');
  assert.equal(cards.find((c) => c.taskId === 'wf-done')!.status, 'completed');
  assert.equal(cards.find((c) => c.taskId === 'wf-done')!.rev, 9, 'finished sibling is untouched');
});

test('dismissWorkflowCard records the task id and is idempotent', () => {
  const store = useChatStore.getState();
  assert.equal(store.dismissedWorkflowTaskIds.has('wf1'), false);

  store.dismissWorkflowCard('wf1');
  assert.equal(useChatStore.getState().dismissedWorkflowTaskIds.has('wf1'), true);

  const first = useChatStore.getState().dismissedWorkflowTaskIds;
  useChatStore.getState().dismissWorkflowCard('wf1');
  const second = useChatStore.getState().dismissedWorkflowTaskIds;
  assert.equal(first, second, 'dismissing the same card twice must be a no-op');
});
