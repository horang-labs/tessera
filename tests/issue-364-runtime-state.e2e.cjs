#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const option = (name) => {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix}<value>`);
  return value;
};

async function main() {
  const repo = option('repo');
  const cdp = option('cdp');
  const evidence = option('evidence');
  const label = option('label');
  const action = option('action');
  const { chromium } = require(path.join(repo, 'node_modules', '@playwright', 'test'));
  const browser = await chromium.connectOverCDP(cdp);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  const api = (url, init = {}) => page.evaluate(async ({ url, init }) => {
    const response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    });
    return { status: response.status, body: await response.json() };
  }, { url, init });
  const openSettings = async () => {
    await page.goto(new URL('/', page.url()).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    await page.getByRole('button', { name: /settings/i }).first().click();
    await page.getByRole('button', { name: /development/i }).click();
    await page.getByTestId('tessera-cli-skill-setup').waitFor({ state: 'visible' });
  };
  const result = { label, action };
  if (action === 'capture') {
    await openSettings();
    result.lifecycle = await api('/api/provider-integrations/codex/lifecycle');
    result.skill = await api('/api/provider-integrations/tessera-cli');
    const skillPanel = page.getByTestId('tessera-cli-skill-setup');
    result.skillText = await skillPanel.innerText();
    await skillPanel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `${label}.png`) });
  } else if (action === 'recheck') {
    await openSettings();
    await page.getByRole('button', { name: 'Re-check skill' }).click();
    await page.waitForTimeout(3000);
    result.skill = await api('/api/provider-integrations/tessera-cli');
    await page.getByTestId('tessera-cli-skill-setup').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `${label}.png`) });
  } else if (action === 'remove') {
    result.before = await api('/api/provider-integrations/tessera-cli');
    result.after = await api('/api/provider-integrations/tessera-cli', {
      method: 'POST',
      body: JSON.stringify({ operation: 'remove', expectedAgentEnvironment: result.before.body.agentEnvironment }),
    });
    await openSettings();
    await page.screenshot({ path: path.join(evidence, `${label}.png`) });
  } else if (action === 'toggle') {
    await openSettings();
    const toggle = page.getByTestId('codex-lifecycle-toggle');
    await page.waitForFunction(() => !document.querySelector('[data-testid="codex-lifecycle-toggle"]')?.disabled);
    await toggle.click();
    await page.waitForTimeout(4000);
    result.lifecycle = await api('/api/provider-integrations/codex/lifecycle');
    await page.getByTestId('codex-lifecycle-settings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `${label}.png`) });
  } else if (action === 'recovery') {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const title = page.getByText('Issue 364 structured recovery', { exact: true }).last();
    await title.click();
    const recovery = page.getByTestId('provider-integration-recovery');
    await recovery.waitFor({ state: 'visible', timeout: 30000 });
    result.lifecycle = await api('/api/provider-integrations/codex/lifecycle');
    result.recoveryText = await recovery.innerText();
    await page.screenshot({ path: path.join(evidence, `${label}.png`) });
  } else if (action === 'retry-recovery') {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Issue 364 structured recovery', { exact: true }).last().click();
    const recovery = page.getByTestId('provider-integration-recovery');
    await recovery.waitFor({ state: 'visible', timeout: 30000 });
    await recovery.getByRole('button', { name: /retry setup/i }).click();
    await page.waitForFunction(() => /issue-364 forced|operation not permitted/i.test(document.querySelector('[data-testid="provider-integration-recovery"]')?.textContent || ''), null, { timeout: 60000 });
    result.lifecycle = await api('/api/provider-integrations/codex/lifecycle');
    result.recoveryText = await recovery.innerText();
    await page.screenshot({ path: path.join(evidence, `${label}.png`) });
  } else if (action === 'new-recovery') {
    const workDir = option('work-dir');
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ folderPath: workDir }) });
    const title = `Issue 364 ${label}`;
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({
      workDir: project.body.projectId, parentProjectId: project.body.projectId, title,
      hasCustomTitle: true, providerId: 'codex', executionMode: 'pty', model: 'gpt-5.6-sol',
      reasoningEffort: 'low', sessionMode: 'work', accessMode: 'fullAccess',
    }) });
    result.sessionId = created.body.sessionId;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(title, { exact: true }).last().click();
    const recovery = page.getByTestId('provider-integration-recovery');
    await recovery.waitFor({ state: 'visible', timeout: 60000 });
    result.lifecycle = await api('/api/provider-integrations/codex/lifecycle');
    result.recoveryText = await recovery.innerText();
    await page.screenshot({ path: path.join(evidence, `${label}.png`) });
  } else if (action === 'enable-hooks') {
    result.update = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ codexLifecycleHooksEnabled: true }) });
    result.reconcile = await api('/api/provider-integrations/codex/lifecycle', { method: 'POST', body: JSON.stringify({ operation: 'reconcile' }) });
    await openSettings();
    await page.getByTestId('codex-lifecycle-settings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `${label}.png`) });
  } else if (action === 'provider-launch') {
    const workDir = option('work-dir');
    const providerId = option('provider');
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ folderPath: workDir }) });
    const title = `Issue 364 ${label}`;
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({
      workDir: project.body.projectId, parentProjectId: project.body.projectId, title,
      hasCustomTitle: true, providerId, executionMode: 'pty', model: providerId === 'claude-code' ? 'sonnet' : null,
      reasoningEffort: 'low', sessionMode: 'work', accessMode: 'fullAccess',
    }) });
    result.sessionId = created.body.sessionId;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(title, { exact: true }).last().click();
    await page.getByText('Connecting terminal...', { exact: true }).waitFor({ state: 'hidden', timeout: 60000 });
    await page.locator('.xterm-helper-textarea').last().waitFor({ state: 'attached', timeout: 60000 });
    result.terminalVisible = true;
    result.lifecycle = await api('/api/provider-integrations/codex/lifecycle');
    await page.screenshot({ path: path.join(evidence, `${label}.png`) });
    await page.evaluate((sessionId) => new Promise((resolve) => {
      const socket = new WebSocket(`ws://${location.host}/ws`);
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'terminal_close', requestId: `${sessionId}-close`, terminalId: `session-${sessionId}` }));
        setTimeout(() => { socket.close(); resolve(); }, 1000);
      };
    }), result.sessionId);
  } else if (action === 'onboarding') {
    const workDir = option('work-dir');
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ folderPath: workDir }) });
    const title = `Issue 364 ${label}`;
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({
      workDir: project.body.projectId, parentProjectId: project.body.projectId, title,
      hasCustomTitle: true, providerId: 'codex', executionMode: 'pty', model: 'gpt-5.6-sol',
      reasoningEffort: 'low', sessionMode: 'work', accessMode: 'fullAccess',
    }) });
    result.sessionId = created.body.sessionId;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(title, { exact: true }).last().click();
    const dialog = page.getByTestId('tessera-cli-skill-onboarding');
    await dialog.waitFor({ state: 'visible', timeout: 60000 });
    await dialog.getByRole('button', { name: /set up|retry/i }).click();
    await dialog.getByTestId('tessera-cli-skill-terminal').waitFor({ state: 'visible' });
    await page.waitForTimeout(3000);
    result.onboardingText = await dialog.innerText();
    await page.screenshot({ path: path.join(evidence, `${label}.png`) });
  } else if (action === 'close-terminal') {
    const terminalId = option('terminal-id');
    await page.evaluate((terminalId) => new Promise((resolve) => {
      const socket = new WebSocket(`ws://${location.host}/ws`);
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'terminal_close', requestId: `${terminalId}-close`, terminalId }));
        setTimeout(() => { socket.close(); resolve(); }, 1000);
      };
    }), terminalId);
    result.terminalId = terminalId;
  } else {
    throw new Error(`Unknown action ${action}`);
  }
  result.settings = await api('/api/settings');
  fs.writeFileSync(path.join(evidence, `${label}.json`), JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
