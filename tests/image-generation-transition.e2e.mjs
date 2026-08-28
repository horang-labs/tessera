import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-image-transition-'));
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR;
const serverEnv = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: String(port),
  NODE_ENV: 'development',
  TESSERA_DATA_DIR: dataDir,
  TESSERA_ELECTRON_RUNTIME: '1',
  LOG_LEVEL: 'error',
};
for (const name of ['TESSERA_APP_ROOT', 'TESSERA_PRODUCTION_DB', 'TESSERA_ELECTRON_SERVER', '__CFBundleIdentifier']) {
  delete serverEnv[name];
}
const server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
  cwd: repoRoot,
  detached: true,
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
server.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-20_000); });

let browser;
try {
  await waitForPage(`${origin}/dev-image-transition-repro`, server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${origin}/dev-image-transition-repro`, { waitUntil: 'domcontentloaded' });
  const hero = page.getByTestId('image-generation-hero');
  await hero.waitFor({ state: 'visible' });
  if (artifactDir) {
    await fs.mkdir(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, '01-image-generation-running.png') });
  }

  const initialHeight = await hero.evaluate((element) => element.getBoundingClientRect().height);
  await page.evaluate(() => {
    window.__imageGenerationHeroSamples = [];
    const started = performance.now();
    const sample = () => {
      const element = document.querySelector('[data-testid="image-generation-hero"]');
      window.__imageGenerationHeroSamples.push(element?.getBoundingClientRect().height ?? -1);
      if (performance.now() - started < 2_500) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByTestId('complete').click();
  await page.getByText('Completed', { exact: true }).waitFor();
  await page.waitForTimeout(1_200);
  const samples = await page.evaluate(() => window.__imageGenerationHeroSamples);
  const minHeight = Math.min(...samples.filter((height) => height >= 0));
  const finalHeight = await hero.evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(
    minHeight >= initialHeight * 0.5,
    `the hero must not collapse while the completed image loads (${initialHeight} -> ${minHeight} -> ${finalHeight})`,
  );
  assert.equal(await page.getByText('Revised prompt', { exact: true }).isVisible(), true);
  if (artifactDir) await page.screenshot({ path: path.join(artifactDir, '02-image-generation-completed.png') });
} catch (error) {
  if (output) process.stderr.write(`\n--- isolated server output ---\n${output}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (server.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
  await new Promise((resolve) => server.once('exit', resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
}

async function waitForPage(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}
