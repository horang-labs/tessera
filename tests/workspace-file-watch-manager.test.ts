import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceFileWatchManager } from '@/lib/workspace-files/workspace-file-watch-manager';

function waitFor<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for workspace change')), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

test('internal root listener observes file changes without a websocket subscriber and disposes cleanly', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-watch-'));
  const manager = new WorkspaceFileWatchManager();
  let changeCount = 0;
  let resolvePrimed!: (root: string) => void;
  let resolveFileChange!: (root: string) => void;
  const primed = new Promise<string>((resolve) => { resolvePrimed = resolve; });
  const fileChange = new Promise<string>((resolve) => { resolveFileChange = resolve; });

  const subscribe = manager.subscribeRootChanges({
    listenerId: 'terminal:test',
    root,
    onChange: (changedRoot) => {
      changeCount += 1;
      if (changeCount === 1) resolvePrimed(changedRoot);
      if (changeCount === 2) resolveFileChange(changedRoot);
    },
  });
  assert.equal(await waitFor(primed), realpathSync(root));
  const dispose = await subscribe;

  try {
    writeFileSync(path.join(root, 'changed.txt'), 'first');
    assert.equal(await waitFor(fileChange), realpathSync(root));
    assert.equal(changeCount, 2);

    dispose();
    dispose();
    writeFileSync(path.join(root, 'after-dispose.txt'), 'second');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(changeCount, 2);
  } finally {
    dispose();
  }
});

test('disposing immediately after a write flushes the pending root change', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-watch-dispose-'));
  const manager = new WorkspaceFileWatchManager();
  let changeCount = 0;
  let resolvePrimed!: () => void;
  const primed = new Promise<void>((resolve) => { resolvePrimed = resolve; });

  const dispose = await manager.subscribeRootChanges({
    listenerId: 'terminal:dispose-race',
    root,
    onChange: () => {
      changeCount += 1;
      if (changeCount === 1) resolvePrimed();
    },
  });
  await waitFor(primed);

  writeFileSync(path.join(root, 'last-change.txt'), 'last');
  const canonicalRoot = realpathSync(root);
  const entries = (manager as unknown as {
    entriesByRoot: Map<string, { debounceTimer: NodeJS.Timeout | null }>;
  }).entriesByRoot;
  await waitFor((async () => {
    while (!entries.get(canonicalRoot)?.debounceTimer) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })());
  dispose();

  assert.equal(changeCount, 2);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(changeCount, 2);
});
