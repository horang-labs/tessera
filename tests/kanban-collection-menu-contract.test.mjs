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
    /function CollectionLabel\(\{ collectionId, isActive \}: \{ collectionId\?: string \| null;/,
  );
  assert.match(
    kanbanCardSource,
    /const label = collectionId \? config\?\.label : t\('task\.creation\.noCollection'\);/,
  );
  assert.match(kanbanCardSource, /<CollectionLabel collectionId=\{session\.collectionId\}/);
  assert.match(kanbanCardSource, /<CollectionLabel collectionId=\{task\.collectionId\}/);
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
