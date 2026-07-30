import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const sectionsSource = read('../src/components/chat/composer-session-control-sections.tsx');
const controlsSource = read('../src/components/chat/composer-session-controls.tsx');
const settingsPanelSource = read('../src/components/settings/settings-panel.tsx');
const customModelSettingsSource = read('../src/components/settings/custom-model-settings.tsx');
const typesSource = read('../src/lib/i18n/types.ts');
const localeSources = {
  en: read('../src/lib/i18n/en.ts'),
  ko: read('../src/lib/i18n/ko.ts'),
  ja: read('../src/lib/i18n/ja.ts'),
  zh: read('../src/lib/i18n/zh.ts'),
};

test('composer model menu stays a closed list', () => {
  assert.doesNotMatch(sectionsSource, /allowCustomModel/);
  assert.doesNotMatch(sectionsSource, /submitCustomModel/);
  assert.doesNotMatch(controlsSource, /customApplyLabel/);
});

test('settings exposes custom model ID editors for Claude Code and Codex', () => {
  assert.match(settingsPanelSource, /id: 'models' as const/);
  assert.match(settingsPanelSource, /<CustomModelSettings \/>/);
  assert.match(customModelSettingsSource, /\{ id: 'claude-code', label: 'Claude Code' \}/);
  assert.match(customModelSettingsSource, /\{ id: 'codex', label: 'Codex' \}/);
  assert.match(customModelSettingsSource, /providerCustomModels/);
  assert.match(customModelSettingsSource, /delete next\[providerId\]/);
});

test('i18n types and every locale declare the custom-model keys', () => {
  const keys = [
    'customLabel',
    'customPlaceholder',
    'customApply',
    'customHint',
    'customEmpty',
    'customRemove',
  ];
  for (const key of keys) {
    assert.match(typesSource, new RegExp(`${key}: string;`), `types.ts missing ${key}`);
    for (const [locale, source] of Object.entries(localeSources)) {
      assert.match(source, new RegExp(`${key}:`), `${locale}.ts missing ${key}`);
    }
  }
  assert.match(typesSource, /models: string;/);
  assert.match(typesSource, /modelsDesc: string;/);
});
