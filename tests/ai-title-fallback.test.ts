import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFallbackTitle } from '@/lib/session/ai-title-generator';

test('AI title fallback uses the first line and preserves its language', () => {
  assert.equal(
    generateFallbackTitle('클로드 제목 자동생성을 고쳐줘\n이 줄은 제목에 포함하지 마'),
    '클로드 제목 자동생성을 고쳐줘',
  );
});

test('AI title fallback is deterministic and capped at 30 code points', () => {
  const message = '🧩'.repeat(35);
  const first = generateFallbackTitle(message);
  const second = generateFallbackTitle(message);

  assert.equal(first, second);
  assert.equal(Array.from(first ?? '').length, 30);
});

test('AI title fallback preserves punctuation-only command prompts', () => {
  assert.equal(generateFallbackTitle('!!!'), '!!!');
});
