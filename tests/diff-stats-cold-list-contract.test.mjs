import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const listRoutes = [
  '../src/app/api/sessions/projects/route.ts',
  '../src/app/api/sessions/projects/[encodedDir]/route.ts',
  '../src/app/api/tasks/route.ts',
];

test('cold list routes read diff cache without scheduling Git work', () => {
  for (const relativePath of listRoutes) {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /getCachedBulk\(/, relativePath);
    assert.doesNotMatch(source, /getCachedOrScheduleBulk|computeAndCache|scheduleRecompute/, relativePath);
  }
});
