import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../src/components/image-generation/image-generations-panel.tsx', import.meta.url),
  'utf8',
);
const promptDetailsSource = source.slice(
  source.indexOf('function PromptDetails'),
  source.indexOf('function EmptyState'),
);

test('prompt text stays selectable and outside a native button', () => {
  assert.match(promptDetailsSource, /data-testid="image-generation-prompt-text"/);
  assert.match(promptDetailsSource, /select-text/);
  assert.match(promptDetailsSource, /getSelection\(\)\?\.isCollapsed/);
  assert.doesNotMatch(
    promptDetailsSource,
    /<button[\s\S]*?image_generation\.prompt\.toggle[\s\S]*?\{text\}[\s\S]*?<\/button>/,
  );
});

test('prompt actions provide an explicit full-copy operation', () => {
  assert.match(source, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(source, /imagePanel\.copyPrompt/);
  assert.match(source, /image_generation\.prompt\.copy/);
});
