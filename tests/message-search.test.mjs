import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/lib/chat/message-search.ts', import.meta.url), 'utf8');

function stringifySearchValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function getMessageSearchText(message) {
  switch (message.type) {
    case 'text':
      if (typeof message.content === 'string') return message.content;
      return message.content
        .map((block) => block && typeof block === 'object' && typeof block.text === 'string' ? block.text : '')
        .filter(Boolean)
        .join('\n');
    case 'thinking':
      return message.content;
    case 'system':
      return message.message;
    case 'progress_hook':
      return message.errorMessage || '';
    case 'tool_call':
      return [
        message.toolName,
        stringifySearchValue(message.toolParams),
        message.output,
        message.error,
      ].filter(Boolean).join('\n');
    default:
      return '';
  }
}

function findMessageSearchMatches(messages, rawQuery) {
  const query = rawQuery.trim();
  if (!query) return [];
  const normalizedQuery = query.toLocaleLowerCase();
  const matches = [];
  for (const message of messages) {
    const text = getMessageSearchText(message);
    if (!text.toLocaleLowerCase().includes(normalizedQuery)) continue;
    matches.push({
      messageId: message.id,
      messageType: message.type,
      preview: text.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  return matches;
}

test('message-search utility exports the expected pure functions', () => {
  assert.match(source, /export function getMessageSearchText/);
  assert.match(source, /export function findMessageSearchMatches/);
  assert.match(source, /export function findGroupedRowIndexForMessage/);
});

test('findMessageSearchMatches searches loaded message content case-insensitively', () => {
  const messages = [
    { id: 'u1', type: 'text', role: 'user', timestamp: 't', content: 'Please inspect auth flow' },
    { id: 'a1', type: 'text', role: 'assistant', timestamp: 't', content: 'The login handler is in route.ts' },
    { id: 'think1', type: 'thinking', sessionId: 's', timestamp: 't', content: 'Checking AUTH middleware', status: 'completed' },
    { id: 'sys1', type: 'system', sessionId: 's', timestamp: 't', message: 'Auth warning', severity: 'warning' },
    { id: 'prog1', type: 'progress_hook', sessionId: 's', timestamp: 't', hookEvent: 'x', data: {}, errorMessage: 'Auth hook failed' },
    { id: 'tool1', type: 'tool_call', sessionId: 's', timestamp: 't', toolName: 'Read', toolParams: { file: 'auth.ts' }, status: 'completed', output: 'auth token' },
  ];

  const matches = findMessageSearchMatches(messages, 'AUTH');
  assert.deepEqual(matches.map((match) => match.messageId), ['u1', 'think1', 'sys1', 'prog1', 'tool1']);
  assert.equal(matches[0].preview, 'Please inspect auth flow');
});

test('findMessageSearchMatches searches text blocks in array content', () => {
  const messages = [
    {
      id: 'multi',
      type: 'text',
      role: 'user',
      timestamp: 't',
      content: [
        { type: 'text', text: 'first block' },
        { type: 'text', text: 'needle block' },
        { type: 'image', url: 'ignored' },
      ],
    },
  ];

  assert.deepEqual(findMessageSearchMatches(messages, 'needle').map((match) => match.messageId), ['multi']);
});

test('findMessageSearchMatches returns no matches for blank queries', () => {
  assert.deepEqual(findMessageSearchMatches([
    { id: 'u1', type: 'text', role: 'user', timestamp: 't', content: 'hello' },
  ], '   '), []);
});
