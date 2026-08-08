/**
 * The archive tab fits a phone screen (issue #249).
 *
 * The archive tab is the one tab whose content slides sideways: both of its
 * tables declare a minimum width far wider than the screen, so the box around
 * them scrolls horizontally. This file drives the real tab through the shared
 * 360x776 touch context and asserts what a user can see and reach — a box that
 * fits the screen, a value that is on screen, a button whose label still says
 * what it does — never a class name.
 *
 * The server is spawned from the repository itself rather than from a copied
 * app root: every assertion here is a measured box, and Tailwind only generates
 * the utility layer for the source tree it is pointed at. A copied root serves
 * the page unstyled, and an unstyled table measures as its content (#252).
 *
 * The archive rows come from a routed fixture rather than real archived work,
 * so the widths under test are the ones the layout has to survive — a long
 * title, a long project name, a long worktree path — and not whatever happens
 * to be archived on the machine running this.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';

const run = promisify(execFile);

// A desktop window, above the Phone viewport breakpoint, for the
// non-regression phase.
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-archive-table-e2e');

const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-archive-data-'));
const fixtureDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-archive-fixture-'));
const projectName = `archive-e2e-${path.basename(fixtureDir).slice(-6)}`;
const projectDir = path.join(fixtureDir, projectName);

const serverOutput = [];
let port = 0;
let origin = '';
let server = null;
let browser = null;
let page = null;
let appSecret = null;
const results = [];

const logs = () => serverOutput.join('');

// ------------------------------------------------------------------ fixture ---

// Deliberately wider than the screen in every field a row can carry: a title,
// a project name and a worktree path all long enough that a layout which does
// not wrap or truncate them will be caught.
const LONG_TASK_TITLE = 'Restore the archived worktree retention sweep for the nightly run';
const LONG_PROJECT_NAME = 'horang-labs-tessera-desktop-application';
const LONG_WORKTREE_PATH = '/home/work/.tessera/worktrees_from_elec/tessera-dev/feature/0807-archive';

const TASK_ITEMS = [
  {
    id: 'task-multi',
    kind: 'task',
    title: LONG_TASK_TITLE,
    projectId: 'project-one',
    projectName: LONG_PROJECT_NAME,
    updatedAt: '2026-08-01T10:00:00.000Z',
    createdAt: '2026-07-30T10:00:00.000Z',
    archivedAt: '2026-08-06T10:00:00.000Z',
    workDir: LONG_WORKTREE_PATH,
    worktreeBranch: 'feature/0807-archive',
    worktreeManaged: true,
    worktreeStatus: 'present',
    canRestore: true,
    sharedWorktree: false,
    sessions: [
      { id: 'session-a', title: 'Implement the retention sweep', lastModified: '2026-08-01T10:00:00.000Z', isRunning: false },
      { id: 'session-b', title: 'Review the retention sweep changes', lastModified: '2026-08-01T11:00:00.000Z', isRunning: false },
    ],
  },
  {
    id: 'task-single',
    kind: 'task',
    title: 'Rebuild the packaged Windows runtime',
    projectId: 'project-one',
    projectName: LONG_PROJECT_NAME,
    updatedAt: '2026-08-02T10:00:00.000Z',
    createdAt: '2026-07-31T10:00:00.000Z',
    archivedAt: '2026-08-05T10:00:00.000Z',
    workDir: '/home/work/.tessera/worktrees/packaged-runtime',
    worktreeManaged: true,
    worktreeStatus: 'deleted',
    worktreeDeletedAt: '2026-08-06T12:00:00.000Z',
    canRestore: false,
    sharedWorktree: false,
    sessions: [
      { id: 'session-c', title: 'Rebuild the packaged Windows runtime', lastModified: '2026-08-02T10:00:00.000Z', isRunning: false },
    ],
  },
];

const CHAT_ITEMS = [
  {
    id: 'chat-one',
    kind: 'chat',
    title: 'Why does the archive tab slide sideways on a phone screen?',
    projectId: 'project-one',
    projectName: LONG_PROJECT_NAME,
    updatedAt: '2026-08-03T10:00:00.000Z',
    createdAt: '2026-08-01T10:00:00.000Z',
    archivedAt: '2026-08-04T10:00:00.000Z',
    worktreeManaged: false,
    worktreeStatus: 'missing',
    canRestore: true,
    sharedWorktree: false,
    sessions: [
      { id: 'session-d', title: 'Why does the archive tab slide sideways?', lastModified: '2026-08-03T10:00:00.000Z', isRunning: false },
    ],
  },
];

const ARCHIVE_PROJECTS = [
  { id: 'project-one', displayName: LONG_PROJECT_NAME, decodedPath: `/home/work/${LONG_PROJECT_NAME}`, visible: true },
];

function archivePayload(kind) {
  const items = kind === 'task' ? TASK_ITEMS : CHAT_ITEMS;
  return {
    items,
    projects: ARCHIVE_PROJECTS,
    summary: {
      total: TASK_ITEMS.length + CHAT_ITEMS.length,
      chats: CHAT_ITEMS.length,
      tasks: TASK_ITEMS.length,
      worktreesPresent: 1,
      worktreesDeleted: 1,
      worktreesMissing: 1,
    },
    pagination: {
      kind,
      limit: 100,
      cursor: null,
      nextCursor: null,
      returned: items.length,
      total: items.length,
    },
  };
}

// ------------------------------------------------------------------- server ---

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const reserved = address.port;
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return reserved;
}

async function startServer() {
  const env = { ...process.env };
  // This suite may itself be running inside Tessera; nothing about the host
  // app's session may leak into the server under test.
  for (const key of [
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT', 'TESSERA_ELECTRON_SERVER',
    'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT', 'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID',
    'TESSERA_PROJECT_ID', 'TESSERA_WORKTREE_ID', 'TESSERA_ENV', 'TESSERA_CLI_COMMAND',
  ]) {
    delete env[key];
  }

  server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...env,
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
      PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => {
      serverOutput.push(chunk.toString());
      if (serverOutput.length > 400) serverOutput.shift();
    });
  }

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    try {
      appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      const response = await fetch(`${origin}/api/settings`, {
        headers: { 'x-tessera-app-secret': appSecret },
      });
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start:\n${logs()}`);
}

// Only the process group this file started is signalled — other worktrees run
// their own development servers against the same command line.
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  server = null;
}

async function api(pathname, init) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tessera-app-secret': appSecret,
      // Writes are same-origin only, so a bare fetch is turned away.
      origin,
      ...(init?.headers ?? {}),
    },
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

// ----------------------------------------------------------------------- ui ---

async function openArchiveTab(viewport, { touch }) {
  if (page) await page.context().close();
  const options = { extraHTTPHeaders: { 'x-tessera-app-secret': appSecret } };
  const context = touch
    ? await createPhoneContext(browser, options)
    : await browser.newContext({ ...options, viewport, hasTouch: false });

  await context.addInitScript((dir) => {
    // The board replaces the tab workspace, and this ticket is about a tab.
    localStorage.setItem('ccw:viewMode', 'list');
    localStorage.setItem('ccw:selectedProjectDir', dir);
  }, projectDir);

  page = await context.newPage();
  await page.route('**/api/archive?**', async (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind') ?? 'chat';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(archivePayload(kind)),
    });
  });

  await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 120_000 });
  await page.getByTestId('project-strip-archive').click();

  // Both tables have to be on screen before anything is measured.
  await page.getByTestId('archive-task-row-task-multi').waitFor({ timeout: 30_000 });
  await page.getByTestId('archive-chat-row-chat-one').waitFor({ timeout: 30_000 });
  return page;
}

