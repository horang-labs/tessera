import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  pendingRescanDirs: Map<string, boolean>;
  ready: boolean;
  readyPromise: Promise<void>;
  symlinks: Set<string>;
  watchMode: 'watch' | 'poll';
  watcher: { close(): Promise<void>; removeAllListeners(): void } | null;
}

function managerInternals(manager: WorkspaceFileWatchManager): {
  entriesByRoot: Map<string, TestWatchEntry>;
  refreshPollIndex(entry: TestWatchEntry): Promise<void>;
  closeEntryNow(entry: TestWatchEntry): void;
  runPendingRescans(entry: TestWatchEntry): Promise<void>;
  handleBridgeEvent(
    entry: TestWatchEntry,
    event: { eventName: string; relativePath: string },
  ): void;
} {
  return manager as unknown as ReturnType<typeof managerInternals>;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the index to converge');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Reproduce the delivery a Windows-hosted WSL root actually gets: the inotify
 * bridge, with no chokidar underneath. Closing the watcher keeps the test
 * honest — otherwise chokidar quietly supplies the events the bridge is being
 * tested for losing.
 */
async function silenceChokidar(entry: TestWatchEntry): Promise<void> {
  const watcher = entry.watcher;
  entry.watcher = null;
  entry.watchMode = 'poll';
  await watcher?.close();
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

test('a symlink created after startup lands in the live index with its marker', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-symlink-'));
  const source = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-symlink-src-'));
  writeFileSync(path.join(source, 'CLAUDE.md'), 'shared');
  mkdirSync(path.join(source, 'prd-doc'), { recursive: true });
  writeFileSync(path.join(source, 'prd-doc/spec.md'), 'spec');

  const manager = new WorkspaceFileWatchManager();
  const internals = managerInternals(manager);
  let resolvePrimed!: () => void;
  const primed = new Promise<void>((resolve) => { resolvePrimed = resolve; });
  const dispose = await manager.subscribeRootChanges({
    listenerId: 'terminal:symlink-test',
    root,
    onChange: () => resolvePrimed(),
  });

  try {
    const canonicalRoot = realpathSync(root);
    const entry = internals.entriesByRoot.get(canonicalRoot);
    assert.ok(entry);
    await entry.readyPromise;
    // The initial notification only fires once chokidar is ready; without it the
    // links below can be created before the watcher is listening.
    await waitFor(primed);

    // chokidar lstats with followSymlinks:false, so both links arrive as "add"
    // with isFile() === false. Only the one pointing at a file may be indexed.
    symlinkSync(path.join(source, 'CLAUDE.md'), path.join(root, 'CLAUDE.md'));
    symlinkSync(path.join(source, 'prd-doc'), path.join(root, 'prd-doc'));

    await waitFor((async () => {
      while (!entry.files.has('CLAUDE.md')) await new Promise((r) => setTimeout(r, 20));
    })());
    assert.ok(entry.symlinks.has('CLAUDE.md'), 'linked file should be marked as a symlink');

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(entry.files.has('prd-doc'), false, 'a directory link must not be indexed as a file');
    assert.equal(entry.symlinks.has('prd-doc'), false);

    rmSync(path.join(root, 'CLAUDE.md'));
    await waitFor((async () => {
      while (entry.files.has('CLAUDE.md')) await new Promise((r) => setTimeout(r, 20));
    })());
    assert.equal(entry.symlinks.has('CLAUDE.md'), false, 'removing the link must clear its marker');
  } finally {
    dispose();
  }
});

test('a directory copied in during the initial walk still reaches the index', async () => {
  // What a worktree preparation script does: `cp -R` a directory in while the
  // index is still being built. The walk cannot see what appears in a directory
  // it has already listed, and inotify cannot report the contents of a
  // directory filled faster than a watch reaches it — verified against
  // inotify-tools 3.22, where `cp -R` delivers the top-level CREATE,ISDIR and
  // nothing for a nested file. Only re-reading recovers it.
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-copy-race-'));
  const manager = new WorkspaceFileWatchManager();
  const internals = managerInternals(manager);
  writeFileSync(path.join(root, 'seed.ts'), '');

  const dispose = await manager.subscribeRootChanges({
    listenerId: 'terminal:copy-race',
    root,
    onChange: () => {},
  });
  const entry = internals.entriesByRoot.get(realpathSync(root))!;
  await entry.readyPromise;
  await silenceChokidar(entry);

  try {
    // Reopen the window the preparation script writes into: the walk is running
    // and has already listed the root, so the directory created below is one it
    // provably never sees. Held open explicitly because a walk over a temp dir
    // finishes in milliseconds, while the real one crosses a 9P share against a
    // script that runs for twenty seconds.
    entry.ready = false;
    mkdirSync(path.join(root, '.codex/skills/graphify'), { recursive: true });
    writeFileSync(path.join(root, '.codex/hooks.json'), '{}');
    writeFileSync(path.join(root, '.codex/skills/graphify/SKILL.md'), 'skill');
    internals.handleBridgeEvent(entry, { eventName: 'addDir', relativePath: '.codex' });

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      entry.files.has('.codex/hooks.json'),
      false,
      'nothing can be reconciled before the walk that owns the index finishes',
    );
    // The point of the fix: the invalidation waits instead of being discarded.
    assert.ok(
      entry.pendingRescanDirs.has('.codex'),
      'an invalidation raised during the initial walk must survive it',
    );

    // What bootstrapEntry does once the walk lands.
    entry.ready = true;
    await internals.runPendingRescans(entry);

    assert.ok(
      entry.files.has('.codex/skills/graphify/SKILL.md'),
      'the whole copied subtree belongs in the index, including what no event named',
    );
    assert.ok(entry.files.has('.codex/hooks.json'));
    assert.ok(entry.files.has('seed.ts'), 'the walk result must survive the rescan');
  } finally {
    dispose();
    // A poll-mode entry lingers for POLL_UNUSED_GRACE_MS after its last
    // listener; the test must not wait that out.
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    internals.closeEntryNow(entry);
    rmSync(root, { force: true, recursive: true });
  }
});

