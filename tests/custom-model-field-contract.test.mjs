import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const sectionsSource = read('../src/components/chat/composer-session-control-sections.tsx');
const controlsSource = read('../src/components/chat/composer-session-controls.tsx');
const typesSource = read('../src/lib/i18n/types.ts');
const localeSources = {
  en: read('../src/lib/i18n/en.ts'),
  ko: read('../src/lib/i18n/ko.ts'),
  ja: read('../src/lib/i18n/ja.ts'),
  zh: read('../src/lib/i18n/zh.ts'),
};

test('ComposerModelMenu renders a custom-model input gated by allowCustomModel', () => {
  assert.match(sectionsSource, /allowCustomModel\?\: boolean/);
  assert.match(sectionsSource, /allowCustomModel\s*&&/);
  assert.match(sectionsSource, /onChange=\{\(event\) => setCustomValue\(event\.target\.value\)\}/);
  assert.match(sectionsSource, /submitCustomModel/);
});

test('composer wires the custom-model field only for claude-code', () => {
  assert.match(
    controlsSource,
    /allowCustomModel=\{providerIdForSticky === 'claude-code'\}/,
  );
  for (const key of ['customLabel', 'customPlaceholder', 'customApplyLabel', 'customHint']) {
    assert.match(controlsSource, new RegExp(`${key}=\\{t\\('settings\\.model\\.`));
  }
});

test('i18n types and every locale declare the custom-model keys', () => {
  const keys = ['customLabel', 'customPlaceholder', 'customApply', 'customHint'];
  for (const key of keys) {
    assert.match(typesSource, new RegExp(`${key}: string;`), `types.ts missing ${key}`);
    for (const [locale, source] of Object.entries(localeSources)) {
      assert.match(source, new RegExp(`${key}:`), `${locale}.ts missing ${key}`);
    }
  }
});
