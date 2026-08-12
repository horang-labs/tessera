#!/usr/bin/env node

const path = require('node:path');

const option = (name) => {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix}<value>`);
  return value;
};
const optional = (name) => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function main() {
  const repo = option('repo');
  const cdp = option('cdp');
  const phase = option('phase');
  const evidence = option('evidence');
  const workDir = option('work-dir');
  const { chromium } = require(path.join(repo, 'node_modules', '@playwright', 'test'));
  const browser = await chromium.connectOverCDP(cdp);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  assert(page, 'Electron renderer was not available');
  await page.waitForLoadState('domcontentloaded');

  const api = async (url, init = {}, expected = 200) => {
    const result = await page.evaluate(async ({ url, init }) => {
      const response = await fetch(url, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      });
      return { status: response.status, body: await response.json() };
    }, { url, init });
    assert(result.status === expected, `${url}: ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  };

  const configure = async () => {
    const settings = await api('/api/settings');
    assert(settings.serverHostInfo.platform === 'win32', 'Backend is not Windows');
    if (settings.settings.agentEnvironment !== 'wsl' || !settings.settings.setup?.completedAt) {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          agentEnvironment: 'wsl',
          setup: { dismissedAt: null, completedAt: new Date().toISOString() },
        }),
      });
    }
    let lifecycle;
    for (let i = 0; i < 80; i += 1) {
      lifecycle = await api('/api/provider-integrations/codex/lifecycle');
      if (lifecycle.health.state === 'healthy') break;
      await page.waitForTimeout(500);
    }
    assert(lifecycle.health.state === 'healthy', `Hook preflight failed: ${JSON.stringify(lifecycle)}`);
    return lifecycle;
  };

  const createSession = async (title) => {
    const project = await api('/api/projects', {
      method: 'POST', body: JSON.stringify({ folderPath: workDir }),
    });
    const created = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        workDir: project.projectId,
        parentProjectId: project.projectId,
        title,
        hasCustomTitle: true,
        providerId: 'codex',
        executionMode: 'pty',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'low',
        sessionMode: 'work',
        accessMode: 'fullAccess',
      }),
    }, 201);
    return created.sessionId;
  };

  const launch = async (sessionId, prompt, existingTerminalId) => page.evaluate(async ({ sessionId, prompt, existingTerminalId }) => (
    new Promise((resolve, reject) => {
      const terminalId = existingTerminalId || `issue364-${Date.now()}`;
      const surfaceId = `surface-${Date.now()}`;
      const socket = new WebSocket(`ws://${location.host}/ws`);
      const messages = [];
      let output = '';
      let sent = false;
      const timer = setTimeout(() => reject(new Error(JSON.stringify({ messages, output: output.slice(-8000) }))), 150000);
      socket.onopen = () => socket.send(JSON.stringify({
        type: 'terminal_create', requestId: terminalId, terminalId, surfaceId,
        launch: { providerId: 'codex', sessionId }, cols: 120, rows: 35,
      }));
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        messages.push(message);
        if (message.type === 'terminal_output' && sent) output += message.data;
        if (message.type === 'provider_integration_launch_blocked') {
          clearTimeout(timer); socket.close(); resolve({ blocked: message, output, messages });
        }
        if (message.type === 'terminal_started' && !sent && prompt) {
          sent = true;
          setTimeout(() => {
            socket.send(JSON.stringify({
            type: 'terminal_input', requestId: `${terminalId}-input`, terminalId,
            surfaceId, data: `\u0015${prompt}`,
            }));
            setTimeout(() => socket.send(JSON.stringify({
              type: 'terminal_input', requestId: `${terminalId}-submit`, terminalId,
              surfaceId, data: '\r',
            })), 500);
          }, 5000);
        }
        if (sent && message.type === 'session_state' && message.preview?.includes('T364_RESPONSE_OK')) {
          clearTimeout(timer); socket.close(); resolve({ output, messages });
        }
      };
      socket.onerror = () => reject(new Error('WebSocket failed'));
    })
  ), { sessionId, prompt, existingTerminalId });

  const result = {
    phase,
    lifecycle: phase === 'blocked'
      ? await api('/api/provider-integrations/codex/lifecycle')
      : await configure(),
    url: page.url(),
  };
  if (phase === 'core' || phase === 'exchange-existing') {
    if (phase === 'exchange-existing') {
      result.exchange = await launch(option('session-id'), 'Reply with exactly T364_RESPONSE_OK and nothing else.', option('terminal-id'));
      assert(result.exchange.messages.some((message) => message.type === 'session_state' && message.preview?.includes('T364_RESPONSE_OK')), 'No real Codex response');
    } else {
    const sessionId = await createSession('Issue 364 real Codex exchange');
    result.exchange = await launch(sessionId, 'Reply with exactly T364_RESPONSE_OK and nothing else.');
    assert(result.exchange.messages.some((message) => message.type === 'session_state' && message.preview?.includes('T364_RESPONSE_OK')), 'No real Codex response');
    }
  }
  if (phase === 'skill') {
    await createSession('Issue 364 skill setup context');
    await page.goto(new URL('/', page.url()).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);
    await page.getByRole('button', { name: /settings/i }).first().click();
    await page.getByRole('button', { name: /development/i }).click();
    const panel = page.getByTestId('tessera-cli-skill-setup');
    await panel.waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(evidence, 'skill-before.png') });
    const setup = panel.getByRole('button', { name: /set up|update|retry setup/i }).first();
    if (await setup.isVisible().catch(() => false)) {
      await setup.click();
      const textarea = page.getByTestId('tessera-cli-skill-terminal').locator('textarea');
      await textarea.waitFor({ state: 'visible' });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(evidence, 'skill-command-preloaded.png') });
      await textarea.press('Enter');
      await page.waitForTimeout(8000);
      await textarea.press('Enter');
      await page.waitForTimeout(1000);
      await textarea.press('Enter');
      await page.waitForTimeout(1000);
      await textarea.press('ArrowRight');
      await textarea.press('Enter');
      await page.waitForFunction(() => {
        const state = document.querySelector('[data-testid="tessera-cli-skill-setup"]')?.getAttribute('data-state');
        return state === 'installed' || state === 'update-available';
      }, null, { timeout: 150000 });
    }
    result.skill = await api('/api/provider-integrations/tessera-cli');
    await page.screenshot({ path: path.join(evidence, 'skill-after.png') });
  }
  if (phase === 'blocked') {
    const title = 'Issue 364 structured recovery';
    const sessionId = await createSession(title);
    result.launch = await launch(sessionId, '');
    assert(result.launch.blocked?.type === 'provider_integration_launch_blocked', 'No structured block');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(title, { exact: true }).first().click();
    await page.getByTestId('provider-integration-recovery').waitFor({ state: 'visible', timeout: 30000 });
    await page.screenshot({ path: path.join(evidence, 'structured-recovery.png') });
  }
  require('node:fs').writeFileSync(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
