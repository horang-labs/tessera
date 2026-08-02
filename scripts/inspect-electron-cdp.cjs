#!/usr/bin/env node

const { chromium } = require("@playwright/test");

function readArgument(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length) ?? null;
}

async function main() {
  const cdpUrl = readArgument("cdp");
  const screenshotPath = readArgument("screenshot");
  if (!cdpUrl) {
    throw new Error("Usage: inspect-electron-cdp.cjs --cdp=http://127.0.0.1:<port> [--screenshot=<windows-path>]");
  }

  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const contexts = browser.contexts();
    const pages = contexts.flatMap((context) => context.pages());
    if (pages.length === 0) {
      throw new Error(`Electron CDP endpoint has no pages: ${cdpUrl}`);
    }

    const pageResults = [];
    for (const page of pages) {
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
      await page.waitForFunction(
        () => document.body?.innerText?.trim().length > 0 && !document.body.innerText.startsWith("(self.__next_f"),
        undefined,
        { timeout: 20_000 },
      ).catch(() => {});
      pageResults.push({
        url: page.url(),
        title: await page.title(),
        readyState: await page.evaluate(() => document.readyState),
        bodyText: (await page.locator("body").innerText({ timeout: 10_000 })).slice(0, 2_000),
      });
    }

    if (screenshotPath) {
      await pages[0].screenshot({ path: screenshotPath, fullPage: false });
    }

    process.stdout.write(`${JSON.stringify({ cdpUrl, pages: pageResults, screenshotPath }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
