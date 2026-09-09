import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function read(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

test('periodic PR polling is bounded by active runtimes', () => {
  const poller = read('src/lib/github/task-pr-poller.ts');
  const sync = read('src/lib/github/task-pr-sync.ts');

  assert.match(poller, /const activeSessionIds = getActiveSessionIds\(\)/);
  assert.match(poller, /taskIds: activeTaskIds/);
  assert.match(sync, /const CONCURRENCY = 1/);
});

test('global usage probing is off the startup critical path', () => {
  const poller = read('src/lib/rate-limit/poller.ts');

  assert.doesNotMatch(poller, /Fetch immediately on start/);
  assert.doesNotMatch(poller, /await this\.poll\(\)/);
});

test('short-lived Codex requests terminate the complete Windows WSL tree', () => {
  const client = read('src/lib/cli/providers/codex/app-server-request-client.ts');
  const termination = read('src/lib/cli/process-termination.ts');

  assert.match(client, /forceKillProcessTree\(proc\)/);
  assert.match(termination, /taskkill/);
  assert.match(termination, /process\.platform === 'win32'/);
});
