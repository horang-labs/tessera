// One dev server on a free port, for e2e files that only need a page to look at (#268).
//
// Reserve a port, spawn `tsx server.ts` against a throwaway data dir, wait for
// `/api/settings`, tear the process group down. Every mobile e2e file in the wave carries
// its own copy of that; this one is new and so far only `phone-settings-shortcut-rows-fit`
// uses it. The other sixteen were deliberately left alone — migrating them is a broad
// refactor, and CONTRIBUTING asks bugfix changes not to carry those.
//
// It deliberately does *not* copy the repository to an app root. Every assertion in this
// wave is a measured box and Tailwind only generates its utility layer for the tree it is
// pointed at, so a copied root serves the page unstyled and every box measures as its
// content (#252).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** The host app's own session, which must not leak into the server under test. */
const HOST_SESSION_KEYS = [
  'ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT', 'TESSERA_ELECTRON_SERVER',
  'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT', 'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID',
  'TESSERA_PROJECT_ID', 'TESSERA_WORKTREE_ID', '__CFBundleIdentifier',
];

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

/**
 * Start a dev server and wait until it answers. Resolves to
 * `{ origin, appSecret, dataDir, stop }` — `appSecret` is the value the
 * `x-tessera-app-secret` header needs, and `stop` is safe to call from a `finally`
 * whether or not the server ever came up.
 *
 * `seed` runs once the data directory exists and before the server is spawned, which is
 * the only moment a file the server reads at boot — `users.json`, say — can be written.
 * `env` adds the variables a caller needs and this default does not set; the helper's own
 * variables still win, so `dataDir` and the port it returns stay the ones in use.
 *
 * @param {{
 *   dataDirPrefix?: string,
 *   env?: Record<string, string>,
 *   seed?: (dataDir: string) => Promise<void> | void,
 * }} [options]
 */
export async function startDevServer({
  dataDirPrefix = 'tessera-e2e-data-',
  env: extraEnv = {},
  seed,
} = {}) {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const tempRoot = path.join(os.homedir(), 'tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(tempRoot, dataDirPrefix));
  await seed?.(dataDir);

  const env = { ...process.env };
  for (const key of HOST_SESSION_KEYS) delete env[key];

  const output = [];
  const server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: {
      ...env,
      ...extraEnv,
      NODE_ENV: 'development',
      PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => {
      output.push(chunk.toString());
      if (output.length > 200) output.shift();
    });
  }

  const stop = async () => {
    if (server.exitCode !== null) return;
    const exited = new Promise((resolve) => server.once('exit', resolve));
    try {
      // The whole group: `tsx` forks, and killing only the parent leaves the port held.
      if (process.platform === 'win32') server.kill('SIGTERM');
      else process.kill(-server.pid, 'SIGTERM');
    } catch { server.kill('SIGTERM'); }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  };

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${output.join('')}`);
    try {
      const appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      const probe = await fetch(`${origin}/api/settings`, {
        headers: { 'x-tessera-app-secret': appSecret },
      });
      if (probe.ok) return { origin, appSecret, dataDir, stop };
    } catch { /* Next is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await stop();
  throw new Error(`server did not start:\n${output.join('')}`);
}

/**
 * Write settings on the server. Font scale in particular has to go here and not only into
 * localStorage: `ThemeInitializer` writes `--font-scale` from the loaded settings, so a
 * seeded localStorage value is overwritten the moment the store hydrates.
 */
export async function putSettings({ origin, appSecret }, settings) {
  const response = await fetch(`${origin}/api/settings`, {
    method: 'PUT',
    // Mutating routes check the origin; `fetch` does not set one for us.
    headers: { 'content-type': 'application/json', 'x-tessera-app-secret': appSecret, origin },
    body: JSON.stringify(settings),
  });
  assert.equal(response.ok, true, `could not write settings: ${await response.text()}`);
}
