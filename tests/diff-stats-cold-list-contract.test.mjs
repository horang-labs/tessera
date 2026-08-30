import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('cold project index reads cache without scheduling every stored session', () => {
  const relativePath = '../src/app/api/sessions/projects/route.ts';
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

  assert.match(source, /getCachedBulk\(/);
  assert.doesNotMatch(source, /getCachedOrScheduleBulk\(/);
  assert.doesNotMatch(source, /mapped\.map\(\(s\) => s\.workDir/);
});

test('focused project routes schedule one checkout per visible worktree', () => {
  const projectSource = fs.readFileSync(
    new URL('../src/app/api/sessions/projects/[encodedDir]/route.ts', import.meta.url),
    'utf8',
  );
  const taskSource = fs.readFileSync(
    new URL('../src/app/api/tasks/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(projectSource, /getCachedOrScheduleBulk\(/);
  assert.match(projectSource, /projectWorktree\?\.filesystemPath/);
  assert.doesNotMatch(projectSource, /mapped\.map\(\(s\) => s\.workDir/);

  assert.match(taskSource, /getCachedOrScheduleBulk\(/);
  assert.match(taskSource, /projectWorktree\?\.filesystemPath/);
  assert.match(taskSource, /rawTasks\.map/);
});
