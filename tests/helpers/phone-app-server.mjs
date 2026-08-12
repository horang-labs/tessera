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
const INHERITED_PLATFORM_ENVIRONMENT = [
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'windir',
  'COMSPEC',
  'ComSpec',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
];
const WINDOWS_BRIDGE_SCRUB_ENVIRONMENT = [
  'CLAUDECODE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'ELECTRON_CHILD',
  'ELECTRON_RUN_AS_NODE',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_DATA_DIR',
  'TERM_PROGRAM',
  'TESSERA_APP_ROOT',
  'TESSERA_CLI_COMMAND',
  'TESSERA_CODEX_HOME',
  'TESSERA_CONTROL_AUTHORITY',
  'TESSERA_CONTROL_DESCRIPTOR_PATH',
  'TESSERA_CONTROL_RUNTIME_DIR',
  'TESSERA_ELECTRON_SERVER',
  'TESSERA_ENV',
  'TESSERA_HOOK_PORT',
  'TESSERA_PANE_TOKEN',
  'TESSERA_PRODUCTION_DB',
  'TESSERA_PROJECT_ID',
  'TESSERA_SESSION_ID',
  'TESSERA_WORKTREE_ID',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
];

/**
 * Build the complete environment for the isolated server. Starting from an
 * allowlist makes new provider/session namespaces fail closed automatically.
 *
 * @param {NodeJS.ProcessEnv} callerEnvironment
 * @param {Record<string, string>} fixtureEnvironment
 */
export function buildPhoneAppServerEnvironment(callerEnvironment, fixtureEnvironment) {
  const environment = {};
  for (const name of INHERITED_PLATFORM_ENVIRONMENT) {
    const value = name === 'PATH' || name === 'Path'
      ? sanitizePhoneAppServerPath(callerEnvironment[name], callerEnvironment)
      : callerEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  const bridgeScrubNames = new Set(WINDOWS_BRIDGE_SCRUB_ENVIRONMENT);
  for (const name of Object.keys(callerEnvironment)) {
    if (isSensitivePhoneAppServerEnvironmentName(name)) bridgeScrubNames.add(name);
  }
  for (const entry of callerEnvironment.WSLENV?.split(':') ?? []) {
    const name = entry.split('/')[0];
    if (name) bridgeScrubNames.add(name);
  }
  return {
    ...environment,
    ...fixtureEnvironment,
    WSLENV: [...bridgeScrubNames].sort().join(':'),
  };
}

function sanitizePhoneAppServerPath(value, callerEnvironment) {
  if (!value) return value;
  const blockedRoots = [
    callerEnvironment.CODEX_HOME,
    callerEnvironment.TESSERA_CODEX_HOME,
    path.dirname(callerEnvironment.TESSERA_CLI_COMMAND ?? ''),
  ].filter(Boolean);
  const normalize = (entry) => entry.replace(/\\/gu, '/').toLowerCase();
  const normalizedBlockedRoots = blockedRoots.map(normalize);
  return value
    .split(path.delimiter)
    .filter((entry) => (
      entry
      && !normalizedBlockedRoots.some((root) => {
        const candidate = normalize(entry);
        return candidate === root || candidate.startsWith(`${root}/`);
      })
      && !/[\\/](?:\.tessera[\\/](?:codex-overlay|control-bridges)|tessera[\\/]control-bridges)[\\/]/u.test(entry)
    ))
    .join(path.delimiter);
}

/**
 * Start an isolated server with one registered project and one `gui` session.
 *
 * `gui` rather than `pty` because that is what the one caller needs and there
 * is no second one to generalise from: a terminal session decodes its history
 * from a provider transcript instead of the canonical JSONL `seedHistory`
 * writes, so a `pty` caller would need more than a parameter here anyway.
 *
 * @param {{
 *   name: string,
 *   failInitializationAt?: 'startup' | 'settings' | 'project' | 'session',
 * }} options
 */
export async function startPhoneAppServer({ name, failInitializationAt }) {
  const tempRoot = path.join(os.homedir(), 'tmp');
  const output = [];
  const logs = () => output.join('');
  let dataDir = null;
  let fixtureDir = null;
  let child = null;
  let origin = null;
  let initializationPhase = 'startup';
  let cleanupPromise = null;

  const cleanup = () => {
    cleanupPromise ??= cleanupPhoneAppServerResources({ child, dataDir, fixtureDir });
    return cleanupPromise;
  };

  try {
    await fs.mkdir(tempRoot, { recursive: true });
    dataDir = await fs.mkdtemp(path.join(tempRoot, `tessera-${name}-data-`));
    fixtureDir = await fs.mkdtemp(path.join(tempRoot, `tessera-${name}-fixture-`));
    const projectDir = path.join(fixtureDir, `${name}-${path.basename(fixtureDir).slice(-6)}`);
    const port = await reservePort();
    origin = `http://127.0.0.1:${port}`;

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

    child = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: buildPhoneAppServerEnvironment(process.env, {
        HOME: dataDir,
        USERPROFILE: dataDir,
        TMPDIR: dataDir,
        TEMP: dataDir,
        TMP: dataDir,
        NODE_ENV: 'development',
        // Without this the browser's WebSocket is refused — `extraHTTPHeaders` does not
        // reach an upgrade request — and the sidebar never receives the session list.
        TESSERA_ELECTRON_AUTH_BYPASS: '1',
        PORT: String(port),
        TESSERA_DEV_PORT: String(port),
        TESSERA_DATA_DIR: dataDir,
        TESSERA_ELECTRON_RUNTIME: '1',
        LOG_LEVEL: 'error',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { output.push(chunk.toString()); if (output.length > 400) output.shift(); });
    }
    let appSecret = null;
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('server exited early');
      if (Date.now() > deadline) throw new Error('server did not start');
      try {
        appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
        if ((await fetch(`${origin}/api/settings`, { headers: { 'x-tessera-app-secret': appSecret } })).ok) break;
      } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throwForcedInitializationFailure(failInitializationAt, initializationPhase);

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
    initializationPhase = 'settings';
    throwForcedInitializationFailure(failInitializationAt, initializationPhase);
    const settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ agentEnvironment: 'wsl' }) });
    assert.equal(settings.ok, true, `could not set the agent environment: ${settings.text}`);
    throwForcedInitializationFailure(failInitializationAt, initializationPhase);

    initializationPhase = 'project';
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ folderPath: projectDir }) });
    assert.equal(project.ok, true, `could not register ${projectDir}: ${project.text}`);
    throwForcedInitializationFailure(failInitializationAt, initializationPhase);

    initializationPhase = 'session';
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
    throwForcedInitializationFailure(failInitializationAt, initializationPhase);

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

      stop: cleanup,
    };
  } catch (error) {
    let cleanupError = null;
    try {
      await cleanup();
    } catch (caught) {
      cleanupError = caught;
    }
    const childPid = child?.pid ?? 'not started';
    const location = origin ? ` at ${origin}` : '';
    const reason = sanitizePhoneAppServerEvidence(errorMessage(error), process.env);
    const evidence = sanitizePhoneAppServerEvidence(logs(), process.env);
    const cleanupEvidence = cleanupError
      ? `\ncleanup error: ${sanitizePhoneAppServerEvidence(errorMessage(cleanupError), process.env)}`
      : '';
    throw new Error(
      `phone app-server ${initializationPhase} initialization failed${location} (child pid ${childPid}):`
      + ` ${reason}\nisolated server evidence:\n${evidence}${cleanupEvidence}`,
    );
  }
}

