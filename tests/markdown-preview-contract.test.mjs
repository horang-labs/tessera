import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../src/components/chat/preview-markdown.tsx', import.meta.url),
  'utf8',
);

test('Markdown preview tables use the available document width instead of shrinking CJK columns to content', () => {
  const tableClasses = [...source.matchAll(/<table className="([^"]+)"/g)].map((match) => match[1]);

  assert.equal(tableClasses.length, 2);
  assert.deepEqual(tableClasses, [
    'w-full table-fixed border-collapse text-sm',
    'w-full table-fixed border-collapse text-sm',
  ]);
});
