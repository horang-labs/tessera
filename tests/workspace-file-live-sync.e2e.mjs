import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const appUrl = process.env.TESSERA_E2E_APP_URL ?? "http://127.0.0.1:3100/chat";
const workspaceRoot = process.env.TESSERA_E2E_WORKSPACE_ROOT ?? "/Users/rs/source/tessera";
const timeoutMs = Number(process.env.TESSERA_E2E_SYNC_TIMEOUT_MS ?? "2500");

const stamp = Date.now();
const prefix = `zz-tessera-live-sync-e2e-${stamp}`;
const originalName = `${prefix}.txt`;
const renamedName = `${prefix}-renamed.txt`;
const originalPath = path.join(workspaceRoot, originalName);
const renamedPath = path.join(workspaceRoot, renamedName);

function testIdSelector(testId) {
  return `[data-testid=${JSON.stringify(testId)}]`;
}

async function cleanup() {
  await fs.rm(originalPath, { force: true }).catch(() => {});
  await fs.rm(renamedPath, { force: true }).catch(() => {});
}

async function waitForRow(page, fileName, present) {
  const started = Date.now();
  const selector = testIdSelector(`workspace-file-row-${fileName}`);
  await page.waitForFunction(
    ({ selector, present }) => Boolean(document.querySelector(selector)) === present,
    { selector, present },
    { timeout: timeoutMs },
  );
  return Date.now() - started;
}

async function openFilesPanel(page) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 30_000 });

  if ((await page.getByPlaceholder("Search files").count()) === 0) {
    await page.getByTestId("tab-bar-git-toggle").click({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.getByRole("tab", { name: "Files" }).click({ timeout: 10_000 });
  }

  await page.getByPlaceholder("Search files").waitFor({ timeout: 30_000 });
}

async function main() {
  await cleanup();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const workspaceEvents = [];

  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("workspace_file")) {
      workspaceEvents.push(text);
    }
  });

  try {
    await openFilesPanel(page);
    await page.getByPlaceholder("Search files").fill(prefix);
    await waitForRow(page, originalName, false);
    await waitForRow(page, renamedName, false);

    const results = [];

    await fs.writeFile(originalPath, `live sync e2e ${new Date().toISOString()}\n`, "utf8");
    results.push({ op: "add", ms: await waitForRow(page, originalName, true) });

    await fs.rename(originalPath, renamedPath);
    const renameNewVisibleMs = await waitForRow(page, renamedName, true);
    const renameOldGoneMs = await waitForRow(page, originalName, false);
    results.push({ op: "rename", newVisibleMs: renameNewVisibleMs, oldGoneMs: renameOldGoneMs });

    await fs.rm(renamedPath, { force: true });
    results.push({ op: "delete", ms: await waitForRow(page, renamedName, false) });

    console.log(JSON.stringify({
      appUrl,
      workspaceRoot,
      timeoutMs,
      results,
      workspaceEventCount: workspaceEvents.length,
    }, null, 2));
  } catch (error) {
    await page.screenshot({ path: "/tmp/tessera-live-sync-e2e-failure.png", fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close().catch(() => {});
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
