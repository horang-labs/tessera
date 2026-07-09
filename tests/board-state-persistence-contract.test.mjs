import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const boardStoreSource = fs.readFileSync(
  new URL('../src/stores/board-store.ts', import.meta.url),
  'utf8',
);

const chatLayoutSource = fs.readFileSync(
  new URL('../src/components/chat/chat-layout.tsx', import.meta.url),
  'utf8',
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('board store persists restartable sidebar and project UI state', () => {
  assert.match(boardStoreSource, /const SELECTED_PROJECT_DIR_KEY = 'ccw:selectedProjectDir';/);
  assert.match(boardStoreSource, /const ALL_PROJECTS_EXPANDED_SECTIONS_KEY = 'ccw:allProjectsExpandedSections';/);
  assert.match(boardStoreSource, /const LIST_RUNNING_FILTER_KEY = 'ccw:listRunningFilterActive';/);
  assert.match(boardStoreSource, /const ACTIVE_COLLECTION_FILTER_KEY = 'ccw:activeCollectionFilter';/);

  assert.match(boardStoreSource, /function loadBooleanRecord\(key: string\): Record<string, boolean>/);
  assert.match(boardStoreSource, /function saveBooleanRecord\(key: string, record: Record<string, boolean>\): void/);
  assert.match(boardStoreSource, /function loadNullableString\(key: string\): string \| null/);
  assert.match(boardStoreSource, /function saveNullableString\(key: string, value: string \| null\): void/);
  assert.match(boardStoreSource, /function loadBooleanFlag\(key: string\): boolean/);
  assert.match(boardStoreSource, /function saveBooleanFlag\(key: string, value: boolean\): void/);

  assert.match(boardStoreSource, /allProjectsExpandedSections: loadBooleanRecord\(ALL_PROJECTS_EXPANDED_SECTIONS_KEY\),/);
  assert.match(boardStoreSource, /saveBooleanRecord\(ALL_PROJECTS_EXPANDED_SECTIONS_KEY, allProjectsExpandedSections\);/);
  assert.match(boardStoreSource, /saveBooleanRecord\(ALL_PROJECTS_EXPANDED_SECTIONS_KEY, next\);/);

  assert.match(boardStoreSource, /isListRunningFilterActive: loadBooleanFlag\(LIST_RUNNING_FILTER_KEY\),/);
  assert.match(boardStoreSource, /saveBooleanFlag\(LIST_RUNNING_FILTER_KEY, active\);/);

  assert.match(boardStoreSource, /selectedProjectDir: loadNullableString\(SELECTED_PROJECT_DIR_KEY\),/);
  assert.match(boardStoreSource, /saveNullableString\(SELECTED_PROJECT_DIR_KEY, dir\);/);

  assert.match(boardStoreSource, /activeCollectionFilter: loadNullableString\(ACTIVE_COLLECTION_FILTER_KEY\),/);
  assert.match(boardStoreSource, /saveNullableString\(ACTIVE_COLLECTION_FILTER_KEY, id\);/);
});

test('startup keeps restored project scope before falling back to defaults', () => {
  const nullBranch = sourceBetween(
    chatLayoutSource,
    'if (current === null) {',
    '} else if (current === ALL_PROJECTS_SENTINEL) {',
  );
  assert.match(nullBranch, /const restoredProjectDir = useTabStore\.getState\(\)\.currentProjectDir;/);
  assert.match(nullBranch, /if \(restoredProjectDir === ALL_PROJECTS_SENTINEL\) \{/);
  assert.match(nullBranch, /if \(restoredProjectDir && projects\.some\(\(p\) => p\.encodedDir === restoredProjectDir\)\) \{/);
  assert.match(nullBranch, /setSelectedProjectDir\(restoredProjectDir\);/);

  const sentinelBranch = sourceBetween(
    chatLayoutSource,
    '} else if (current === ALL_PROJECTS_SENTINEL) {',
    '} else {',
  );
  assert.match(sentinelBranch, /return; \/\/ All Projects mode is always valid/);

  const staleCurrentBranch = sourceBetween(
    chatLayoutSource,
    'const stillExists = projects.some((p) => p.encodedDir === current);',
    'const proj = projects.find((p) => p.isCurrent) ?? projects[0];',
  );
  assert.match(staleCurrentBranch, /if \(!stillExists\) \{/);
  assert.match(staleCurrentBranch, /const restoredProjectDir = useTabStore\.getState\(\)\.currentProjectDir;/);
  assert.match(staleCurrentBranch, /if \(restoredProjectDir === ALL_PROJECTS_SENTINEL\) \{/);
  assert.match(staleCurrentBranch, /if \(restoredProjectDir && projects\.some\(\(p\) => p\.encodedDir === restoredProjectDir\)\) \{/);
});