/** The box of the table a given row belongs to, and of its scroll container. */
function tableGeometry(rowTestId) {
  return page.evaluate((testId) => {
    const row = document.querySelector(`[data-testid="${testId}"]`);
    if (!row) return null;
    const table = row.closest('table');
    const rect = table.getBoundingClientRect();

    // The nearest ancestor the user could actually drag sideways.
    let scroller = table.parentElement;
    while (scroller && scroller !== document.body) {
      const overflowX = getComputedStyle(scroller).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') break;
      scroller = scroller.parentElement;
    }

    return {
      tableWidth: Math.round(rect.width),
      tableRight: Math.round(rect.right),
      scrollerScrollWidth: scroller ? Math.round(scroller.scrollWidth) : null,
      scrollerClientWidth: scroller ? Math.round(scroller.clientWidth) : null,
    };
  }, rowTestId);
}

function documentScroll() {
  return page.evaluate(() => ({
    scrollWidth: Math.round(document.documentElement.scrollWidth),
    clientWidth: Math.round(document.documentElement.clientWidth),
  }));
}

/** Every column heading of a row's table, with where it sits. */
function columnHeadings(rowTestId) {
  return page.evaluate((testId) => {
    const table = document.querySelector(`[data-testid="${testId}"]`)?.closest('table');
    return [...(table?.querySelectorAll('thead th') ?? [])].map((cell) => {
      const box = cell.getBoundingClientRect();
      return {
        text: cell.innerText.trim(),
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
      };
    });
  }, rowTestId);
}

