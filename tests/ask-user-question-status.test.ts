import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAskUserQuestionEvent } from '@/lib/cli/providers/claude-code/ask-user-question-status';

test('PreToolUse for AskUserQuestion maps to input_required with the question preview', () => {
  assert.deepEqual(
    classifyAskUserQuestionEvent('PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{ question: '어느 방식으로 할까요?', header: '방식', options: [] }],
      },
    }),
    { status: 'input_required', preview: '어느 방식으로 할까요?' },
  );
});

test('PreToolUse without a readable question still maps to input_required', () => {
  assert.deepEqual(
    classifyAskUserQuestionEvent('PreToolUse', { tool_name: 'AskUserQuestion' }),
    { status: 'input_required', preview: undefined },
  );
});

test('PostToolUse for AskUserQuestion resumes running', () => {
  assert.deepEqual(
    classifyAskUserQuestionEvent('PostToolUse', {
      tool_name: 'AskUserQuestion',
      tool_response: {},
    }),
    { status: 'running' },
  );
});

test('other tools and events are ignored even if a broad matcher forwards them', () => {
  assert.equal(classifyAskUserQuestionEvent('PreToolUse', { tool_name: 'Bash' }), null);
  assert.equal(classifyAskUserQuestionEvent('PostToolUse', { tool_name: 'Edit' }), null);
  assert.equal(classifyAskUserQuestionEvent('Stop', { tool_name: 'AskUserQuestion' }), null);
  assert.equal(classifyAskUserQuestionEvent('PreToolUse', {}), null);
});
