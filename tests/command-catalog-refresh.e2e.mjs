import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const url = process.env.TESSERA_E2E_APP_URL ?? 'http://127.0.0.1:3100/dev-command-catalog-repro';
const screenshots = process.env.TESSERA_E2E_SCREENSHOT_DIR ?? 'tmp/command-catalog-qa';
const catalog = process.env.TESSERA_E2E_CATALOG
  ? JSON.parse(await readFile(process.env.TESSERA_E2E_CATALOG, 'utf8'))
  : [{ name: 'init', description: 'Initialize' }, { name: 'review', description: 'Review' }, { name: 'compact', description: 'compact the session' }];
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(5000);
async function publish(commands) {
  // Publish without a mouse click outside the picker, which would close it.
  await page.getByRole('textbox', { name: 'Reported commands' }).fill(JSON.stringify(commands));
  await page.getByRole('button', { name: 'Apply provider update' }).evaluate((button) => button.click());
  assert.deepEqual(JSON.parse(await page.getByTestId('stored-commands').textContent()), commands);
}
try {
  await page.goto(url);
  await publish(catalog.slice(0, 1));
  await page.getByRole('textbox', { name: 'Slash command' }).fill('/');
  await page.screenshot({ path: `${screenshots}/01-initial-catalog.png` });
  await publish(catalog);
  await page.screenshot({ path: `${screenshots}/02-updated-catalog.png` });
  await page.waitForFunction((count) => document.querySelectorAll('[role=option]').length === count, catalog.length, { timeout: 3000 });
  const names = await page.getByRole('option').locator('span.font-semibold').allTextContents();
  assert.deepEqual(names.map((name) => name.trim()), catalog.map((command) => `/${command.name}`));
  await page.getByRole('textbox', { name: 'Slash command' }).fill('/comp');
  await page.getByRole('option', { name: /compact/ }).waitFor();
  await page.screenshot({ path: `${screenshots}/03-compact-from-provider.png` });
  await publish(catalog.filter((command) => command.name !== 'compact'));
  await page.waitForFunction(() => ![...document.querySelectorAll('[role=option] span.font-semibold')].some((el) => el.textContent.trim() === '/compact'));
  await page.screenshot({ path: `${screenshots}/04-removed-command.png` });
  await page.getByRole('textbox', { name: 'Slash command' }).fill('/');
  await publish([]);
  await page.waitForFunction(() => document.querySelectorAll('[role=option]').length === 0);
  await page.screenshot({ path: `${screenshots}/05-empty-catalog.png` });
  await publish(catalog);
  await page.getByRole('listbox').waitFor();
  await page.getByRole('textbox', { name: 'Reported commands' }).click();
  await publish(catalog.slice(0, 1));
  assert.equal(await page.getByRole('option').count(), 0, 'catalog updates must not reopen a dismissed picker');
  await page.screenshot({ path: `${screenshots}/06-dismissed-picker.png` });
  console.log(JSON.stringify({ commands: catalog.length, addedRemovedAndEmpty: 'passed' }));
} finally {
  await browser.close();
}
