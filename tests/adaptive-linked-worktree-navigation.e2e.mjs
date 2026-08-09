import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const run = promisify(execFile);
const port = Number(process.env.TESSERA_E2E_PORT ?? 34291);
const origin = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-adaptive-worktree-"));
const descriptor = path.join(dataDir, "control.json");
const evidenceDir = process.env.TESSERA_EVIDENCE_DIR ?? path.join(process.cwd(), ".tmp", "issue-291-evidence");
const suffix = path.basename(dataDir).toLowerCase();
const serverOutput = [];
const created = [];
let server;
let browser;
let authCookie = "";

function cleanEnv() {
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_CHILD", "TESSERA_APP_ROOT", "TESSERA_ELECTRON_SERVER", "TESSERA_PRODUCTION_DB", "TESSERA_HOOK_PORT", "TESSERA_PANE_TOKEN", "TESSERA_SESSION_ID"]) delete env[key];
  return env;
}

async function startServer() {
  server = spawn(process.execPath, ["./node_modules/.bin/tsx", "server.ts"], {
    cwd: process.cwd(), detached: true,
    env: { ...cleanEnv(), NODE_ENV: "development", PORT: String(port), TESSERA_DATA_DIR: dataDir, TESSERA_ELECTRON_AUTH_BYPASS: "1", TESSERA_CONTROL_DESCRIPTOR_PATH: descriptor },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => serverOutput.push(chunk.toString()));
  for (let attempt = 0; attempt < 480; attempt += 1) {
    if (server.exitCode !== null) throw new Error(serverOutput.join(""));
    try { if ((await fetch(`${origin}/api/auth/setup`)).ok && await fs.stat(descriptor)) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server timeout:\n${serverOutput.join("")}`);
}

async function api(url, body, method = "POST") {
  const headers = { "content-type": "application/json", origin };
  if (authCookie) headers.cookie = authCookie;
  const response = await fetch(`${origin}${url}`, body ? { method, headers, body: JSON.stringify(body) } : { headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) authCookie = setCookie.split(";", 1)[0];
  const text = await response.text();
  assert.equal(response.ok, true, `${url}: ${text}`);
  return JSON.parse(text);
}

async function cli(args) {
  const result = await run(process.execPath, ["bin/tessera.mjs", ...args, "--json", "--control-descriptor", descriptor], { cwd: process.cwd(), env: cleanEnv(), maxBuffer: 2 ** 20 });
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, result.stdout || result.stderr);
  return envelope.data;
}

async function createWorktree(projectId, count) {
  const branch = `t291-${count}-${suffix}`;
  const worktree = await cli(["worktree", "create", "--project", projectId, "-b", branch, "HEAD", "--title", `Adaptive ${count}`]);
  created.push(worktree);
  await fs.writeFile(path.join(worktree.path, `marker-${count}.txt`), `${count}\n`);
  const projection = await api(`/api/tasks?projectId=${encodeURIComponent(projectId)}`);
  const task = projection.tasks.find((candidate) => candidate.worktreeId === worktree.worktreeId);
  assert.ok(task, `Worktree ${worktree.worktreeId} was not projected into its Project`);
  const sessions = [];
  for (let index = 0; index < count; index += 1) {
    sessions.push(await api("/api/sessions", { workDir: worktree.path, parentProjectId: projectId, taskId: task.id, worktreeBranch: worktree.branch, providerId: "codex", executionMode: "gui", title: `${count} Session ${index + 1}`, hasCustomTitle: true }));
  }
  return { ...worktree, sessions };
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  let exited = false;
  const exit = new Promise((resolve) => server.once("exit", () => { exited = true; resolve(); }));
  try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (!exited && server.exitCode === null) {
    try { process.kill(-server.pid, "SIGKILL"); } catch { server.kill("SIGKILL"); }
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
}

try {
  await fs.mkdir(evidenceDir, { recursive: true });
  await startServer();
  await api("/api/auth/setup", { username: "adaptive-worktree", password: "adaptive-worktree" });
  const projects = await api("/api/sessions/projects");
  const project = projects.projects.find((item) => item.decodedPath === process.cwd());
  assert.ok(project?.projectWorktree?.id, "current Project Worktree was not registered");
  await api("/api/settings", { agentEnvironment: "wsl", showProviderIcons: false, showRecentWork: false }, "PUT");

  const zero = await createWorktree(project.encodedDir, 0);
  const one = await createWorktree(project.encodedDir, 1);
  const many = await createWorktree(project.encodedDir, 2);
  const direct = await api("/api/sessions", { workDir: process.cwd(), parentProjectId: project.encodedDir, providerId: "codex", executionMode: "gui", title: "Direct Project Session", hasCustomTitle: true });
  assert.ok((await api(`/api/worktrees/${one.worktreeId}/files`)).files.includes("marker-1.txt"));
  const projection = await api(`/api/tasks?projectId=${encodeURIComponent(project.encodedDir)}`);
  assert.deepEqual(projection.tasks.filter((task) => [zero.worktreeId, one.worktreeId, many.worktreeId].includes(task.worktreeId)).map((task) => task.sessions.length).sort(), [0, 1, 2]);

  browser = await chromium.launch({ headless: process.env.TESSERA_HEADFUL !== "1" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const linkedSessionIds = new Set([...one.sessions, ...many.sessions].map((session) => session.sessionId));
  await page.route("**/api/sessions/*/messages?*", async (route) => {
    const sessionId = new URL(route.request().url()).pathname.split("/")[3];
    if (!linkedSessionIds.has(sessionId)) return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [], pagination: { hasMore: false, nextBeforeBytes: 0 } }) });
  });
  const [cookieName, cookieValue] = authCookie.split("=", 2);
  await page.context().addCookies([{ name: cookieName, value: cookieValue, url: origin }]);
  const worktreeRequests = [];
  page.on("request", (request) => { if (request.url().includes("/api/worktrees/")) worktreeRequests.push(request.url()); });
  await page.goto(`${origin}/chat`, { waitUntil: "networkidle" });
  await page.getByTestId("project-worktree-row").waitFor({ timeout: 30_000 });

  const zeroRow = page.locator(`[data-worktree-id="${zero.worktreeId}"]`);
  const oneRow = page.locator(`[data-worktree-id="${one.worktreeId}"]`);
  const manyRow = page.locator(`[data-worktree-id="${many.worktreeId}"]`);
  await zeroRow.waitFor();
  assert.equal(await zeroRow.getAttribute("data-linked-worktree-density"), "standalone");
  assert.equal(await oneRow.getAttribute("data-linked-worktree-density"), "composite");
  assert.equal(await manyRow.getAttribute("data-linked-worktree-density"), "expanded");
  assert.equal(await zeroRow.locator('[data-testid^="collection-task-worktree-icon-"]').count(), 1);
  assert.equal(await oneRow.locator('[data-testid^="collection-task-worktree-icon-"]').count(), 1);
  assert.equal(await manyRow.locator('[data-testid^="collection-task-worktree-icon-"]').count(), 1);
  assert.equal(await manyRow.locator('[data-testid^="collection-subsession-"]').count(), 0);
  assert.equal(await page.locator(`[data-testid="collection-subsession-${many.sessions[0].sessionId}"]`).count(), 1);
  assert.equal(await page.locator(`[data-testid="collection-subsession-${many.sessions[1].sessionId}"]`).count(), 1);
  assert.equal(await page.locator(`[data-testid="collection-chat-${direct.sessionId}"]`).first().locator('[data-testid*="bubble-"]').count(), 1);

  await zeroRow.click();
  await page.getByTestId("worktree-overview").getByText("Linked Worktree", { exact: true }).waitFor();
  await page.locator(`[data-worktree-id="${zero.worktreeId}"][aria-current="true"]`).waitFor();
  if (!(await page.getByTestId("git-panel").count())) await page.getByTestId("tab-bar-git-toggle").click();
  await page.getByTestId("git-panel").waitFor();
  await page.locator(`[data-testid="git-panel"][data-worktree-target="${zero.worktreeId}"]`).waitFor();
  assert.equal(await page.getByTestId("git-panel").getAttribute("data-worktree-target"), zero.worktreeId);
  const zeroFilesResponse = page.waitForResponse((response) => response.url().includes(`/api/worktrees/${zero.worktreeId}/files`));
  await page.getByRole("tab", { name: "Files" }).click();
  assert.equal((await zeroFilesResponse).ok(), true);

  await oneRow.click();
  await page.locator('[data-testid="message-input-row"]:visible').waitFor({ timeout: 30_000 });
  await page.locator(`[data-testid="git-panel"][data-worktree-target="${one.worktreeId}"]`).waitFor();
  assert.equal(await page.getByTestId("git-panel").getAttribute("data-worktree-target"), one.worktreeId);
  assert.equal(await page.getByTestId("git-panel").getAttribute("data-session-target"), null);
  await page.getByRole("tab", { name: "Git" }).click();
  const oneFilesResponse = page.waitForResponse((response) => response.url().includes("/files"));
  await page.getByRole("tab", { name: "Files" }).click();
  const oneFilesResult = await oneFilesResponse;
  assert.equal(oneFilesResult.ok(), true);
  assert.ok(oneFilesResult.url().includes(`/api/worktrees/${one.worktreeId}/files`), oneFilesResult.url());
  await page.getByRole("button", { name: "marker-1.txt", exact: true }).waitFor({ timeout: 30_000 });
  assert.ok(worktreeRequests.some((url) => url.includes(`/api/worktrees/${one.worktreeId}/files`)));
  await page.screenshot({ path: path.join(evidenceDir, "desktop-composite-files.png"), fullPage: true });

  await manyRow.click();
  await page.getByTestId("worktree-overview").getByText("Linked Worktree", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Git" }).click();
  await page.getByText("marker-2.txt", { exact: true }).waitFor({ timeout: 30_000 });
  assert.ok(worktreeRequests.some((url) => url.includes(`/api/worktrees/${many.worktreeId}/git`)));
  await page.locator(`[data-testid="collection-subsession-${many.sessions[0].sessionId}"]`).click();
  await page.locator('[data-testid="message-input-row"]:visible').waitFor();

  for (const row of [zeroRow, oneRow, manyRow]) {
    await row.hover();
    assert.equal(await row.locator('[data-testid*="-add-session-"]').count(), 1);
    assert.equal(await row.locator('[data-testid*="-quick-archive-"]').count(), 1);
  }

  await page.getByTestId("tab-bar-git-toggle").click();
  await page.getByTestId("git-panel").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  if (!(await page.getByTestId("sidebar").isVisible())) await page.getByTestId("tab-bar-sidebar-toggle").click();
  await oneRow.waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(evidenceDir, "phone-adaptive-rows.png"), fullPage: true });
  await oneRow.click();
  await page.locator('[data-testid="message-input-row"]:visible').waitFor();
  assert.equal(await page.getByTestId("sidebar").isVisible(), false);
  await fs.writeFile(path.join(evidenceDir, "observed.json"), JSON.stringify({ densities: ["standalone", "composite", "expanded"], worktreeRequests }, null, 2));
  console.log(`Adaptive linked-Worktree navigation passed; evidence: ${evidenceDir}`);
} finally {
  await browser?.close();
  await stopServer();
  for (const worktree of created.reverse()) {
    await run("git", ["worktree", "remove", "--force", worktree.path]).catch(() => undefined);
    await run("git", ["branch", "-D", worktree.branch]).catch(() => undefined);
  }
  await fs.rm(dataDir, { recursive: true, force: true });
}
