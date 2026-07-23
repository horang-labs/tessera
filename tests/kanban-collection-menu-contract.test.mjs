import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const kanbanCardSource = fs.readFileSync(
  new URL('../src/components/board/kanban-card.tsx', import.meta.url),
  'utf8',
);
const collectionMoveSubmenuSource = fs.readFileSync(
  new URL('../src/components/chat/collection-move-submenu.tsx', import.meta.url),
  'utf8',
);

test('kanban cards render the Other collection label for uncategorized cards', () => {
  assert.match(
    kanbanCardSource,
    /function CollectionLabel\(\{[\s\S]*collectionId,[\s\S]*projectId,[\s\S]*isActive,[\s\S]*collectionId\?: string \| null;[\s\S]*projectId: string;/,
  );
  assert.match(
    kanbanCardSource,
    /const label = collectionId \? config\?\.label : t\('task\.creation\.noCollection'\);/,
  );
  assert.match(kanbanCardSource, /collectionId=\{session\.collectionId\}[\s\S]*projectId=\{session\.projectDir\}/);
  assert.match(kanbanCardSource, /collectionId=\{task\.collectionId\}[\s\S]*projectId=\{task\.projectId\}/);
});

test('collection move submenu tolerates cursor travel from trigger to submenu', () => {
  assert.match(collectionMoveSubmenuSource, /const SUBMENU_CLOSE_DELAY_MS = 180;/);
  assert.match(collectionMoveSubmenuSource, /const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> \| null>\(null\);/);
  assert.match(
    collectionMoveSubmenuSource,
    /closeTimeoutRef\.current = setTimeout\(\(\) => \{[\s\S]*setIsOpen\(false\);[\s\S]*SUBMENU_CLOSE_DELAY_MS/,
  );
  assert.match(
    collectionMoveSubmenuSource,
    /before:absolute before:top-0 before:h-full before:w-2 before:content-\[""\]/,
  );
  assert.match(
    collectionMoveSubmenuSource,
    /onMouseEnter=\{openSubmenu\}[\s\S]*onMouseLeave=\{closeSubmenu\}[\s\S]*data-testid=\{`\$\{testIdPrefix\}-move-to-menu`\}/,
  );
});