test('an event names a directory to re-read, not the index contents', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-invalidate-'));
  const manager = new WorkspaceFileWatchManager();
  const internals = managerInternals(manager);
  mkdirSync(path.join(root, 'existing'), { recursive: true });
  writeFileSync(path.join(root, 'existing/kept.ts'), '');

  const dispose = await manager.subscribeRootChanges({
    listenerId: 'terminal:invalidate',
    root,
    onChange: () => {},
  });
  const entry = internals.entriesByRoot.get(realpathSync(root))!;
  await entry.readyPromise;
  await silenceChokidar(entry);

  try {
    // A file whose creation event was lost, arriving only as a modification —
    // exactly what inotify delivers for a file written into a directory it was
    // still registering a watch for.
    writeFileSync(path.join(root, 'existing/missed-create.ts'), 'x');
    internals.handleBridgeEvent(entry, {
      eventName: 'change',
      relativePath: 'existing/missed-create.ts',
    });
    await waitUntil(() => entry.files.has('existing/missed-create.ts'));

    // And the reverse: an event for a file that is already gone must not leave
    // a ghost behind, however the event described it.
    rmSync(path.join(root, 'existing/missed-create.ts'));
    internals.handleBridgeEvent(entry, {
      eventName: 'add',
      relativePath: 'existing/missed-create.ts',
    });
    await waitUntil(() => !entry.files.has('existing/missed-create.ts'));
    assert.ok(entry.files.has('existing/kept.ts'), 'the rest of the directory is untouched');
  } finally {
    dispose();
    // A poll-mode entry lingers for POLL_UNUSED_GRACE_MS after its last
    // listener; the test must not wait that out.
    if (entry!.closeTimer) clearTimeout(entry!.closeTimer);
    internals.closeEntryNow(entry!);
    rmSync(root, { force: true, recursive: true });
  }
});

test('a removed directory takes its subtree out of the index', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-unlink-dir-'));
  const manager = new WorkspaceFileWatchManager();
  const internals = managerInternals(manager);
  mkdirSync(path.join(root, 'doomed/nested'), { recursive: true });
  writeFileSync(path.join(root, 'doomed/nested/deep.ts'), '');
  writeFileSync(path.join(root, 'survivor.ts'), '');

  const dispose = await manager.subscribeRootChanges({
    listenerId: 'terminal:unlink-dir',
    root,
    onChange: () => {},
  });
  const entry = internals.entriesByRoot.get(realpathSync(root))!;
  await entry.readyPromise;
  await silenceChokidar(entry);

  try {
    assert.ok(entry.files.has('doomed/nested/deep.ts'));
    rmSync(path.join(root, 'doomed'), { force: true, recursive: true });
    internals.handleBridgeEvent(entry, { eventName: 'unlinkDir', relativePath: 'doomed' });

    await waitUntil(() => !entry.files.has('doomed/nested/deep.ts'));
    assert.ok(entry.files.has('survivor.ts'));
  } finally {
    dispose();
    // A poll-mode entry lingers for POLL_UNUSED_GRACE_MS after its last
    // listener; the test must not wait that out.
    if (entry!.closeTimer) clearTimeout(entry!.closeTimer);
    internals.closeEntryNow(entry!);
    rmSync(root, { force: true, recursive: true });
  }
});