/**
 * Every line of text a row renders, from the desktop's own cells. The desktop
 * is the source of truth for what a row carries, so what a phone has to keep
 * reachable is read off it rather than restated here.
 */
function rowTextLines(rowTestId) {
  return page.evaluate((testId) => {
    const row = document.querySelector(`[data-testid="${testId}"]`);
    if (!row) return null;
    return [...row.querySelectorAll('td')]
      .flatMap((cell) => cell.innerText.split('\n'))
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }, rowTestId);
}

/** A row's text cell by cell, so a value can be paired with its column. */
function rowCellTexts(rowTestId) {
  return page.evaluate((testId) => {
    const row = document.querySelector(`[data-testid="${testId}"]`);
    return [...(row?.querySelectorAll('td') ?? [])]
      .map((cell) => cell.innerText.replace(/\s+/g, ' ').trim());
  }, rowTestId);
}

/**
 * The labels of a row's archive actions, read from the desktop's actions
 * column. What the actions are called is the desktop's to decide; the phone
 * has to keep those exact labels, because "delete worktree" and "delete" are
 * two irreversible actions told apart by nothing else.
 */
function desktopActionLabels(rowTestId) {
  return page.evaluate((testId) => {
    const cells = document.querySelector(`[data-testid="${testId}"]`)?.querySelectorAll('td') ?? [];
    const actionsCell = cells[cells.length - 1];
    return [...(actionsCell?.querySelectorAll('button') ?? [])]
      .map((button) => button.innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }, rowTestId);
}

/** Every labelled button in a row, with its box. */
function rowButtons(rowTestId) {
  return page.evaluate((testId) => {
    const row = document.querySelector(`[data-testid="${testId}"]`);
    return [...(row?.querySelectorAll('button') ?? [])]
      .map((button) => {
        const box = button.getBoundingClientRect();
        return {
          label: button.innerText.replace(/\s+/g, ' ').trim(),
          left: Math.round(box.left),
          right: Math.round(box.right),
          width: Math.round(box.width),
        };
      })
      .filter((button) => button.label);
  }, rowTestId);
}

// ------------------------------------------------------------------- phases ---

// What a desktop row carries, recorded before the phone is looked at. It is
// what the phone has to keep reachable, so it is read rather than restated.
const desktopRows = new Map();

const ROWS = [
  ['task', 'archive-task-row-task-multi'],
  ['task', 'archive-task-row-task-single'],
  ['chat', 'archive-chat-row-chat-one'],
];

// The overriding constraint for this wave: the desktop must not regress. This
// runs first so the rest of the file has something to compare against.
async function phaseTheDesktopTableIsUnchanged() {
  await openArchiveTab(DESKTOP_VIEWPORT, { touch: false });

  for (const [, rowTestId] of ROWS) {
    desktopRows.set(rowTestId, {
      lines: await rowTextLines(rowTestId),
      actionLabels: await desktopActionLabels(rowTestId),
      headings: (await columnHeadings(rowTestId)).map((heading) => heading.text),
      cells: await rowCellTexts(rowTestId),
    });
  }

  // Five columns for a task, four for a chat, side by side on one row, at the
  // widths that were there before this ticket. The widths are written out
  // rather than read off the code: "same widths" is the acceptance criterion,
  // so the numbers have to come from somewhere a mistake cannot follow. Only
  // the first column is elastic, so only it is left out.
  for (const [rowTestId, expectedColumns, fixedWidths] of [
    ['archive-task-row-task-multi', 5, [220, 150, 100, 320]],
    ['archive-chat-row-chat-one', 4, [220, 130, 150]],
  ]) {
    const headings = await columnHeadings(rowTestId);
    assert.equal(
      headings.length,
      expectedColumns,
      `${rowTestId} keeps its ${expectedColumns} column headings: ${JSON.stringify(headings)}`,
    );
    assert.deepEqual(
      headings.slice(1).map((heading) => heading.width),
      fixedWidths,
      `${rowTestId} keeps its column widths: ${JSON.stringify(headings)}`,
    );
    assert.ok(
      headings[0].width > 0,
      `and its first column still takes the slack: ${JSON.stringify(headings[0])}`,
    );
    assert.equal(
      new Set(headings.map((heading) => heading.top)).size,
      1,
      `the headings stay on one row: ${JSON.stringify(headings)}`,
    );
    assert.equal(
      new Set(headings.map((heading) => heading.left)).size,
      headings.length,
      `and side by side, each in its own column: ${JSON.stringify(headings)}`,
    );
  }

  for (const [, rowTestId] of ROWS) {
    assert.ok(
      desktopRows.get(rowTestId).lines.length > 0,
      `${rowTestId} should render something to compare against`,
    );
  }
  assert.deepEqual(
    desktopRows.get('archive-task-row-task-multi').actionLabels.length,
    3,
    'the task row offers restore, delete worktree and delete on a desktop',
  );
}

async function phaseTheArchiveTabDoesNotScrollSidewaysOnAPhone() {
  await openArchiveTab(PHONE_VIEWPORT, { touch: true });

  for (const [label, rowTestId] of [
    ['task', 'archive-task-row-task-multi'],
    ['chat', 'archive-chat-row-chat-one'],
  ]) {
    const geometry = await tableGeometry(rowTestId);
    assert.ok(geometry, `the ${label} table should be measurable`);
    assert.ok(
      geometry.tableRight <= PHONE_VIEWPORT.width + 1,
      `the ${label} table must end within the screen at ${PHONE_VIEWPORT.width}px`
        + ` (right edge ${geometry.tableRight}px, table ${geometry.tableWidth}px wide)`,
    );
    assert.ok(
      geometry.scrollerScrollWidth <= geometry.scrollerClientWidth + 1,
      `the box around the ${label} table must not scroll horizontally`
        + ` (content ${geometry.scrollerScrollWidth}px in ${geometry.scrollerClientWidth}px)`,
    );
  }

  const scroll = await documentScroll();
  assert.ok(
    scroll.scrollWidth <= scroll.clientWidth + 1,
    `the archive tab must not push the page sideways: ${JSON.stringify(scroll)}`,
  );
}

// Fitting the screen is worth nothing if it was bought by dropping a column.
async function phaseEveryColumnIsStillReachableOnAPhone() {
  // Still on the phone page from the phase above.
  for (const [, rowTestId] of ROWS) {
    const desktop = desktopRows.get(rowTestId);
    const phoneLines = await rowTextLines(rowTestId);
    assert.ok(phoneLines, `${rowTestId} should be on the phone too`);

    const phoneText = phoneLines.join('\n');
    for (const line of desktop.lines) {
      assert.ok(
        phoneText.includes(line),
        `${rowTestId} must still carry "${line}" at ${PHONE_VIEWPORT.width}px`
          + ` — the phone shows ${JSON.stringify(phoneLines)}`,
      );
    }

    const buttons = await rowButtons(rowTestId);
    for (const label of desktop.actionLabels) {
      const match = buttons.find((button) => button.label === label);
      assert.ok(
        match,
        `${rowTestId} must keep the "${label}" action under its own label`
          + ` — the phone offers ${JSON.stringify(buttons.map((button) => button.label))}`,
      );
      assert.ok(
        match.left >= -1 && match.right <= PHONE_VIEWPORT.width + 1,
        `the "${label}" action must be on screen (${match.left}px to ${match.right}px)`,
      );
    }
  }
}

/**
 * Fitting the screen must not have been bought by cutting text off.
 *
 * A desktop truncates what will not fit and puts the rest in a `title`
 * tooltip. On a phone there is no pointer to hover with, so truncated text is
 * unreachable — and text content alone cannot see this, because CSS
 * truncation leaves `innerText` complete. Only the rendered width can.
 */
async function phaseNoValueIsCutOffOnAPhone() {
  for (const [, rowTestId] of ROWS) {
    const clipped = await page.evaluate((testId) => {
      const row = document.querySelector(`[data-testid="${testId}"]`);
      return [...(row?.querySelectorAll('*') ?? [])]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          text: element.innerText?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '',
          scrollWidth: Math.round(element.scrollWidth),
          clientWidth: Math.round(element.clientWidth),
        }));
    }, rowTestId);

    assert.deepEqual(
      clipped,
      [],
      `nothing in ${rowTestId} may be cut off at ${PHONE_VIEWPORT.width}px`
        + ` — a phone cannot hover to read the rest: ${JSON.stringify(clipped)}`,
    );
  }
}

