import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const appUrl = process.env.TESSERA_E2E_APP_URL
  ?? 'http://127.0.0.1:3100/dev-codex-skills-repro';
const beforeScreenshot = process.env.TESSERA_E2E_BEFORE_SCREENSHOT;
const afterScreenshot = process.env.TESSERA_E2E_AFTER_SCREENSHOT;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let requestCount = 0;
const pageErrors = [];
page.on('pageerror', (error) => {
  pageErrors.push(error.message);
});

try {
  await page.route('**/api/sessions/codex-skills-browser-repro/skills', async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Skill discovery is not ready',
          retryable: true,
        }),
      });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        skills: [{
          name: 'ask-matt',
          description: 'Route work through the Ask Matt workflow',
        }],
      }),
    });
  });

  await page.goto(appUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.getByTestId('codex-skills-repro').waitFor({ timeout: 30_000 });
  await page.getByTestId('codex-skills-state').filter({ hasText: 'loading' }).waitFor();

  if (beforeScreenshot) {
    await page.screenshot({ path: beforeScreenshot, fullPage: true });
  }

  await page.getByRole('option', { name: /ask-matt/ }).waitFor({ timeout: 15_000 });
  assert.equal(
    await page.getByTestId('codex-skills-state').textContent(),
    'ready',
  );
  assert.equal(
    await page.getByText('No skills available').count(),
    0,
  );
  assert.ok(requestCount >= 2, 'the browser must retry after the initial 503');
  assert.deepEqual(pageErrors, [], 'the recovery flow must not raise browser errors');

  if (afterScreenshot) {
    await page.screenshot({ path: afterScreenshot, fullPage: true });
  }

  console.log(JSON.stringify({
    appUrl,
    requestCount,
    finalState: await page.getByTestId('codex-skills-state').textContent(),
    visibleSkill: await page.getByRole('option', { name: /ask-matt/ }).textContent(),
  }, null, 2));
} finally {
  await browser.close();
}
