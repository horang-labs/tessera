// The isolated app server the phone-usability e2e files measure against (#270).
//
// `phone-viewport.mjs` is the wave's viewport contract and `phone-browser.mjs` its
// launcher; this is the third leg — a server on a port of its own, a data directory of
// its own, and one fixture project with one session in it. Four files in the wave had
// grown their own verbatim copy of it, which is 180 lines of boilerplate per ticket
// before a single box is measured. New files take it from here; the existing four are
// left as they are rather than rewritten under a ticket that did not ask for it.
//
// The server runs from the repository itself, not from a copied app root: Tailwind only
// generates its utility layer for the tree it is pointed at, and against a copy the page
// arrives with no utilities and every box measures as its content (#252).

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';

const run = promisify(execFile);
const BROWSER_USER_ID = 'e2e-browser-user';

/**
 * Start an isolated server with one registered project and one `gui` session.
 *
 * `gui` rather than `pty` because that is what the one caller needs and there
 * is no second one to generalise from: a terminal session decodes its history
 * from a provider transcript instead of the canonical JSONL `seedHistory`
 * writes, so a `pty` caller would need more than a parameter here anyway.
 *
 * @param {{ name: string }} options
 */
export async function startPhoneAppServer({ name }) {
  const tempRoot = path.join(os.homedir(), 'tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(tempRoot, `tessera-${name}-data-`));
  const fixtureDir = await fs.mkdtemp(path.join(tempRoot, `tessera-${name}-fixture-`));
  const projectDir = path.join(fixtureDir, `${name}-${path.basename(fixtureDir).slice(-6)}`);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const output = [];
  const logs = () => output.join('');

  // One ordinary git repository, so the app will accept and open a project.
  await fs.mkdir(projectDir, { recursive: true });
  await run('git', ['init', '-b', 'main', projectDir]);
  await fs.writeFile(path.join(projectDir, 'README.md'), `# ${name}\n`, 'utf8');

  // The account the browser's cookie will name. Written before the server starts: the
  // request gate looks the token's subject up in this file, and an Electron-runtime
  // server creates no account of its own.
  const now = new Date().toISOString();
  await fs.writeFile(path.join(dataDir, 'users.json'), JSON.stringify({
    users: [{ id: BROWSER_USER_ID, username: 'e2e', passwordHash: 'unused', createdAt: now, lastLoginAt: now }],
  }, null, 2), 'utf8');

  const env = { ...process.env };
  // This suite may itself be running inside Tessera; nothing about the host app's
  // session may leak into the server under test.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT', 'TESSERA_ELECTRON_SERVER',
    'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT', 'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID',
    'TESSERA_PROJECT_ID', 'TESSERA_WORKTREE_ID']) delete env[key];

  const child = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: {
      ...env,
      NODE_ENV: 'development',
      // Without this the browser's WebSocket is refused — `extraHTTPHeaders` does not
      // reach an upgrade request — and the sidebar never receives the session list.
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
      PORT: String(port),
      TESSERA_DEV_PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { output.push(chunk.toString()); if (output.length > 400) output.shift(); });
  }

  let appSecret = null;
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs()}`);
    try {
      appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      if ((await fetch(`${origin}/api/settings`, { headers: { 'x-tessera-app-secret': appSecret } })).ok) break;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  async function api(pathname, init) {
    const response = await fetch(`${origin}${pathname}`, {
      ...init,
      // Mutating routes check the origin; fetch does not set one for us.
      headers: { 'content-type': 'application/json', 'x-tessera-app-secret': appSecret, origin, ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    return { ok: response.ok, text };
  }

  // The fixture lives on the Linux filesystem, so the server has to be told to treat
  // paths that way before it will accept the folder.
  const settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ agentEnvironment: 'wsl' }) });
  assert.equal(settings.ok, true, `could not set the agent environment: ${settings.text}`);
  const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ folderPath: projectDir }) });
  assert.equal(project.ok, true, `could not register ${projectDir}: ${project.text}`);

  const created = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: projectDir, parentProjectId: projectDir, providerId: 'claude-code',
      executionMode: 'gui', title: name, hasCustomTitle: true,
    }),
  });
  assert.equal(created.ok, true, `could not create a session: ${created.text}`);
  const sessionId = JSON.parse(created.text)?.sessionId;
  assert.ok(sessionId, `the session response carried no id: ${created.text}`);

  return {
    origin,
    appSecret,
    projectDir,
    sessionId,
    api,
    logs,

    /**
     * Turns written straight into the canonical history the read path replays
     * (`sessionHistory.getHistoryPath`). No runtime is spawned and nothing is
     * streamed: the chat view renders these through the same reducer a live
     * conversation goes through.
     *
     * @param {Array<Record<string, unknown>>} events
     */
    async seedHistory(events) {
      const historyDir = path.join(dataDir, 'session-history');
      await fs.mkdir(historyDir, { recursive: true });
      await fs.writeFile(path.join(historyDir, `${sessionId}.jsonl`),
        `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    },

    /** The user setting the root font is computed from (`theme-initializer.tsx`). */
    async setFontScale(scale) {
      const response = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ fontSize: scale }) });
      assert.equal(response.ok, true, `could not set the font scale: ${response.text}`);
    },

    /** A page already carrying the cookie the request gate wants. */
    async preparePage(context) {
      const privateKey = await fs.readFile(path.join(dataDir, 'auth', 'private.pem'), 'utf8');
      const token = jwt.sign({ sub: BROWSER_USER_ID, username: 'e2e', iss: 'tessera', aud: 'tessera-users' },
        privateKey, { algorithm: 'RS256', expiresIn: 3600 });
      await context.addCookies([{ name: 'jwt', value: token, domain: '127.0.0.1', path: '/', sameSite: 'Lax' }]);
      const page = await context.newPage();
      page.on('pageerror', (error) => output.push(`[renderer:error] ${error.stack ?? error.message}\n`));
      return page;
    },

    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      }
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(fixtureDir, { recursive: true, force: true });
    },
  };
}

/** A port nothing else is on, so parallel worktrees never meet on one. */
async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const selected = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return selected;
}
