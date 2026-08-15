import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const projectStripSource = fs.readFileSync(
  new URL('../src/components/chat/project-strip.tsx', import.meta.url),
  'utf8',
);
const starButtonSource = fs.readFileSync(
  new URL('../src/components/github/github-star-button.tsx', import.meta.url),
  'utf8',
);
const starRouteSource = fs.readFileSync(
  new URL('../src/app/api/github/star/route.ts', import.meta.url),
  'utf8',
);

test('the GitHub Star action is the first global action below provider usage', () => {
  assert.match(
    projectStripSource,
    /<ProviderUsageRail\s*\/>[\s\S]*!hideManagementActions[\s\S]*<GitHubStarButton\s*\/>[\s\S]*<NotificationBell/,
  );
});

test('the GitHub Star action is hidden on phones and after success', () => {
  assert.match(starButtonSource, /if \(isPhone \|\| state === 'hidden'\) return null/);
  assert.match(starButtonSource, /className="rounded-none max-sm:hidden"/);
  assert.match(starButtonSource, /setState\('hidden'\), 1_000/);
});

test('the GitHub Star action uses bounded requests and a direct-click web fallback', () => {
  assert.match(starButtonSource, /STATUS_CHECK_TIMEOUT_MS = 3_000/);
  assert.match(starButtonSource, /STAR_REQUEST_TIMEOUT_MS = 5_000/);
  assert.match(starButtonSource, /toast\.info\(t\('projectStrip\.githubStarFallback'\)\)/);
  assert.match(starButtonSource, /openExternalHttpUrl\(TESSERA_REPOSITORY_URL\)/);
  assert.doesNotMatch(starButtonSource, /window\.open/);
});

test('the GitHub API runs gh in the authenticated user agent environment', () => {
  assert.match(starRouteSource, /requireAuthenticatedUserId\(request\)/);
  assert.match(starRouteSource, /getAgentEnvironment\(auth\.userId\)/);
  assert.match(starRouteSource, /createGhRunner\(agentEnvironment\)/);
});
