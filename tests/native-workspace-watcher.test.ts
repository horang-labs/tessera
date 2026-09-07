import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { startNativeWorkspaceWatcher, workspaceWatcherOptions } from '@/lib/workspace-files/native-workspace-watcher';

test('workspace watching selects OS backends without probing the Watchman executable', async () => {
  for (const [platform, backend] of [['win32', 'windows'], ['linux', 'inotify'], ['darwin', 'fs-events']] as const) {
    assert.equal(workspaceWatcherOptions(platform).backend, backend);
  }
  let observedBackend: string | undefined;
  const watcher = startNativeWorkspaceWatcher('/repo', () => {}, async (_root, _callback, options) => {
    observedBackend = options.backend;
    return { unsubscribe: async () => {} };
  });
  await watcher.ready;
  assert.equal(observedBackend, workspaceWatcherOptions().backend);
  assert.ok(observedBackend);
  await watcher.close();
});

test('Windows native subscription never executes the Watchman discovery command', { skip: process.platform !== 'win32' }, async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-watchman-probe-'));
  const marker = path.join(root, 'probed.txt');
  const script = path.join(root, 'subscribe.cjs');
  try {
    await fs.writeFile(path.join(root, 'watchman.cmd'), '@echo off\r\necho probed>"%TESSERA_WATCHMAN_PROBE_FILE%"\r\nexit /b 1\r\n');
    await fs.writeFile(script, `
      const watcher = require(process.argv[2]);
      watcher.subscribe(process.cwd(), () => {}, JSON.parse(process.argv[3]))
        .then(subscription => subscription.unsubscribe())
        .catch(error => { console.error(error); process.exitCode = 1; });
    `);
    const env: NodeJS.ProcessEnv = { ...process.env, WATCHMAN_SOCK: '', TESSERA_WATCHMAN_PROBE_FILE: marker };
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${root};${env[pathKey] ?? ''}`;
    const modulePath = createRequire(path.resolve('package.json')).resolve('@parcel/watcher');
    for (const options of [{}, workspaceWatcherOptions()]) {
      await fs.rm(marker, { force: true });
      await promisify(execFile)(process.execPath, [script, modulePath, JSON.stringify(options)], {
        cwd: root, env, windowsHide: true, timeout: 10_000,
      });
      const probed = await fs.access(marker).then(() => true, () => false);
      assert.equal(probed, !('backend' in options));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('closing during native startup releases the late subscription once and suppresses callbacks', async () => {
  let complete!: (value: { unsubscribe(): Promise<void> }) => void;
  let calls = 0;
  let delivered = 0;
  const watcher = startNativeWorkspaceWatcher('/repo', () => delivered++, async (_root, callback) => {
    await new Promise<void>((resolve) => { complete = (value) => { resolve(); subscription = value; }; });
    callback(null, [{ path: '/repo/file', type: 'create' }]);
    return subscription;
  });
  let subscription!: { unsubscribe(): Promise<void> };
  await Promise.resolve();
  const closing = watcher.close();
  assert.equal(watcher.close(), closing);
  complete({ unsubscribe: async () => { calls++; } });
  await closing;
  assert.equal(calls, 1);
  assert.equal(delivered, 0);
});

test('native startup failure is observable and close remains safe', async () => {
  const watcher = startNativeWorkspaceWatcher('/repo', () => {}, async () => { throw new Error('native unavailable'); });
  await assert.rejects(watcher.ready, /native unavailable/);
  await watcher.close();
});

test('native exclusions match nested generated directories without excluding source siblings', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const options = workspaceWatcherOptions(platform);
    const regex = new RegExp(options.ignoreGlobs[0]);
    for (const p of ['.venv/lib/a.py', 'packages/api/.venv/lib/a.py', 'a/node_modules/p/index.js']) assert.ok(regex.test(p), p);
    for (const p of ['build', '.venv', 'src/a.py', '.venv-source/a.py', 'a/my_node_modules/b']) assert.ok(!regex.test(p), p);
    assert.equal(regex.test('a\\.venv\\lib\\a.py'), platform === 'win32');
    assert.ok((options.ignore?.length ?? 0) <= 8);
  }
});

test('real native matching prunes generated contents but observes same-name regular files', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(process.cwd(), '.watcher-test-'));
  const events: string[] = [];
  let failure: Error | null = null;
  let watcher: ReturnType<typeof startNativeWorkspaceWatcher> | undefined;
  const waitFor = async (name: string) => {
    const deadline = Date.now() + 5000;
    while (!events.includes(name)) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error(`Missing native event: ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await fs.mkdir(path.join(root, 'nested/.venv/lib'), { recursive: true });
    await fs.writeFile(path.join(root, 'nested/.venv/lib/hidden.py'), 'before');
    watcher = startNativeWorkspaceWatcher(root, (error, batch) => {
      failure = error;
      events.push(...batch.map((event) => path.relative(root, event.path).split(path.sep).join('/')));
    });
    await watcher.ready;
    await fs.writeFile(path.join(root, 'build'), 'new');
    await waitFor('build');
    events.length = 0;
    await fs.appendFile(path.join(root, 'build'), 'modified');
    await waitFor('build');
    events.length = 0;
    await fs.unlink(path.join(root, 'build'));
    await waitFor('build');
    events.length = 0;
    await fs.appendFile(path.join(root, 'nested/.venv/lib/hidden.py'), 'ignored');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!events.some((name) => name.endsWith('hidden.py')));
  } finally {
    await watcher?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
