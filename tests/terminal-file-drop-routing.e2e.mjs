// Windows Node: node tests/terminal-file-drop-routing.e2e.mjs <isolated-CDP-url> <session-id> <screenshots-dir> <project-dir>
// Use a disposable, idle Codex PTY session in an isolated Windows-backend + WSL-CLI app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { chromium, expect } from '@playwright/test';

const [cdpUrl, sessionId, artifactDir, projectDir] = process.argv.slice(2);
assert.ok(cdpUrl && sessionId && artifactDir && projectDir, 'CDP URL, disposable session, screenshots, and project are required');
await fs.mkdir(artifactDir, { recursive: true });
const browser = await chromium.connectOverCDP(cdpUrl);
const sent = [];
const output = [];
try {
  const page = browser.contexts()[0].pages().find(p => /localhost:/.test(p.url()));
  assert.ok(page, 'Expected the packaged renderer');
  const topology = await page.evaluate(async () => {
    const { settings, serverHostInfo } = await (await fetch('/api/settings')).json();
    return { platform: serverHostInfo.platform, agentEnvironment: settings.agentEnvironment, peek: settings.kanbanSessionOpenMode };
  });
  assert.deepEqual(topology, { platform: 'win32', agentEnvironment: 'wsl', peek: 'peek' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameSent', event => {
    try {
      const message = JSON.parse(event.response.payloadData);
      if (message.type.startsWith('terminal_')) sent.push(message);
    } catch { /* Ignore non-JSON frames. */ }
  });
  cdp.on('Network.webSocketFrameReceived', event => {
    try {
      const message = JSON.parse(event.response.payloadData);
      if (message.type === 'terminal_output') output.push(message);
    } catch { /* Ignore non-JSON frames. */ }
  });
  const shot = name => page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
  const textSince = index => stripVTControlCharacters(output.slice(index).map(m => m.data).join(''));
  const peek = page.getByTestId('kanban-session-peek');
  const card = page.locator(`[data-testid="kanban-card"][data-session-id="${sessionId}"]`);

  async function keyboardSurface(terminal, marker) {
    await expect(terminal.locator('.xterm-helper-textarea')).toBeVisible({ timeout: 30000 });
    await terminal.locator('.xterm-helper-textarea').focus();
    const start = output.length;
    const sentStart = sent.length;
    // xterm mounts before its snapshot replay permits input. Wait for an
    // accepted keyboard send instead of treating the visible textarea as ready.
    await expect(async () => {
      await page.keyboard.insertText(marker);
      await expect.poll(() => sent.slice(sentStart).some(m => m.type === 'terminal_input' && m.data === marker), { timeout: 1000 }).toBe(true);
    }).toPass({ timeout: 30000, intervals: [250] });
    await expect.poll(() => textSince(start), { timeout: 15000 }).toContain(marker);
    const frame = sent.findLast(m => m.type === 'terminal_input' && m.data === marker);
    assert.ok(frame, 'Keyboard input must reach a running PTY');
    await page.keyboard.press('Control+u');
    return frame.surfaceId;
  }

  async function drop(terminal, surfaceId, name, basename) {
    const file = path.join(artifactDir, basename);
    await fs.writeFile(file, 'External file drop fixture\n');
    const box = await terminal.boundingBox();
    assert.ok(box);
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    const x = box.x + box.width / 2, y = box.y + box.height * 0.7;
    const sentStart = sent.length, outputStart = output.length;
    await shot(`${name}-before`);
    for (const type of ['dragEnter', 'dragOver']) await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
    await shot(`${name}-dragover`);
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
    await shot(`${name}-dropped`);
    await expect.poll(() => sent.slice(sentStart).find(m => m.type === 'terminal_input' && m.data.includes(basename)), { timeout: 3000 }).toBeTruthy();
    const input = sent.slice(sentStart).find(m => m.type === 'terminal_input' && m.data.includes(basename));
    assert.equal(input.surfaceId, surfaceId, 'Drop must use the attached surface, not the cold-parked list subscriber');
    await expect.poll(() => textSince(outputStart), { timeout: 10000 }).toContain(basename);
    await shot(`${name}-visible-input`);
    await page.keyboard.press('Control+u');
  }

  await page.bringToFront();
  if (await peek.isVisible()) await peek.getByTestId('kanban-session-peek-close').click();
  await page.getByTestId(`project-strip-${projectDir}`).click();
  await page.getByTestId('view-mode-list').click();
  await page.locator(`[data-session-id="${sessionId}"]`).filter({ hasText: 'Peek DND QA' }).first().click();
  await shot('01-list-open');
  const listTerminal = page.locator('[data-panel-wrapper="true"]').filter({ has: page.getByTestId('terminal-panel') }).first();
  const listSurface = await keyboardSurface(listTerminal, 'QA_LIST_READY');
  await drop(listTerminal, listSurface, '02-list', 'dnd-before.txt');
  await page.getByTestId('view-mode-board').click();
  await shot('03-board');
  await card.click();
  const peekTerminal = peek.getByTestId('terminal-panel');
  const peekSurface = await keyboardSurface(peekTerminal, 'QA_PEEK_READY');
  await shot('04-peek-open');
  await drop(peekTerminal, peekSurface, '04-peek-direct', 'dnd-direct.txt');
  // Observe the real 30-second lifecycle boundary; do not substitute a guessed delay.
  await expect.poll(() => sent.some(m => m.type === 'terminal_detach' && m.surfaceId === listSurface), { timeout: 45000 }).toBe(true);
  await shot('05-list-detached');
  await drop(peekTerminal, peekSurface, '06-cold-peek', 'dnd-after.txt');
  await peek.getByTestId('kanban-session-peek-close').click();
  await shot('07-peek-closed');
  await card.click();
  const reopenedSurface = await keyboardSurface(peekTerminal, 'QA_REOPEN_READY');
  await drop(peekTerminal, reopenedSurface, '08-reopened-peek', 'dnd-reopened.txt');
  console.log('PASS: Windows backend + WSL CLI; list drop; direct Peek drop while list remains attached; real cold-park; Peek drop; reopened Peek drop; PTY output verified');
} finally {
  await fs.writeFile(path.join(artifactDir, 'transport-evidence.json'), JSON.stringify({ sent, output }, null, 2));
  await browser.close();
}
