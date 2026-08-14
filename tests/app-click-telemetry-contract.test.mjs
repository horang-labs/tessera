import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const ROOTS = ['src/components', 'src/app'];
const DIRECT_INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'Button']);
const TELEMETRY_MARKERS = [
  'telemetryClickAttributes',
  'settingsTelemetryClickAttributes',
  'telemetryTargetAttributes',
  'telemetryIgnoreAttributes',
  'data-ph-capture',
  'data-telemetry-ignore',
];

async function listTsxFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTsxFiles(candidate);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [candidate] : [];
  }));
  return nested.flat();
}

function tagNameText(node, sourceFile) {
  return node.tagName.getText(sourceFile);
}

function hasTelemetryMarker(node, sourceFile) {
  const openingText = node.getText(sourceFile);
  return TELEMETRY_MARKERS.some((marker) => openingText.includes(marker));
}

function hasDirectClickHandler(node) {
  return node.attributes.properties.some((property) => (
    ts.isJsxAttribute(property) && property.name.getText() === 'onClick'
  ));
}

function collectMissingTelemetry(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const missing = [];

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagNameText(node, sourceFile);
      const isIntrinsicClickTarget = /^[a-z]/.test(tag) && hasDirectClickHandler(node);
      if (
        (DIRECT_INTERACTIVE_TAGS.has(tag) || isIntrinsicClickTarget)
        && !hasTelemetryMarker(node, sourceFile)
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        missing.push(`${file}:${position.line + 1} <${tag}>`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return missing;
}

test('every direct product control declares safe click telemetry or an explicit exclusion', async () => {
  const files = (await Promise.all(ROOTS.map(listTsxFiles)))
    .flat()
    .filter((file) => !file.includes('/dev-'))
    .sort();
  const missing = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    missing.push(...collectMissingTelemetry(file, source));
  }

  assert.deepEqual(
    missing,
    [],
    `Direct controls without telemetry contract:\n${missing.join('\n')}`,
  );
});

test('click telemetry helper calls never interpolate user or entity data', async () => {
  const files = (await Promise.all(ROOTS.map(listTsxFiles)))
    .flat()
    .filter((file) => !file.includes('/dev-'))
    .sort();
  const unsafe = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const helperCalls = source.match(/telemetryClickAttributes\([\s\S]*?\)/g) ?? [];
    for (const call of helperCalls) {
      if (call.includes('`') || call.includes('${')) unsafe.push(`${file}: ${call}`);
    }
  }
  assert.deepEqual(unsafe, []);
});
