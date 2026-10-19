/** Real CLI compatibility gate. Uses a disposable home and a loopback Responses server. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Terminal } from '@xterm/headless';
import * as pty from 'node-pty';
import { createCodexOverlay, cleanupCodexOverlayForTerminal } from '../../src/lib/terminal/codex-overlay';
import { buildProviderTerminalLaunch } from '../../src/lib/terminal/provider-launch';

const tempParent = path.join(os.homedir(), 'tmp');
fs.mkdirSync(tempParent, { recursive: true });
const root = fs.mkdtempSync(path.join(tempParent, 'tessera-codex-compat-'));
const evidence = path.resolve(process.env.CODEX_COMPAT_EVIDENCE ?? '.tmp/codex-compat');
const executable = process.env.CODEX_COMPAT_COMMAND ?? 'codex';
// npm's cross-platform JS entry avoids invoking .cmd through ConPTY on Windows.
const prefix = process.env.CODEX_COMPAT_JS ? [path.resolve(process.env.CODEX_COMPAT_JS)] : [];
const command = prefix.length ? process.execPath : executable;
const account = path.join(root, 'account');
const workspace = path.join(root, 'workspace-한글');
const terminalId = 'compat-terminal';
const oldCodexHome = process.env.CODEX_HOME;
const oldDataDir = process.env.TESSERA_DATA_DIR;
let child: pty.IPty | undefined;
let exited = true;
let fixtureConfigured = false;
let preserveFixture = false;
let launchEnvironment: Record<string, string> = {};
let requests = 0;
const hooks: string[] = [];
const hookCwds: string[] = [];
let log = '';
const marker = 'TESSERA_COMPAT_REPLY';
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/__tessera/hook?')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        hooks.push(event.hook_event_name);
        hookCwds.push(event.cwd);
      } catch { hooks.push('invalid-payload'); }
      res.end('{}');
    });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    req.resume(); res.writeHead(404).end(); return;
  }
  req.resume();
  requests++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const id = `compat-${requests}`;
  for (const event of [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: { id: `msg-${requests}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${marker}_${requests}` }] } },
    { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});

async function stop() {
  if (!child || exited) return;
  child.kill();
  const deadline = Date.now() + 5_000;
  while (!exited && Date.now() < deadline) await delay(50);
  assert.ok(exited, 'CLI failed to exit after its PTY was closed');
}

async function run(resumeId?: string) {
  const model = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  const launch = buildProviderTerminalLaunch({ providerId: 'codex', sessionId: 'compat', resume: Boolean(resumeId), codexResumeId: resumeId, ...(!resumeId ? { initialPrompt: 'Return a short greeting.' } : {}) });
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL', 'TMP', 'TEMP', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  Object.assign(env, { HOME: root, USERPROFILE: root, CODEX_HOME: overlay, TERM: 'xterm-256color', TESSERA_HOOK_PORT: String(port), TESSERA_PANE_TOKEN: 'compat-fixture', TESSERA_SESSION_ID: 'compat' });
  const expected = `${marker}_${requests + 1}`;
  const hookStart = hooks.length;
  launchEnvironment = env;
  try {
    child = pty.spawn(command, [...prefix, ...launch.args], { cwd: workspace, cols: 120, rows: 40, name: 'xterm-256color', env });
    exited = false;
    model.onData(data => { if (!exited) child?.write(data); });
    child.onData(data => { log = (log + data).slice(-256_000); model.write(data); });
    child.onExit(event => { log += `\nEXIT ${event.exitCode}\n`; exited = true; });
    const deadline = Date.now() + 45_000;
    let submitted = !resumeId;
    while (Date.now() < deadline) {
      assert.ok(!exited, `Codex exited before responding; inspect ${evidence}`);
      const buffer = model.buffer.active;
      const screen = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\n');
      fs.writeFileSync(path.join(evidence, 'last-screen.txt'), screen);
      if (screen.includes(expected)
        && ['SessionStart', 'UserPromptSubmit', 'Stop'].every(event => hooks.slice(hookStart).includes(event))) {
        fs.writeFileSync(path.join(evidence, resumeId ? 'resume.txt' : 'fresh.txt'), screen);
        return;
      }
      if (!submitted && screen.includes(`${marker}_1`) && screen.includes('? for shortcuts')) {
        // Allow the restored composer's first frame to settle before typing.
        await delay(300);
        child.write('Return another short greeting.');
        await delay(200);
        child.write('\r');
        submitted = true;
      }
      await delay(100);
    }
    throw Error(`Timed out waiting for ${expected}; inspect ${evidence}`);
  } finally {
    try {
      await stop();
      assert.equal(fs.existsSync(path.join(overlay, 'app-server-daemon')), false,
        'Codex created daemon state despite the PTY-owned runtime policy');
    } finally { model.dispose(); }
  }
}

function rolloutId(dir: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = rolloutId(file); if (found) return found; }
    else if (entry.name.endsWith('.jsonl')) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'session_meta') return event.payload.id;
      }
    }
  }
}

let overlay = '';
let port = 0;
async function main() {
  process.env.CODEX_HOME = account;
  process.env.TESSERA_DATA_DIR = path.join(root, 'data');
  fixtureConfigured = true;
  fs.mkdirSync(evidence, { recursive: true });
  fs.rmSync(path.join(evidence, 'result.json'), { force: true });
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(account, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(account, 'app-server-daemon'), { mode: 0o700 });
  fs.writeFileSync(path.join(account, 'app-server-daemon', 'account-owner'), 'must survive');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  const config = [
    'model = "compat-model"', 'model_provider = "compat"',
    'check_for_update_on_startup = false', 'approval_policy = "never"',
    // The fixture never returns tool calls; no native Windows sandbox setup is needed.
    'sandbox_mode = "danger-full-access"',
    // A fresh Codex home otherwise downloads marketplace plugins in the
    // background. This fixture exercises local responses/hooks, not plugins;
    // remote clones can outlive the PTY and hold Windows cleanup locks.
    '[features]', 'plugins = false',
    '[model_providers.compat]', 'name = "Compatibility fixture"',
    `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"',
    `[projects.${JSON.stringify(workspace.replaceAll('\\', '/'))}]`, 'trust_level = "trusted"',
  ].join('\n');
  fs.writeFileSync(path.join(account, 'config.toml'), config);
  const version = execFileSync(command, [...prefix, '--version'], { encoding: 'utf8' }).trim();
  console.log(`Testing ${version} on ${process.platform}`);
  fs.writeFileSync(path.join(evidence, 'version.json'), JSON.stringify({ version, platform: process.platform }));
  overlay = createCodexOverlay(terminalId, process.platform === 'win32' ? 'windows-cmd' : 'posix', false);
  await run();
  const id = rolloutId(path.join(account, 'sessions'));
  assert.ok(id, 'new session did not persist resumable history in the account home');
  cleanupCodexOverlayForTerminal(terminalId);
  overlay = createCodexOverlay(terminalId, process.platform === 'win32' ? 'windows-cmd' : 'posix', false);
  await run(id);
  assert.ok(hookCwds.length >= 6 && hookCwds.every(cwd => cwd === workspace),
    'hook JSON must preserve the Unicode workspace path on every event');
  assert.ok(requests >= 2, 'fresh and resumed turns must both reach the local provider');
  assert.equal(fs.readFileSync(path.join(account, 'app-server-daemon', 'account-owner'), 'utf8'), 'must survive');
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ version, platform: process.platform, requests, hooks, unicodeHookPaths: true, passed: true }, null, 2));
  console.log('PASS: fresh response, shared history, stop, recreated overlay, resume response');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    await stop();
    if (overlay && fs.existsSync(path.join(overlay, 'app-server-daemon'))) {
      // Only this isolated fixture's daemon may be stopped. Preserve its state if
      // a future CLI changes the shutdown contract; never orphan it by deletion.
      preserveFixture = true;
      execFileSync(command, [...prefix, 'app-server', 'daemon', 'stop'], {
        env: launchEnvironment, timeout: 10_000, stdio: 'pipe',
      });
      preserveFixture = false;
    }
  } catch (error) {
    preserveFixture = true;
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'terminal.log'), log);
      fs.writeFileSync(path.join(evidence, 'hooks.json'), JSON.stringify(hooks));
      if (process.exitCode && overlay && fs.existsSync(overlay)) {
        const diagnostics = path.join(evidence, 'fixture');
        fs.mkdirSync(diagnostics, { recursive: true });
        for (const name of fs.readdirSync(overlay)) {
          if (/^logs_.*\.sqlite(?:-wal|-shm)?$/.test(name) || ['config.toml', 'hooks.json'].includes(name)) {
            fs.copyFileSync(path.join(overlay, name), path.join(diagnostics, name));
          }
        }
      }
      const logs = path.join(overlay, 'log');
      if (overlay && fs.existsSync(logs)) fs.cpSync(logs, path.join(evidence, 'codex-log'), { recursive: true });
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally {
      server.closeAllConnections();
      server.close();
      try {
        if (!preserveFixture) {
          if (fixtureConfigured) cleanupCodexOverlayForTerminal(terminalId);
          fs.rmSync(root, { recursive: true, force: true });
        } else console.error(`Fixture retained for owned runtime cleanup: ${root}`);
      } finally {
        if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
        if (oldDataDir === undefined) delete process.env.TESSERA_DATA_DIR; else process.env.TESSERA_DATA_DIR = oldDataDir;
      }
    }
  }
});
