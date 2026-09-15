import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isWindowsHostedWslRoot,
  WorkspaceFileWatchManager,
} from '@/lib/workspace-files/workspace-file-watch-manager';
import type { WslInotifyBridgeOptions } from '@/lib/workspace-files/wsl-inotify-bridge';

interface TestWatchEntry {
  debounceTimer: NodeJS.Timeout | null;
  files: Set<string>;
  pendingRescanDirs: Map<string, boolean>;
  ready: boolean;
  readyPromise: Promise<void>;
  status: 'starting' | 'active' | 'fallback';
  symlinks: Set<string>;
  watchMode: 'watch' | 'wsl-bridge';
  watcher: { close(): Promise<void>;  } | null;
}

function managerInternals(manager: WorkspaceFileWatchManager): {
  entriesByRoot: Map<string, TestWatchEntry>;
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
 * bridge, with no the native watcher underneath. Closing the watcher keeps the test
 * honest — otherwise the native watcher quietly supplies the events the bridge is being
 * tested for losing.
 */
async function silenceNativeWatcher(entry: TestWatchEntry): Promise<void> {
  const watcher = entry.watcher;
  entry.watcher = null;
  entry.watchMode = 'wsl-bridge';
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

test('only Windows-hosted WSL roots bypass the native watcher', () => {
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

test('WSL bridge readiness and events never build a recursive workspace index', async () => {
  const root = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\large-project';
  let bridgeOptions: WslInotifyBridgeOptions | undefined;
  let bridgeStops = 0;
  const manager = new WorkspaceFileWatchManager({
    platform: 'win32',
    acquireWslBridge: (options) => {
      bridgeOptions = options;
      queueMicrotask(options.onEstablished);
      return { stop: () => { bridgeStops += 1; } };
    },
  });
  let changeCount = 0;
  const dispose = await manager.subscribeRootChanges({
    listenerId: 'terminal:wsl-event-only',
    root,
    onChange: () => { changeCount += 1; },
  });
  const entry = managerInternals(manager).entriesByRoot.get(root);
  assert.ok(entry);

  try {
    await entry.readyPromise;
    await waitUntil(() => changeCount === 1);
    assert.equal(entry.watchMode, 'wsl-bridge');
    assert.equal(entry.files.size, 0, 'WSL readiness must not recursively enumerate files');
    assert.equal(await manager.ensureSnapshotForRoot(root), null);

    bridgeOptions?.onEvent({ eventName: 'addDir', relativePath: 'new-populated-folder' });
    await waitUntil(() => changeCount === 2);
    assert.equal(entry.files.size, 0, 'bridge events must not create a recursive index');
    assert.equal(entry.pendingRescanDirs.size, 0, 'bridge events must not queue subtree scans');

    bridgeOptions?.onDown('simulated registration loss');
    assert.equal(entry.status, 'starting', 'a bridge outage waits for re-registration');
    bridgeOptions?.onEstablished();
    await waitUntil(() => changeCount === 3);
    assert.equal(entry.status, 'active');
    assert.equal(entry.files.size, 0, 're-registration must not trigger a catch-up scan');
  } finally {
    dispose();
  }
  assert.equal(bridgeStops, 1);
  assert.equal(managerInternals(manager).entriesByRoot.size, 0);
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
    // The initial notification only fires once the native watcher is ready; without it the
    // links below can be created before the watcher is listening.
    await waitFor(primed);

    // Native events are reconciled against the filesystem to classify links.
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

test('a bridge event for content written to an existing file notifies root listeners', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-content-change-'));
  const manager = new WorkspaceFileWatchManager();
  const internals = managerInternals(manager);
  writeFileSync(path.join(root, 'test.md'), '');
  let changeCount = 0;
  let resolvePrimed!: () => void;
  const primed = new Promise<void>((resolve) => { resolvePrimed = resolve; });

  const dispose = await manager.subscribeRootChanges({
    listenerId: 'terminal:content-change',
    root,
    onChange: () => {
      changeCount += 1;
      if (changeCount === 1) resolvePrimed();
    },
  });
  const entry = internals.entriesByRoot.get(realpathSync(root))!;
  await entry.readyPromise;
  await waitFor(primed);
  await silenceNativeWatcher(entry);

  try {
    writeFileSync(path.join(root, 'test.md'), 'one\ntwo\nthree\n');
    internals.handleBridgeEvent(entry, {
      eventName: 'change',
      relativePath: 'test.md',
    });
    await waitUntil(() => changeCount === 2);
    // Let the real debounce window fully drain so a leftover timer cannot hide
    // an accidental duplicate notification from this assertion.
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(changeCount, 2, 'content-only changes must refresh terminal diff stats');
  } finally {
    dispose();
    rmSync(root, { force: true, recursive: true });
  }
});

test('new generated directories stay excluded while same-name regular files remain live', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-ignore-'));
  const manager = new WorkspaceFileWatchManager();
  let notifications = 0;
  const dispose = await manager.subscribeRootChanges({ root, listenerId: 'ignore-regression', onChange: () => { notifications++; } });
  try {
    await waitUntil(() => notifications > 0);
    mkdirSync(path.join(root, '.venv/lib'), { recursive: true });
    writeFileSync(path.join(root, '.venv/lib/hidden.py'), 'hidden');
    writeFileSync(path.join(root, 'build'), 'source');
    const entry = managerInternals(manager).entriesByRoot.get(realpathSync(root))!;
    await waitUntil(() => entry.files.has('build'));
    const directories = (entry as unknown as { directories: Set<string> }).directories;
    assert.ok(!directories.has('.venv'));
    assert.ok(!entry.files.has('.venv/lib/hidden.py'));
    rmSync(path.join(root, 'build'));
    await waitUntil(() => !entry.files.has('build'));
  } finally {
    dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a UI subscriber receives a tree refresh when the initial index becomes ready', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-ready-'));
  writeFileSync(path.join(root, 'before-native-ready.txt'), 'already present');
  const manager = new WorkspaceFileWatchManager();
  (manager as unknown as { resolveRootForSession(): Promise<string> }).resolveRootForSession = async () => root;
  const messages: Array<{ type: string; treeChanged?: boolean; status?: string }> = [];
  try {
    await manager.subscribe({
      agentEnvironment: 'native',
      connectionId: 'ready-test', sessionId: 'ready-session', subscriberId: 'files', userId: 'test',
      sendToUser: (_userId, message) => messages.push(message),
    });
    await waitUntil(() => messages.some((message) => message.type === 'workspace_files_changed' && message.treeChanged));
    assert.ok(messages.some((message) => message.type === 'workspace_file_watch_status' && message.status === 'active'));
  } finally {
    manager.unsubscribeConnection('ready-test');
    rmSync(root, { recursive: true, force: true });
  }
});

for (const delivery of ['native', 'bridge'] as const) test(`content-only ${delivery} changes notify open file subscribers with the changed path`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tessera-workspace-content-'));
  writeFileSync(path.join(root, 'existing.txt'), 'before');
  const manager = new WorkspaceFileWatchManager();
  (manager as unknown as { resolveRootForSession(): Promise<string> }).resolveRootForSession = async () => root;
  const messages: Array<{ type: string; changedPaths?: string[]; treeChanged?: boolean; status?: string }> = [];
  try {
    await manager.subscribe({
      agentEnvironment: 'native', connectionId: 'content-test', sessionId: 'content-session', subscriberId: 'file-tab', userId: 'test',
      sendToUser: (_userId, message) => messages.push(message),
    });
    await waitUntil(() => messages.some((message) => message.status === 'active'));
    const entry = managerInternals(manager).entriesByRoot.get(root)!;
    if (delivery === 'bridge') await silenceNativeWatcher(entry);
    messages.length = 0;
    writeFileSync(path.join(root, 'existing.txt'), 'after external edit');
    if (delivery === 'bridge') {
      managerInternals(manager).handleBridgeEvent(entry, { eventName: 'change', relativePath: 'existing.txt' });
    }
    await waitUntil(() => messages.some((message) => message.changedPaths?.includes('existing.txt')));
    assert.equal(messages.find((message) => message.changedPaths?.includes('existing.txt'))?.treeChanged, false);
  } finally {
    manager.unsubscribeConnection('content-test');
    rmSync(root, { recursive: true, force: true });
  }
});
