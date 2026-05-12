import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const gitPanelSource = fs.readFileSync(new URL('../src/lib/git/git-panel.ts', import.meta.url), 'utf8');
const fetchRouteSource = fs.readFileSync(new URL('../src/app/api/sessions/[id]/git/fetch/route.ts', import.meta.url), 'utf8');
const controllerSource = fs.readFileSync(new URL('../src/components/git/use-git-panel-controller.ts', import.meta.url), 'utf8');
const sectionsSource = fs.readFileSync(new URL('../src/components/git/git-panel-sections.tsx', import.meta.url), 'utf8');

test('git panel exposes a fetch operation that fetches the configured upstream remote and returns fresh panel data', () => {
  assert.match(gitPanelSource, /export async function fetchGitPanelData/);
  assert.match(gitPanelSource, /getFetchRemoteName/);
  assert.match(gitPanelSource, /"git",\s*\[\s*"fetch",\s*"--prune",\s*remoteName\s*\]/);
  assert.match(fetchRouteSource, /export async function POST/);
  assert.match(fetchRouteSource, /fetchGitPanelData\(id,\s*auth\.userId\)/);
});

test('recent commits include upstream commits so fetch can update the panel', () => {
  assert.match(gitPanelSource, /getRecentCommitArgs/);
  const helperSource = gitPanelSource.match(/function getRecentCommitArgs[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(helperSource, /"HEAD",\s*"@\{upstream\}"/);
  assert.doesNotMatch(helperSource, /HEAD\.\.\.@\{upstream\}/);
  assert.match(helperSource, /--date-order/);
});

test('git panel footer includes a fetch button wired to the fetch endpoint', () => {
  assert.match(controllerSource, /\/git\/fetch`/);
  assert.match(controllerSource, /handleFetch/);
  assert.match(sectionsSource, /onFetch/);
  assert.match(sectionsSource, /aria-label="Fetch"/);
});

test('git panel periodically refreshes while visible so external edits are detected', () => {
  assert.match(controllerSource, /GIT_PANEL_POLL_INTERVAL_MS/);
  assert.match(
    controllerSource,
    /window\.setInterval\(\(\) => \{[\s\S]*document\.visibilityState === "visible"[\s\S]*loadChangedFiles\(\)[\s\S]*\}, GIT_PANEL_POLL_INTERVAL_MS\)/,
  );
});
