import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const collectionSource = fs.readFileSync(
  new URL('../src/components/chat/collection-group-sections.tsx', import.meta.url),
  'utf8',
);
const kanbanSource = fs.readFileSync(
  new URL('../src/components/board/kanban-card.tsx', import.meta.url),
  'utf8',
);
const providerBrandSource = fs.readFileSync(
  new URL('../src/components/chat/provider-brand.tsx', import.meta.url),
  'utf8',
);

test('provider logo marks accept standard span props for visual test hooks', () => {
  assert.match(providerBrandSource, /HTMLAttributes<HTMLSpanElement>/);
  assert.match(providerBrandSource, /\.\.\.spanProps/);
});

test('collection list rows render provider marks after their existing type/status icon', () => {
  assert.match(collectionSource, /import \{ ProviderLogoMark \} from '\.\/provider-brand';/);

  assert.match(
    collectionSource,
    /<MessageSquare[\s\S]*data-testid=\{`collection-chat-bubble-\$\{session\.id\}`\}[\s\S]*<ProviderLogoMark\s+providerId=\{session\.provider\}[\s\S]*data-testid=\{`collection-chat-agent-icon-\$\{session\.id\}`\}/,
  );

  assert.match(
    collectionSource,
    /<FolderGit2[\s\S]*<ProviderLogoMark\s+providerId=\{task\.sessions\[0\]\?\.provider\}[\s\S]*data-testid=\{`collection-task-agent-icon-\$\{task\.id\}`\}/,
  );

  assert.match(
    collectionSource,
    /<ProviderLogoMark\s+providerId=\{sess\.provider\}[\s\S]*data-testid=\{`collection-subsession-agent-icon-\$\{sess\.id\}`\}/,
  );
});

test('kanban cards render provider marks after their existing type/status icon', () => {
  assert.match(kanbanSource, /import \{ ProviderLogoMark \} from '@\/components\/chat\/provider-brand';/);

  assert.match(
    kanbanSource,
    /<MessageSquare[\s\S]*data-testid=\{`kanban-chat-bubble-\$\{session\.id\}`\}[\s\S]*<ProviderLogoMark\s+providerId=\{session\.provider\}[\s\S]*data-testid=\{`kanban-chat-agent-icon-\$\{session\.id\}`\}/,
  );

  assert.match(
    kanbanSource,
    /<FolderGit2[\s\S]*<ProviderLogoMark\s+providerId=\{task\.sessions\[0\]\?\.provider\}[\s\S]*data-testid=\{`kanban-task-agent-icon-\$\{task\.id\}`\}/,
  );

  assert.match(
    kanbanSource,
    /<ProviderLogoMark\s+providerId=\{session\.provider\}[\s\S]*data-testid=\{`kanban-subsession-agent-icon-\$\{session\.id\}`\}/,
  );
});