// A stacked row shows bare values with no header above them, so it has to say
// which is which — otherwise a project name, a path and a timestamp read as
// three anonymous strings.
async function phaseAStackedRowSaysWhichValueIsWhich() {
  for (const [, rowTestId] of ROWS) {
    const rowText = await page.evaluate((testId) => {
      const row = document.querySelector(`[data-testid="${testId}"]`);
      return row ? row.innerText.replace(/\s+/g, ' ').trim() : null;
    }, rowTestId);
    assert.ok(rowText, `${rowTestId} should be readable`);

    // What the values are called is not restated here: the words come from the
    // headings the desktop puts above the same columns, whatever the locale.
    // The first column is the title, which is its own label, and the last is
    // the actions, which carry theirs on the buttons.
    const { headings, cells } = desktopRows.get(rowTestId);
    assert.equal(headings.length, cells.length, `${rowTestId}: a heading per cell`);

    for (let column = 1; column < headings.length - 1; column += 1) {
      // The label has to sit with its own value, not merely somewhere in the
      // row — a word that happens to appear inside a button label is not a
      // heading for the value three lines above it.
      const labelled = `${headings[column]} ${cells[column]}`.replace(/\s+/g, ' ').toLowerCase();
      assert.ok(
        rowText.toLowerCase().includes(labelled),
        `${rowTestId} must show "${headings[column]}" against its own value`
          + ` — expected "${labelled}" in "${rowText}"`,
      );
    }
  }
}