function throwForcedInitializationFailure(requestedPhase, currentPhase) {
  if (requestedPhase === currentPhase) {
    throw new Error(`forced ${currentPhase} initialization failure`);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep useful bounded diagnostics while removing caller-owned authority and
 * conventional credential shapes from failure output.
 *
 * @param {string} value
 * @param {NodeJS.ProcessEnv} callerEnvironment
 */
export function sanitizePhoneAppServerEvidence(value, callerEnvironment) {
  let sanitized = value.slice(-8_000);
  const inheritedNames = new Set(INHERITED_PLATFORM_ENVIRONMENT);
  const callerValues = Object.entries(callerEnvironment)
    .filter(([name, candidate]) => (
      !inheritedNames.has(name)
      && candidate
      && (
        candidate.length >= 8
        || isSensitivePhoneAppServerEnvironmentName(name)
      )
    ))
    .map(([, candidate]) => candidate)
    .sort((left, right) => right.length - left.length);
  for (const candidate of callerValues) sanitized = sanitized.replaceAll(candidate, '[redacted]');
  sanitized = sanitized
    .replace(/((?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [redacted]');
  return sanitized.trim() || '(no server output captured)';
}

function isSensitivePhoneAppServerEnvironmentName(name) {
  return /^(?:TESSERA|CODEX|CLAUDE|OPENCODE)_/u.test(name)
    || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|WEBHOOK)(?:_|$)/iu.test(name);
}

async function cleanupPhoneAppServerResources({ child, dataDir, fixtureDir }) {
  const failures = [];
  try {
    await stopPhoneAppServerChild(child);
  } catch (error) {
    failures.push(error);
  }
  for (const ownedPath of [dataDir, fixtureDir]) {
    if (!ownedPath) continue;
    try {
      await fs.rm(ownedPath, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'fixture cleanup did not complete');
}

async function stopPhoneAppServerChild(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode === null) {
      await run('taskkill', ['/pid', String(child.pid), '/t', '/f'])
        .catch(() => child.kill('SIGKILL'));
    }
    if (!await waitForChildExit(child, 10_000)) {
      throw new Error(`child process tree ${child.pid} did not exit`);
    }
    return;
  }

  signalProcessGroup(child.pid, 'SIGTERM');
  if (await waitForProcessGroupExit(child.pid, 10_000)) return;
  signalProcessGroup(child.pid, 'SIGKILL');
  if (!await waitForProcessGroupExit(child.pid, 2_000)) {
    throw new Error(`child process group ${child.pid} did not exit`);
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

/** A port nothing else is on, so parallel worktrees never meet on one. */
async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const selected = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return selected;
}
