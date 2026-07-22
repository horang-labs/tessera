import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isWindowsHostedWslRoot,
  WorkspaceFileWatchManager,
} from '@/lib/workspace-files/workspace-file-watch-manager';

interface TestWatchEntry {
  bridgeActive: boolean;
  closeTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  files: Set<string>;
  readyPromise: Promise<void>;
  watchMode: 'watch' | 'poll';
  watcher: { close(): Promise<void> } | null;
}

function managerInternals(manager: WorkspaceFileWatchManager): {
  entriesByRoot: Map<string, TestWatchEntry>;
  refreshPollIndex(entry: TestWatchEntry): Promise<void>;
  closeEntryNow(entry: TestWatchEntry): void;
} {
  return manager as unknown as ReturnType<typeof managerInternals>;
}

function waitFor<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for workspace change')), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

test('only Windows-hosted WSL roots bypass chokidar', () => {
  assert.equal(
    isWindowsHostedWslRoot('\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\project'),
    true,
  );
  assert.equal(isWindowsHostedWslRoot('//wsl$/Ubuntu-24.04/home/work/project'), true);
  assert.equal(isWindowsHostedWslRoot('\\\\fileserver\\share\\project'), false);
  assert.equal(isWindowsHostedWslRoot('C:\\Users\\work\\project'), false);
  assert.equal(isWindowsHostedWslRoot('/home/work/project'), false);
});

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

test('ensureSnapshotForRoot stays passive for watch-capable roots without an entry', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-ensure-'));
  writeFileSync(path.join(root, 'present.txt'), 'x');
  const manager = new WorkspaceFileWatchManager();

  assert.equal(await manager.ensureSnapshotForRoot(root), null);
  assert.equal(managerInternals(manager).entriesByRoot.size, 0);
});

test('poll-mode refresh diffs the index, notifies listeners, and delays teardown', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-poll-'));
  writeFileSync(path.join(root, 'seed.txt'), 'seed');
  const manager = new WorkspaceFileWatchManager();
  const internals = managerInternals(manager);
  let changeCount = 0;

  const dispose = await manager.subscribeRootChanges({
    listenerId: 'terminal:poll-test',
    root,
    onChange: () => { changeCount += 1; },
  });
  const canonicalRoot = realpathSync(root);
  const entry = internals.entriesByRoot.get(canonicalRoot);
  assert.ok(entry);
  await entry.readyPromise;
  await waitFor((async () => { while (changeCount < 1) await new Promise((r) => setTimeout(r, 10)); })());

  // Simulate a network-share root: no watcher, poll-based indexing.
  await entry.watcher?.close();
  entry.watcher = null;
  entry.watchMode = 'poll';

  writeFileSync(path.join(root, 'added.txt'), 'new');
  await internals.refreshPollIndex(entry);
  assert.ok(entry.files.has('added.txt'));
  assert.ok(entry.files.has('seed.txt'));
  assert.ok(changeCount >= 2, `listener should observe poll diff (changeCount=${changeCount})`);

  const beforeContentOnlyRefresh = changeCount;
  writeFileSync(path.join(root, 'seed.txt'), 'changed content');
  await internals.refreshPollIndex(entry);
  assert.ok(
    changeCount > beforeContentOnlyRefresh,
    'bridge fallback should invalidate listeners for content-only changes',
  );

  rmSync(path.join(root, 'added.txt'));
  await internals.refreshPollIndex(entry);
  assert.equal(entry.files.has('added.txt'), false);

  // Poll entries are kept warm briefly instead of closing on last unsubscribe.
  dispose();
  assert.ok(internals.entriesByRoot.has(canonicalRoot), 'poll entry should linger after dispose');
  assert.ok(entry.closeTimer, 'poll entry should have a scheduled close');
  clearTimeout(entry.closeTimer);
  entry.closeTimer = null;
  internals.closeEntryNow(entry);
  assert.equal(internals.entriesByRoot.has(canonicalRoot), false);
});
