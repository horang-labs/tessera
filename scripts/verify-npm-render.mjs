import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const targetUrl = process.argv[2];

if (!targetUrl) {
  throw new Error('Usage: node scripts/verify-npm-render.mjs <url>');
}

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  const runtimeErrors = [];

  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  const response = await page.goto(targetUrl, {
    waitUntil: 'load',
    timeout: 120_000,
  });

  assert.ok(response, 'the browser did not receive a document response');
  assert.equal(response.status(), 200, `rendered page returned HTTP ${response.status()}`);
  assert.equal(new URL(page.url()).pathname, '/setup', 'fresh install did not reach setup');

  await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
  const accountForm = page.getByTestId('setup-account-form');
  await accountForm.waitFor({ state: 'visible', timeout: 30_000 });

  const rendered = await page.evaluate(() => ({
    bodyTextLength: document.body.innerText.trim().length,
    hasNextRuntime: Boolean(document.querySelector('script[src*="/_next/static/"]')),
  }));

  assert.ok(rendered.bodyTextLength > 0, 'rendered page body is empty');
  assert.ok(rendered.hasNextRuntime, 'rendered page did not load the Next.js runtime');

  const expectedAccount = {
    username: 'npm-render-smoke',
    password: 'not-created',
  };
  const expectedError = 'npm-render-smoke-hydrated';

  await page.evaluate((errorDetail) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).endsWith('/api/auth/setup') && init?.method === 'POST') {
        window.__npmRenderSmokeRequest = init.body;
        return Promise.resolve(new Response(
          JSON.stringify({ detail: errorDetail }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ));
      }
      return originalFetch(input, init);
    };
  }, expectedError);

  await accountForm.locator('input[name="username"]').fill(expectedAccount.username);
  await accountForm.locator('input[name="password"]').fill(expectedAccount.password);
  await accountForm.locator('button[type="submit"]').click();
  await page.getByRole('alert').filter({ hasText: expectedError }).waitFor();

  const submittedAccount = await page.evaluate(
    () => JSON.parse(window.__npmRenderSmokeRequest),
  );
  assert.deepEqual(submittedAccount, expectedAccount, 'hydrated form submitted wrong state');
  assert.deepEqual(runtimeErrors, [], `browser runtime errors:\n${runtimeErrors.join('\n')}`);

  console.log(
    `Rendered ${page.url()} successfully (${rendered.bodyTextLength} visible characters)`,
  );
} finally {
  await browser.close();
}
