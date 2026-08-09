import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('Project ownership transfer API and UI are unavailable', () => {
  assert.equal(
    fs.existsSync(new URL('../src/app/api/sessions/[id]/move/route.ts', import.meta.url)),
    false,
  );
  assert.equal(
    fs.existsSync(new URL('../src/app/api/tasks/[id]/sessions/route.ts', import.meta.url)),
    false,
  );
  assert.equal(
    fs.existsSync(new URL('../src/app/api/archive/tasks/[id]/worktree/route.ts', import.meta.url)),
    false,
  );
  assert.equal(
    fs.existsSync(new URL('../src/app/api/archive/worktrees/[id]/route.ts', import.meta.url)),
    false,
  );
  assert.equal(fs.existsSync(new URL('../src/app/api/worktrees/[id]/route.ts', import.meta.url)), true);
  assert.doesNotMatch(read('src/app/api/tasks/[id]/route.ts'), /export async function DELETE/);
  assert.match(read('src/stores/task-store.ts'), /\/api\/worktrees\/\$\{existingTask\.worktreeId\}/);
  assert.match(read('src/stores/task-store.ts'), /deleteWorktree: async/);

  const userSurfaces = [
    'src/components/chat/collection-group-sections.tsx',
    'src/components/chat/task-context-menu.tsx',
    'src/components/chat/sidebar.tsx',
    'src/components/board/kanban-card.tsx',
    'src/components/board/kanban-board.tsx',
  ].map(read).join('\n');
  assert.doesNotMatch(userSurfaces, /Move to Project|moveSession|MoveProjectDialog|onMoveToProject/);
  assert.doesNotMatch(read('src/stores/session-store.ts'), /\bmoveSession\s*[:(]/);
  assert.doesNotMatch(read('src/stores/session-store.ts'), /\bsetTaskIdForSessions\s*[:(]/);
  assert.doesNotMatch(read('src/lib/db/tasks.ts'), /export function addSessionToTask\(/);
  assert.doesNotMatch(
    read('src/lib/db/sessions.ts'),
    /patch\.project_id|sets\.push\('project_id = \?'\)/,
  );
  assert.doesNotMatch(read('src/lib/db/sessions.ts'), /export function reorderSessions\(/);
  assert.doesNotMatch(read('src/app/api/sessions/reorder/route.ts'), /reorderSessions\(projectId/);
  const sessionFilesRoute = read('src/app/api/sessions/[id]/files/route.ts');
  assert.match(sessionFilesRoute, /getProjectViewReferenceSessions\(projectId/);
  assert.match(sessionFilesRoute, /projectId is required for Project View references/);
  assert.doesNotMatch(sessionFilesRoute, /WHERE project_id = \?/);
  assert.ok(
    sessionFilesRoute.indexOf('await routeCanonicalWorktreePaths(agentEnvironment)')
      < sessionFilesRoute.indexOf('getProjectViewReferenceSessions(projectId'),
    'canonical path routing must complete before the Project View reference read',
  );

  const translations = [
    'src/lib/i18n/en.ts',
    'src/lib/i18n/ja.ts',
    'src/lib/i18n/ko.ts',
    'src/lib/i18n/zh.ts',
    'src/lib/i18n/types.ts',
  ].map(read).join('\n');
  assert.doesNotMatch(translations, /moveToProject|moveDialog|Move to Project/);
});
