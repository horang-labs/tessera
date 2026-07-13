import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const appUrl = process.env.TESSERA_E2E_APP_URL ?? 'http://127.0.0.1:3191/chat';
const workspaceRoot = process.env.TESSERA_E2E_WORKSPACE_ROOT ?? process.cwd();
const screenshotPath = process.env.TESSERA_E2E_SCREENSHOT
  ?? '/tmp/tessera-claude-task-todo-success.png';
const completedScreenshotPath = process.env.TESSERA_E2E_COMPLETED_SCREENSHOT
  ?? '/tmp/tessera-claude-task-todo-completed.png';
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
  let settingsConfigured = false;

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
    settingsConfigured = true;

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

    const input = page.locator(`textarea[data-session-input=${JSON.stringify(created.sessionId)}]:visible`);
    await input.waitFor({ timeout: 30_000 });
    await input.fill('Create and complete a visible task checklist');
    await input.press('Enter');

    let activePanel = page.locator('[role="tabpanel"]:visible');
    let todoBar = activePanel.getByTestId('todo-status-bar');
    await todoBar.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => (
      document.querySelectorAll('[data-testid="todo-status-bar"] [data-status="pending"]').length === 3
    ), undefined, { timeout: 10_000 });
    for (const subject of [
      'Inspect Claude task events',
      'Translate tasks into todos',
      'Verify the checklist UI',
    ]) {
      await todoBar.getByText(subject).waitFor({ timeout: 10_000 });
    }

    await todoBar.getByText('Inspecting Claude task events').waitFor({ timeout: 10_000 });
    await todoBar.locator('[data-status="in_progress"]').waitFor({ timeout: 10_000 });

    // A full reload exercises the history projection while tool outputs remain lazy.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('chat-layout').waitFor({ timeout: 30_000 });
    await page.getByTestId(`collection-chat-${created.sessionId}`).first().click();
    activePanel = page.locator('[role="tabpanel"]:visible');
    todoBar = activePanel.getByTestId('todo-status-bar');
    await todoBar.getByText('Inspecting Claude task events').waitFor({ timeout: 10_000 });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // A partial completion stays visible because other tasks are still active.
    await todoBar.locator('[data-status="completed"]').first().waitFor({ timeout: 20_000 });
    await todoBar.waitFor({ state: 'visible' });

    await activePanel.getByText('Task checklist verified.').waitFor({ timeout: 30_000 });
    await todoBar.waitFor({ state: 'hidden', timeout: 10_000 });

    // Existing tool rows and the structured detail panel continue to work.
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

    await page.screenshot({ path: completedScreenshotPath, fullPage: true });
    process.stdout.write(JSON.stringify({
      screenshotPath,
      completedScreenshotPath,
      sessionId: created.sessionId,
    }, null, 2) + '\n');
  } catch (error) {
    await page.screenshot({ path: '/tmp/tessera-claude-task-todo-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (createdSessionId) {
      await expectOk(
        await page.request.delete(apiUrl(`/api/sessions/${encodeURIComponent(createdSessionId)}`)),
        'delete E2E session',
      );
    }
    if (settingsConfigured) {
      const latest = await expectOk(await page.request.get(apiUrl('/api/settings')), 'read cleanup settings');
      const cliCommandOverrides = { ...(latest.settings.cliCommandOverrides ?? {}) };
      if (originalClaudeOverride === undefined) delete cliCommandOverrides['claude-code'];
      else cliCommandOverrides['claude-code'] = originalClaudeOverride;
      await expectOk(await page.request.put(apiUrl('/api/settings'), {
        data: { ...latest.settings, cliCommandOverrides },
      }), 'restore settings');
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
