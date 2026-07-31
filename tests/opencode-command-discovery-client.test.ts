import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
