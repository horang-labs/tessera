// Regression coverage for two phone-only layout collisions reported together:
// the project strip painted only 32px of the 44px column reserved for it, and
// bottom-anchored toasts covered the chat composer.
import assert from 'node:assert/strict';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { createPhoneContext } from './helpers/phone-viewport.mjs';
import { startPhoneAppServer } from './helpers/phone-app-server.mjs';

const app = await startPhoneAppServer({ name: 'rail-toast-placement' });
let browser;

try {
  browser = await launchPhoneBrowser();

  const conversation = await openConversation();
  const rail = await measureProjectRail(conversation.page);
  const composer = await conversation.page.getByTestId('message-input-row').boundingBox();

  const toastPage = await openPageWithInjectedNotification();
  const toast = await toastPage.page.getByTestId('toast-container').boundingBox();
  const desktopToastPage = await openPageWithInjectedNotification({ phone: false });
  const desktopToast = await desktopToastPage.page.getByTestId('toast-container').boundingBox();

  const failures = [];
  if (!rail.container || !rail.surface) {
    failures.push('the project rail and its reserved column must both be measurable');
  } else if (Math.abs(rail.container.width - rail.surface.width) > 0.5) {
    failures.push(
      `the project rail must paint the full reserved phone column`
      + ` (surface ${Math.round(rail.surface.width)}px, column ${Math.round(rail.container.width)}px)`,
    );
  } else if (Math.abs(rail.container.width - 32) > 0.5) {
    failures.push(
      `the compact phone rail must keep its 32px width (measured ${Math.round(rail.container.width)}px)`,
    );
  }

  if (!toast || !composer) {
    failures.push('the toast and chat composer must both be measurable');
  } else {
    if (toast.y > 24) {
      failures.push(`the phone toast must be anchored at the top (measured top ${Math.round(toast.y)}px)`);
    }
    if (toast.y + toast.height > composer.y) {
      failures.push(
        `the phone toast must not cover the composer`
        + ` (toast bottom ${Math.round(toast.y + toast.height)}px, composer top ${Math.round(composer.y)}px)`,
      );
    }
  }

  if (!desktopToast) {
    failures.push('the desktop toast must be measurable');
  } else if (Math.abs(desktopToast.y + desktopToast.height - 880) > 0.5) {
    failures.push(
      `the desktop toast must keep its 20px bottom offset`
      + ` (measured bottom ${Math.round(900 - desktopToast.y - desktopToast.height)}px)`,
    );
  }

  assert.deepEqual(failures, []);
  console.log(
    `ok — project rail fills ${Math.round(rail.container.width)}px and phone toast ends at`
    + ` ${Math.round(toast.y + toast.height)}px above composer at ${Math.round(composer.y)}px`,
  );

  await desktopToastPage.context.close();
  await toastPage.context.close();
  await conversation.context.close();
} finally {
  await browser?.close().catch(() => undefined);
  await app.stop();
}

async function openConversation() {
  const context = await createPhoneContext(browser, {
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  });
  const page = await app.preparePage(context);
  await page.goto(`${app.origin}/chat`, { waitUntil: 'load', timeout: 90_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 90_000 });

  await page.locator(`[data-testid="project-strip-${app.projectDir}"]`).click();
  const expand = page.getByTestId('tab-bar-sidebar-toggle');
  await page.waitForTimeout(500);
  if (await expand.isVisible().catch(() => false)) await expand.click();

  const session = page.locator(`[data-testid="collection-chat-${app.sessionId}"]`).first();
  await session.waitFor({ state: 'visible', timeout: 30_000 });
  await session.click();

  const collapse = page.getByTestId('sidebar-collapse-btn');
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  await page.getByTestId('message-input-row').waitFor({ state: 'visible', timeout: 30_000 });
  return { context, page };
}

async function measureProjectRail(page) {
  return page.evaluate(() => {
    const container = document.querySelector('[data-testid="left-panel-container"]');
    const surface = document.querySelector('[data-testid="project-strip-scroll-area"]')?.parentElement;
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    };
    return { container: box(container), surface: box(surface) };
  });
}

async function openPageWithInjectedNotification({ phone = true } = {}) {
  const contextOptions = {
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  };
  const context = phone
    ? await createPhoneContext(browser, contextOptions)
    : await browser.newContext({ ...contextOptions, viewport: { width: 1280, height: 900 } });
  const page = await app.preparePage(context);
  let socket = null;
  await page.routeWebSocket(/\/ws(\?|$)/, (route) => {
    socket = route;
  });

  await page.goto(`${app.origin}/chat`, { waitUntil: 'load', timeout: 90_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 90_000 });
  for (let attempt = 0; !socket && attempt < 50; attempt += 1) {
    await page.waitForTimeout(100);
  }
  assert.ok(socket, 'the app should open its notification WebSocket');

  socket.send(JSON.stringify({
    type: 'notification',
    sessionId: app.sessionId,
    event: 'input_required',
    message: 'Waiting for input',
    preview: 'A session needs an answer before it can continue',
  }));
  await page.getByTestId('toast-notification').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  return { context, page };
}
