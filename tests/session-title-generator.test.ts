import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSessionTitle } from '@/lib/session/title-generator';

test('creates a concise action title from the first request without an LLM', () => {
  assert.equal(
    generateSessionTitle('Can you please refactor the auth middleware to use JWT tokens?'),
    'Refactor the auth middleware to use JWT',
  );
});

test('keeps Unicode text while removing prompt filler and trailing punctuation', () => {
  assert.equal(
    generateSessionTitle('Please fix the 한국어 검색 결과 정렬 문제!!!'),
    'Fix the 한국어 검색 결과 정렬 문제',
  );
});

test('uses only the first clause and removes markdown and URLs', () => {
  assert.equal(
    generateSessionTitle('Please fix **authentication** at https://example.com/auth; then add tests'),
    'Fix authentication',
  );
});

test('limits generated titles to 40 code points at a word boundary', () => {
  const title = generateSessionTitle(
    'Implement a deterministic session title generator that works without any model calls',
  );

  assert.equal(title, 'Implement a deterministic session title');
  assert.ok(Array.from(title).length <= 40);
});

test('keeps the existing bang-command shortcut behavior', () => {
  assert.equal(generateSessionTitle('!git status'), 'git');
});

test('preserves generic type contents and identifier underscores', () => {
  assert.equal(
    generateSessionTitle('Please fix user_id and Map<string, User>'),
    'Fix user_id and Map string User',
  );
});

test('scans only the bounded prefix of a very large prompt', () => {
  assert.equal(
    generateSessionTitle(`Fix the title generator now ${'ignored '.repeat(100_000)}`),
    'Fix the title generator now ignored',
  );
});

test('stops at full-width sentence punctuation', () => {
  assert.equal(generateSessionTitle('修正第一项。然后处理第二项'), '修正第一项');
  assert.equal(generateSessionTitle('첫 번째 문제 수정！다음 문제도 수정'), '첫 번째 문제 수정');
});
