import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionHistoryEvent } from '@/lib/session-replay-types';
import { selectProviderResumeHistorySuffix } from '@/lib/session/provider-resume-history';

const user = (content: string, timestamp: string): SessionHistoryEvent => ({
  v: 1,
  type: 'user_message',
  timestamp,
  content,
});

const assistant = (content: string, timestamp: string): SessionHistoryEvent => ({
  v: 1,
  type: 'assistant_message',
  timestamp,
  content,
});

test('provider resume history appends only turns added outside Tessera', () => {
  const canonical = [
    user('inside question', '2026-08-12T00:00:00.000Z'),
    assistant('inside answer', '2026-08-12T00:00:01.000Z'),
  ];
  const external = [
    user('outside follow-up', '2026-08-12T00:01:00.000Z'),
    {
      v: 1,
      type: 'tool_call' as const,
      timestamp: '2026-08-12T00:01:01.000Z',
      toolName: 'Bash',
      toolParams: { command: 'pwd' },
      status: 'completed' as const,
      output: '/workspace',
      toolUseId: 'external-call',
    },
  ];

  assert.deepEqual(
    selectProviderResumeHistorySuffix(canonical, [...canonical, ...external]),
    external,
  );
  assert.deepEqual(
    selectProviderResumeHistorySuffix([...canonical, ...external], [...canonical, ...external]),
    [],
    'a second resume must not duplicate the imported suffix',
  );
});

test('provider resume history refuses to merge a different conversation', () => {
  assert.equal(
    selectProviderResumeHistorySuffix(
      [user('managed conversation', '2026-08-12T00:00:00.000Z')],
      [user('unrelated provider history', '2026-08-12T00:00:00.000Z')],
    ),
    null,
  );
});

test('provider resume history compares provider-facing translations and stable tool identity', () => {
  const canonical: SessionHistoryEvent[] = [
    {
      ...user('작업 폴더를 알려줘', '2026-08-12T00:00:00.000Z'),
      messageId: 'translated-input',
    },
    {
      v: 1,
      type: 'message_translation',
      timestamp: '2026-08-12T00:00:00.100Z',
      targetMessageId: 'translated-input',
      content: 'Tell me the working directory',
      sourceLang: 'ko',
      targetLang: 'en',
      status: 'completed',
    },
    {
      v: 1,
      type: 'tool_call',
      timestamp: '2026-08-12T00:00:01.000Z',
      toolName: 'Bash',
      toolParams: {
        command: 'pwd',
        cwd: '/workspace',
        commandActions: [{ type: 'read', command: 'pwd' }],
        processId: 'live-process-42',
      },
      status: 'completed',
      output: '/workspace\nProcess exited with code 0',
      toolUseId: 'call-42',
    },
  ];
  const provider: SessionHistoryEvent[] = [
    user('Tell me the working directory', '2026-08-12T00:00:00.000Z'),
    {
      v: 1,
      type: 'tool_call',
      timestamp: '2026-08-12T00:00:01.000Z',
      toolName: 'Bash',
      toolParams: { cwd: '/workspace', command: 'pwd' },
      status: 'completed',
      output: '/workspace',
      toolUseId: 'call-42',
    },
    assistant('The working directory is /workspace.', '2026-08-12T00:00:02.000Z'),
  ];

  assert.deepEqual(
    selectProviderResumeHistorySuffix(canonical, provider),
    [provider[2]],
    'display translations and live-only tool metadata must not hide an external suffix',
  );
});
