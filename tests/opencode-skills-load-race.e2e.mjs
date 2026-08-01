import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const appUrl = process.env.TESSERA_E2E_APP_URL
  ?? 'http://127.0.0.1:3100/dev-opencode-skills-repro';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let requestCount = 0;

try {
  await page.route('**/api/sessions/opencode-skills-browser-repro/skills', async (route) => {
    requestCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        skills: [{
          name: 'diagnosing-bugs',
          description: 'Diagnose hard bugs',
        }],
      }),
    });
  });

  await page.goto(appUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.getByTestId('opencode-skills-repro').waitFor({ timeout: 30_000 });
  await page.getByTestId('opencode-skills-state').filter({ hasText: 'loading' }).waitFor();
  await page.getByRole('option', { name: /diagnosing-bugs/ }).waitFor({ timeout: 3_000 });

  assert.equal(await page.getByTestId('opencode-skills-state').textContent(), 'ready');
  assert.equal(requestCount, 1, 'session state changes must share one in-flight request');
  console.log(JSON.stringify({ requestCount, state: 'ready' }));
} finally {
  await browser.close();
}
