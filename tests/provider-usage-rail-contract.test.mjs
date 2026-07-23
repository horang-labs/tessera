import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const railSource = fs.readFileSync(
  new URL('../src/components/chat/provider-usage-rail.tsx', import.meta.url),
  'utf8',
);
const projectStripSource = fs.readFileSync(
  new URL('../src/components/chat/project-strip.tsx', import.meta.url),
  'utf8',
);
const chatLayoutSource = fs.readFileSync(
  new URL('../src/components/chat/chat-layout.tsx', import.meta.url),
  'utf8',
);

test('the project strip always renders Claude and Codex usage summaries', () => {
  assert.match(projectStripSource, /<ProviderUsageRail\s*\/>/);
  assert.match(railSource, /limitsByProvider\['claude-code'\]/);
  assert.match(railSource, /limitsByProvider\.codex/);
  assert.match(railSource, /data-testid=\{`provider-usage-\$\{model\.providerId\}`\}/);
  assert.match(railSource, /buildProviderUsageRailModel\('claude-code'/);
  assert.match(railSource, /buildProviderUsageRailModel\('codex'/);
  assert.match(railSource, /shortTerm\?\.shortLabel \?\? '5h'/);
  assert.match(railSource, />W</);
});

test('clicking a provider summary exposes detailed values and reset times', () => {
  assert.match(railSource, /role="dialog"/);
  assert.match(railSource, /Usage limits/);
  assert.match(railSource, /formatResetTime/);
  assert.match(railSource, /aria-expanded=\{openProviderId === model\.providerId\}/);
});

test('the project strip remains mounted when the sidebar content is collapsed', () => {
  assert.match(chatLayoutSource, /<LeftPanel[\s\S]*collapsed=\{sidebarCollapsed\}/);
  assert.doesNotMatch(chatLayoutSource, /\{!sidebarCollapsed && \(\s*<>\s*<LeftPanel/);
});
