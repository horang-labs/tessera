import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const appUrl = process.env.TESSERA_E2E_APP_URL ?? 'http://127.0.0.1:3191/chat';
const workspaceRoot = process.env.TESSERA_E2E_WORKSPACE_ROOT ?? process.cwd();
const screenshotPath = process.env.TESSERA_E2E_SCREENSHOT
  ?? '/tmp/tessera-claude-task-todo-success.png';
const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/mock-claude-task-cli.mjs',
);

function apiUrl(pathname) {
  return new URL(pathname, appUrl).toString();
}

async function expectOk(response, label) {
  if (!response.ok()) throw new Error(`${label} failed: ${response.status()} ${await response.text()}`);
  return response.json();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let createdSessionId;
  let originalClaudeOverride;

  try {
    await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByTestId('chat-layout').waitFor({ timeout: 30_000 });

    const current = await expectOk(await page.request.get(apiUrl('/api/settings')), 'read settings');
    originalClaudeOverride = current.settings.cliCommandOverrides?.['claude-code'];
    await expectOk(await page.request.put(apiUrl('/api/settings'), {
      data: {
        ...current.settings,
        cliCommandOverrides: {
          ...(current.settings.cliCommandOverrides ?? {}),
          'claude-code': { native: fixturePath },
        },
      },
    }), 'configure mock Claude');

    const created = await expectOk(await page.request.post(apiUrl('/api/sessions'), {
      data: {
        workDir: workspaceRoot,
        title: 'Claude Task todo E2E',
        hasCustomTitle: true,
        providerId: 'claude-code',
      },
    }), 'create session');
    createdSessionId = created.sessionId;

    await page.reload({ waitUntil: 'domcontentloaded' });
    const sidebarRow = page.getByTestId(`collection-chat-${created.sessionId}`).first();
    await sidebarRow.waitFor({ timeout: 30_000 });
    await sidebarRow.click();

    const input = page.locator(`textarea[data-session-input=${JSON.stringify(created.sessionId)}]`);
    await input.waitFor({ timeout: 30_000 });
    await input.fill('Create and complete a visible task checklist');
    await input.press('Enter');

    const activePanel = page.locator('[role="tabpanel"]:visible');
    await activePanel.getByText('Task checklist verified.').waitFor({ timeout: 30_000 });
    await activePanel.getByTestId('tool-call-summary-bar').last().click();
    const lastUpdate = activePanel.getByTestId('tool-call-row-TaskUpdate').last();
    await lastUpdate.click();
    const detail = page.getByTestId('tool-detail-panel');
    await detail.getByText('3 done').waitFor({ timeout: 10_000 });
    await detail.getByText('3 total').waitFor({ timeout: 10_000 });
    for (const subject of [
      'Inspect Claude task events',
      'Translate tasks into todos',
      'Verify the checklist UI',
    ]) {
      await detail.getByText(subject).waitFor({ timeout: 10_000 });
    }

    await page.screenshot({ path: screenshotPath, fullPage: true });
    process.stdout.write(JSON.stringify({ screenshotPath, sessionId: created.sessionId }, null, 2) + '\n');
  } catch (error) {
    await page.screenshot({ path: '/tmp/tessera-claude-task-todo-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (createdSessionId) {
      await page.request.delete(apiUrl(`/api/sessions/${encodeURIComponent(createdSessionId)}`)).catch(() => {});
    }
    const latest = await page.request.get(apiUrl('/api/settings')).then(expectOk).catch(() => undefined);
    if (latest?.settings) {
      const cliCommandOverrides = { ...(latest.settings.cliCommandOverrides ?? {}) };
      if (originalClaudeOverride === undefined) delete cliCommandOverrides['claude-code'];
      else cliCommandOverrides['claude-code'] = originalClaudeOverride;
      await page.request.put(apiUrl('/api/settings'), {
        data: { ...latest.settings, cliCommandOverrides },
      }).catch(() => {});
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
