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
    fs.existsSync(new URL('../src/app/api/archive/tasks/[id]/worktree/route.ts', import.meta.url)),
    false,
  );
  assert.equal(
    fs.existsSync(new URL('../src/app/api/archive/worktrees/[id]/route.ts', import.meta.url)),
    true,
  );

  const userSurfaces = [
    'src/components/chat/collection-group-sections.tsx',
    'src/components/chat/task-context-menu.tsx',
    'src/components/chat/sidebar.tsx',
    'src/components/board/kanban-card.tsx',
    'src/components/board/kanban-board.tsx',
  ].map(read).join('\n');
  assert.doesNotMatch(userSurfaces, /Move to Project|moveSession|MoveProjectDialog|onMoveToProject/);
  assert.doesNotMatch(read('src/stores/session-store.ts'), /\bmoveSession\s*[:(]/);
});
