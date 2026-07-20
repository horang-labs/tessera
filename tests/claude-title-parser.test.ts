import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClaudeTitleResponse } from '@/lib/cli/providers/claude-code/adapter';

test('Claude title parser accepts only the exact JSON object shape', () => {
  assert.deepEqual(
    parseClaudeTitleResponse('{"title":"터미널 헤더 중복 수정"}'),
    { title: '터미널 헤더 중복 수정' },
  );
  assert.equal(parseClaudeTitleResponse('Here is the title: {"title":"Wrong"}'), null);
  assert.equal(parseClaudeTitleResponse('{"title":"Valid","extra":true}'), null);
  assert.equal(parseClaudeTitleResponse('{"title":"   "}'), null);
});

test('Claude title parser decodes JSON escapes and caps Unicode safely', () => {
  assert.deepEqual(
    parseClaudeTitleResponse('{"title":"Fix \\"quoted\\" output"}'),
    { title: 'Fix "quoted" output' },
  );

  const result = parseClaudeTitleResponse(JSON.stringify({ title: '🧩'.repeat(35) }));
  assert.equal(Array.from(result?.title ?? '').length, 30);
  assert.equal(result?.title, '🧩'.repeat(30));
});
