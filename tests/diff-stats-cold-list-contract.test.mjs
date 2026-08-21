import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const listRoutes = [
  '../src/app/api/sessions/projects/route.ts',
  '../src/app/api/sessions/projects/[encodedDir]/route.ts',
  '../src/app/api/tasks/route.ts',
];

test('list routes return cached diff stats and schedule missing rows progressively', () => {
  for (const relativePath of listRoutes) {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /getCachedOrScheduleBulk\(/, relativePath);
    assert.match(source, /getCachedOrScheduleBulk\([\s\S]*?userId/, relativePath);
    assert.doesNotMatch(source, /computeAndCache|scheduleRecompute/, relativePath);
  }
});
