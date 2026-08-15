import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';

import {
  fetchOpenCodeCommandCatalog,
  listOpenCodeCommands,
  setOpenCodeCommandDiscoveryExecutorForTests,
} from '@/lib/cli/providers/opencode/command-discovery-client';

test.afterEach(() => {
  setOpenCodeCommandDiscoveryExecutorForTests(null);
});

test('OpenCode commands match the post-start ACP catalog without creating a session', async () => {
  const contexts: unknown[] = [];
  setOpenCodeCommandDiscoveryExecutorForTests(async (context) => {
    contexts.push(context);
    return [
      { name: 'init', description: 'guided AGENTS.md setup', source: 'command' },
      { name: 'diagnosing-bugs', description: 'Diagnose hard bugs', source: 'skill' },
      { name: 42, description: 'invalid' },
    ];
  });

  const commands = await listOpenCodeCommands({
    userId: 'user-1',
    workDir: '/repo',
    environment: 'wsl',
  });

  assert.deepEqual(contexts, [{
    userId: 'user-1',
    workDir: '/repo',
    environment: 'wsl',
  }]);
  assert.deepEqual(commands, [
    { name: 'init', description: 'guided AGENTS.md setup' },
    { name: 'diagnosing-bugs', description: 'Diagnose hard bugs' },
    { name: 'compact', description: 'compact the session' },
  ]);
});

test('OpenCode discovery preserves a provider-reported compact command without duplicating it', async () => {
  setOpenCodeCommandDiscoveryExecutorForTests(async () => [
    { name: 'compact', description: 'Configured compact command', source: 'command' },
  ]);

  assert.deepEqual(await listOpenCodeCommands({
    workDir: '/repo',
    environment: 'wsl',
  }), [
    { name: 'compact', description: 'Configured compact command' },
  ]);
});

test('OpenCode discovery waits for bridged WSL localhost forwarding to become reachable', async (t) => {
  const reservation = createNetServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });

  const catalog = [{ name: 'diagnosing-bugs', description: 'Diagnose hard bugs' }];
  const delayedServer = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(catalog));
  });
  const startTimer = setTimeout(() => {
    delayedServer.listen(port, '127.0.0.1');
  }, 150);
  t.after(async () => {
    clearTimeout(startTimer);
    if (!delayedServer.listening) return;
    await new Promise<void>((resolve) => delayedServer.close(() => resolve()));
  });

  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), 2_000);
  try {
    const url = new URL(`http://127.0.0.1:${port}/command`);
    url.searchParams.set('directory', '/repo');
    assert.deepEqual(await fetchOpenCodeCommandCatalog(url, {
      signal: abortController.signal,
    }), catalog);
  } finally {
    clearTimeout(abortTimer);
  }
});
