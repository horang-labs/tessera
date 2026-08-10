import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relativePath) => fs.readFileSync(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
);

test('Project, Files, Git, and Task reads never run Worktree path reconciliation', () => {
  const readSurfaces = [
    'src/app/api/sessions/projects/route.ts',
    'src/app/api/tasks/route.ts',
    'src/app/api/sessions/[id]/files/route.ts',
    'src/app/api/worktrees/[id]/files/route.ts',
    'src/lib/git/git-panel.ts',
  ];

  for (const relativePath of readSurfaces) {
    assert.doesNotMatch(
      read(relativePath),
      /routeCanonicalWorktreePaths/,
      `${relativePath} must be a pure read of canonical Worktree identity`,
    );
  }
});

test('the legacy whole-database Worktree path reconciler is not exported', () => {
  assert.doesNotMatch(
    read('src/lib/db/worktrees.ts'),
    /export async function routeCanonicalWorktreePaths/,
  );
});