// -------------------------------------------------------------------- main ---

const phases = [
  ['the desktop table is unchanged', phaseTheDesktopTableIsUnchanged],
  ['the archive tab does not scroll sideways on a phone', phaseTheArchiveTabDoesNotScrollSidewaysOnAPhone],
  ['every column is still reachable on a phone', phaseEveryColumnIsStillReachableOnAPhone],
  ['no value is cut off on a phone', phaseNoValueIsCutOffOnAPhone],
  ['a stacked row says which value is which', phaseAStackedRowSaysWhichValueIsWhich],
];

let failure = null;
try {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await run('git', ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', 'init', '-b', 'main'], {
    cwd: projectDir,
  });

  port = await reservePort();
  origin = `http://127.0.0.1:${port}`;
  await startServer();

  // The fixture lives on the Linux filesystem, which a native-mode server
  // refuses to register.
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  assert.equal(settings.ok, true, `could not set the agent environment: ${settings.text}`);
  const registered = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ folderPath: projectDir }),
  });
  assert.equal(registered.ok, true, `could not register the project: ${registered.text}`);

  browser = await launchPhoneBrowser();

  for (const [name, phase] of phases) {
    try {
      await phase();
      results.push(`ok   ${name}`);
      console.log(`ok   ${name}`);
    } catch (error) {
      results.push(`FAIL ${name}: ${error.message}`);
      console.error(`FAIL ${name}`);
      throw error;
    }
  }
} catch (error) {
  failure = error;
  console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(artifactDir, 'failure.html'), await page.content().catch(() => ''), 'utf8')
      .catch(() => {});
  }
  console.error(logs().slice(-4000));
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${results.join('\n')}`);
if (failure) process.exit(1);
