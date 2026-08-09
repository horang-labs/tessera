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
  await projectWorktree.click();

  await page.getByRole("button", { name: "New Session", exact: true }).waitFor();
  await page.getByRole("button", { name: "New Worktree", exact: true }).waitFor();
  const bodyText = await page.locator("body").innerText();
  assert.ok(bodyText.includes(currentBranch));
  assert.ok(bodyText.includes(process.cwd()));

  await page.getByTestId("tab-bar-git-toggle").click();
  await page.getByRole("tab", { name: "Git" }).click();
  await page.getByText("Changed files", { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await page.getByText("No worktree selected", { exact: true }).count(), 0);

  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByText("Workspace files", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "README.md", exact: true }).waitFor();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New Session", exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await projectWorktree.count(), 1);
  console.log("Project Worktree selection, direct Git/Files routing, and reload persistence passed.");
} finally {
  await browser?.close();
  await stopServer();
  await fs.rm(dataDir, { recursive: true, force: true });
}
