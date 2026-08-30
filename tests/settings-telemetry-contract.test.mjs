import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import parser from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default ?? traverseModule;
const SETTINGS_DIR = path.join(process.cwd(), 'src/components/settings');
const NATIVE_CONTROLS = new Set(['button', 'Button', 'input', 'select', 'textarea']);

test('every native settings control opts into privacy-safe click telemetry', () => {
  const missing = [];

  for (const name of readdirSync(SETTINGS_DIR).filter((entry) => entry.endsWith('.tsx'))) {
    const file = path.join(SETTINGS_DIR, name);
    const source = readFileSync(file, 'utf8');
    const ast = parser.parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    });

    traverse(ast, {
      JSXOpeningElement(nodePath) {
        const element = nodePath.node;
        if (element.name.type !== 'JSXIdentifier' || !NATIVE_CONTROLS.has(element.name.name)) {
          return;
        }

        const openingTag = source.slice(element.start, element.end);
        if (
          !openingTag.includes('settingsTelemetryClickAttributes')
          && !openingTag.includes('telemetryTargetAttributes')
        ) {
          missing.push(`${name}:${element.loc.start.line} <${element.name.name}>`);
        }
      },
    });
  }

  assert.deepEqual(missing, [], `Uninstrumented settings controls:\n${missing.join('\n')}`);
});

test('settings telemetry annotations never interpolate DOM or user-authored values', () => {
  const source = readdirSync(SETTINGS_DIR)
    .filter((entry) => entry.endsWith('.tsx'))
    .map((entry) => readFileSync(path.join(SETTINGS_DIR, entry), 'utf8'))
    .join('\n');

  const annotations = [...source.matchAll(/settingsTelemetryClickAttributes\(([^)]*)\)/g)]
    .map((match) => match[1]);

  assert.ok(annotations.length >= 70);
  for (const annotation of annotations) {
    assert.doesNotMatch(annotation, /\$\{|event\.|target\.|\.value|\.textContent|\.innerText/);
  }
});
