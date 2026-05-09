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
const settingsTypesSource = fs.readFileSync(
  new URL('../src/lib/settings/types.ts', import.meta.url),
  'utf8',
);
const settingsDefaultsSource = fs.readFileSync(
  new URL('../src/lib/settings/provider-defaults.ts', import.meta.url),
  'utf8',
);
const appearanceSettingsSource = fs.readFileSync(
  new URL('../src/components/settings/appearance-settings.tsx', import.meta.url),
  'utf8',
);

test('provider logo marks accept standard span props for visual test hooks', () => {
  assert.match(providerBrandSource, /HTMLAttributes<HTMLSpanElement>/);
  assert.match(providerBrandSource, /\.\.\.spanProps/);
});

test('provider icons are controlled by an enabled-by-default appearance setting', () => {
  assert.match(settingsTypesSource, /showProviderIcons:\s*boolean/);
  assert.match(settingsDefaultsSource, /showProviderIcons:\s*true/);
  assert.match(settingsDefaultsSource, /showProviderIcons:\s*raw\?\.showProviderIcons\s*\?\?\s*defaults\.showProviderIcons/);
  assert.match(appearanceSettingsSource, /settings\.showProviderIcons/);
  assert.match(appearanceSettingsSource, /updateSettings\(\{\s*showProviderIcons:\s*e\.target\.checked\s*\}\)/);
});

test('collection list rows switch between default type icons and provider marks', () => {
  assert.match(collectionSource, /import \{ ProviderLogoMark \} from '\.\/provider-brand';/);
  assert.match(collectionSource, /MessageSquare/);
  assert.match(collectionSource, /showProviderIcons/);
  assert.match(collectionSource, /collection-chat-bubble/);

  assert.match(
    collectionSource,
    /<ProviderLogoMark\s+providerId=\{session\.provider\}[\s\S]*data-testid=\{`collection-chat-agent-icon-\$\{session\.id\}`\}[\s\S]*<ItemStatusIndicator/,
  );

  assert.match(
    collectionSource,
    /<FolderGit2[\s\S]*<ProviderLogoMark\s+providerId=\{task\.sessions\[0\]\?\.provider\}[\s\S]*data-testid=\{`collection-task-agent-icon-\$\{task\.id\}`\}/,
  );

  assert.match(
    collectionSource,
    /<ProviderLogoMark\s+providerId=\{sess\.provider\}[\s\S]*data-testid=\{`collection-subsession-agent-icon-\$\{sess\.id\}`\}[\s\S]*placement="corner"[\s\S]*\) : \([\s\S]*placement="leading"/,
  );
});

test('kanban cards switch between default type icons and provider marks', () => {
  assert.match(kanbanSource, /import \{ ProviderLogoMark \} from '@\/components\/chat\/provider-brand';/);
  assert.match(kanbanSource, /MessageSquare/);
  assert.match(kanbanSource, /showProviderIcons/);
  assert.match(kanbanSource, /kanban-chat-bubble/);

  assert.match(
    kanbanSource,
    /<ProviderLogoMark\s+providerId=\{session\.provider\}[\s\S]*data-testid=\{`kanban-chat-agent-icon-\$\{session\.id\}`\}[\s\S]*<ItemStatusIndicator/,
  );

  assert.match(
    kanbanSource,
    /<FolderGit2[\s\S]*<ProviderLogoMark\s+providerId=\{task\.sessions\[0\]\?\.provider\}[\s\S]*data-testid=\{`kanban-task-agent-icon-\$\{task\.id\}`\}/,
  );

  assert.match(
    kanbanSource,
    /<ProviderLogoMark\s+providerId=\{session\.provider\}[\s\S]*data-testid=\{`kanban-subsession-agent-icon-\$\{session\.id\}`\}[\s\S]*placement="corner"[\s\S]*\) : \([\s\S]*placement="leading"/,
  );
});
