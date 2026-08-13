import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const run = promisify(execFile);
const port = Number(process.env.TESSERA_E2E_PORT ?? 34286);
const origin = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-project-root-e2e-"));
const gitFixtureName = `project-worktree-e2e-${path.basename(dataDir)}.txt`;
const gitFixturePath = path.join(process.cwd(), gitFixtureName);
const currentBranch = (await run("git", ["branch", "--show-current"])).stdout.trim();
const serverOutput = [];
let server;
let browser;

function logs() {
  return serverOutput.join("");
}

async function startServer() {
  const env = { ...process.env };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_CHILD",
    "TESSERA_APP_ROOT",
    "TESSERA_ELECTRON_SERVER",
    "TESSERA_PRODUCTION_DB",
    "TESSERA_HOOK_PORT",
    "TESSERA_PANE_TOKEN",
    "TESSERA_SESSION_ID",
  ]) delete env[key];

  server = spawn(process.execPath, ["./node_modules/.bin/tsx", "server.ts"], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...env,
      NODE_ENV: "development",
      PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_AUTH_BYPASS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (chunk) => {
      serverOutput.push(chunk.toString());
      if (serverOutput.length > 300) serverOutput.shift();
    });
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    try {
      const response = await fetch(`${origin}/api/auth/setup`);
      if (response.ok) return;
    } catch {
      // The dev server is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start:\n${logs()}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
}

try {
  await fs.writeFile(gitFixturePath, "Project Worktree e2e Git fixture.\n", { flag: "wx" });
  await startServer();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  await page.goto(`${origin}/setup`, { waitUntil: "domcontentloaded" });
  const setup = await page.evaluate(async () => {
    const response = await fetch("/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "project-root-e2e", password: "project-root-e2e" }),
    });
    return { ok: response.ok, text: await response.text() };
  });
  assert.equal(setup.ok, true, setup.text);
  const settings = await page.evaluate(async () => {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentEnvironment: "wsl" }),
    });
    return { ok: response.ok, text: await response.text() };
  });
  assert.equal(settings.ok, true, settings.text);

  await page.goto(`${origin}/chat`, { waitUntil: "domcontentloaded" });
  const projectWorktree = page.getByTestId("project-worktree-row");
  await projectWorktree.waitFor({ timeout: 30_000 });
  const tabIdsBefore = await page.locator('[role="tab"][data-tab-id]').evaluateAll(
    (tabs) => tabs.map((tab) => tab.getAttribute('data-tab-id')),
  );
  await projectWorktree.click();

  assert.deepEqual(
    await page.locator('[role="tab"][data-tab-id]').evaluateAll(
      (tabs) => tabs.map((tab) => tab.getAttribute('data-tab-id')),
    ),
    tabIdsBefore,
  );
  const dialogBox = await page.getByTestId('worktree-peek').boundingBox();
  const panelHostBox = await page.getByTestId('tab-panel-host').boundingBox();
  assert.ok(dialogBox && panelHostBox);
  assert.ok(dialogBox.width < panelHostBox.width);
  assert.ok(dialogBox.height < panelHostBox.height);
  const panelHostWrapper = page.getByTestId('tab-panel-host').locator('..');
  assert.equal(await panelHostWrapper.getAttribute('aria-hidden'), 'true');
  assert.equal(await panelHostWrapper.evaluate((element) => element.inert), true);
  await page.keyboard.press('Escape');
  await page.getByTestId('worktree-peek').waitFor({ state: 'detached' });
  assert.deepEqual(
    await page.locator('[role="tab"][data-tab-id]').evaluateAll(
      (tabs) => tabs.map((tab) => tab.getAttribute('data-tab-id')),
    ),
    tabIdsBefore,
  );

  await page.getByTestId('project-strip-all').click();
  const allProjectsSection = page.getByTestId(`all-project-section-${process.cwd()}`);
  await allProjectsSection.waitFor();
  await allProjectsSection.locator(':scope > div').first().click();
  const allProjectsWorktreeRow = allProjectsSection.getByTestId('project-worktree-row');
  await allProjectsWorktreeRow.waitFor();
  assert.equal(await allProjectsWorktreeRow.getAttribute('data-variant'), 'compact');
  assert.ok((await allProjectsWorktreeRow.innerText()).includes(process.cwd()));
  await allProjectsWorktreeRow.click();
  await page.getByTestId('worktree-peek').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId(`project-strip-${process.cwd()}`).click();
  await projectWorktree.waitFor();
  await projectWorktree.click();

  await page.getByTestId('worktree-peek').waitFor();
  assert.equal(await page.getByRole("button", { name: "New Session", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "New Worktree", exact: true }).count(), 0);
  const bodyText = await page.locator("body").innerText();
  assert.ok(bodyText.includes(currentBranch));
  assert.ok(bodyText.includes(process.cwd()));

  await page.getByTestId("tab-bar-git-toggle").click();
  await page.getByRole("tab", { name: "Git" }).click();
  await page.getByText("Changed files", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText(gitFixtureName, { exact: true }).waitFor();
  assert.equal(await page.getByText("No worktree selected", { exact: true }).count(), 0);
  assert.equal(await page.getByTestId("git-commit-generate-button").isDisabled(), false);
  const gitMenu = page.getByTestId("git-panel").getByTestId("git-action-menu");
  await page.getByTestId("git-panel").getByTestId("git-action-menu-trigger").click();
  await gitMenu.waitFor();
  assert.doesNotMatch(await gitMenu.innerText(), /Reading git state/i);
  assert.equal(
    await page.getByTestId(`git-action-menu-item-commit`).isDisabled(),
    false,
  );
  await page.keyboard.press("Escape");
  await gitMenu.waitFor({ state: "detached" });
  const diffResponse = page.waitForResponse((response) =>
    response.url().includes('/api/worktrees/')
      && response.url().includes('/git/diff?path=')
  );
  await page
    .getByTestId(`git-panel-file-row-${gitFixtureName}`)
    .locator(':scope > div > button')
    .click();
  assert.equal((await diffResponse).status(), 200);
  await page.getByRole('tab', { name: new RegExp(`^${gitFixtureName} Diff`) }).waitFor();
  await projectWorktree.click();
  await page.getByTestId('worktree-peek').waitFor();

  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByText("Workspace files", { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await page.getByTestId("workspace-new-file").isDisabled(), true);
  assert.equal(await page.getByTestId("workspace-new-folder").isDisabled(), true);
  const readmeRow = page.getByRole("button", { name: "README.md", exact: true });
  await readmeRow.waitFor();
  const fileResponse = page.waitForResponse((response) =>
    response.url().includes('/api/worktrees/')
      && response.url().includes('/file?path=README.md')
  );
  await readmeRow.click();
  assert.equal((await fileResponse).status(), 200);
  await page.getByTestId('worktree-peek').waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: /^README\.md/ }).waitFor();
  assert.equal(await page.getByTestId('workspace-file-save').count(), 0);
  await projectWorktree.click();
  await page.getByTestId('worktree-peek').waitFor();

  await page.reload({ waitUntil: "domcontentloaded" });
  await projectWorktree.waitFor({ timeout: 30_000 });
  assert.equal(await page.getByTestId("worktree-peek").count(), 0);
  await projectWorktree.click();
  await page.getByTestId("worktree-peek").waitFor();
  assert.equal(await page.getByRole("button", { name: "New Session", exact: true }).count(), 0);
  assert.equal(await projectWorktree.count(), 1);
  console.log("Project Worktree Peek, direct Git/Files routing, and transient reload behavior passed.");
} finally {
  await browser?.close();
  await stopServer();
  await fs.rm(gitFixturePath, { force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
}
