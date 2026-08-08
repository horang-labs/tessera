// Ticket #250 — the hover assumption, in both of its branches.
//
// Tailwind 4 compiles every `hover:` variant to `@media (hover: hover)`, so on a touch
// device those rules do not exist. Two consequences, both verified here:
//
//   (a) a control revealed only by `group-hover:opacity-100` can never be seen on a phone;
//   (b) a row whose only feedback is `hover:bg-…` never acknowledges a tap.
//
// Both are questions about *which CSS rules exist*, which is why this file serves the
// repository itself rather than a copied app root: Tailwind only generates its utility
// layer for the source tree it is pointed at, and a copied root serves the page with no
// utilities at all (#252). Every assertion below would pass vacuously against that.
//
// Visibility is asked of the browser through `checkVisibility({opacityProperty: true})`.
// Playwright's `toBeVisible` ignores opacity, and an `opacity-0` control is precisely the
// defect under test.
//
// What this file deliberately does not settle: whether a real finger on a real Android
// phone perceives the feedback as an acknowledgement. That is a device-only judgement.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
const PROBE_HOST_BOX = { left: 0, top: 0, width: 320, height: 60 };
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

/**
 * The controls that exist only while a pointer hovers them, one entry per place in the
 * source that decides an opacity.
 *
 * `markers` name the class-string literals that decide it. They are looked up in the file
 * and required to be unique, so an entry can never silently drift onto a different
 * control: if a rename makes a marker ambiguous or absent, this suite fails rather than
 * testing the wrong element. The classes come out of the source rather than being
 * restated here, so the probe is always the shipped class list.
 */
const HOVER_REVEALED_SITES = [
  {
    label: 'session title rename hint',
    file: 'src/components/chat/header.tsx',
    markers: ['h-3 w-3 shrink-0 text-(--text-muted)', 'group-hover:opacity-100'],
  },
  {
    label: 'remove a favourite skill',
    file: 'src/components/chat/skill-favorite-button.tsx',
    markers: ['text-(--text-muted) opacity'],
  },
  {
    label: 'remove a session reference chip',
    file: 'src/components/chat/session-ref-chip.tsx',
    markers: ['transition-opacity'],
  },
  {
    label: 'remove an image attachment',
    file: 'src/components/chat/message-input-sections.tsx',
    markers: ['bg-black/60 text-white text-xs'],
  },
  {
    label: 'remove a file attachment',
    file: 'src/components/chat/message-input-sections.tsx',
    markers: ['shrink-0 w-4 h-4 flex items-center justify-center rounded-full'],
  },
  {
    label: 'user and agent message actions',
    file: 'src/components/chat/message-bubble-content.tsx',
    markers: ['ml-auto inline-flex shrink-0 items-center gap-1'],
  },
  {
    label: 'user message timestamp',
    file: 'src/components/chat/message-bubble-content.tsx',
    markers: ['group-focus-within:opacity-100 transition-opacity cursor-default'],
  },
  {
    label: 'agent message timestamp in a bubble',
    file: 'src/components/chat/message-bubble-content.tsx',
    markers: ['group-hover:opacity-100 transition-opacity cursor-default'],
  },
  {
    label: 'agent message group actions',
    file: 'src/components/chat/agent-message-group.tsx',
    markers: ['ml-auto inline-flex shrink-0 items-center gap-1'],
  },
  {
    label: 'agent message group timestamp',
    file: 'src/components/chat/agent-message-group.tsx',
    markers: ['transition-opacity cursor-default'],
  },
  {
    label: 'memory row actions',
    file: 'src/components/memory/memory-panel.tsx',
    markers: ['absolute right-1 top-1.5 flex items-center gap-0.5'],
  },
  {
    label: 'git summary copy button',
    file: 'src/components/git/git-panel-sections.tsx',
    markers: ['h-6 w-6 shrink-0 rounded text-(--text-muted)'],
  },
  {
    label: 'git changed-file row actions',
    file: 'src/components/git/git-panel-sections.tsx',
    markers: ['bg-(--sidebar-hover)/95'],
  },
  {
    label: 'drawer resize grip',
    file: 'src/components/ui/bottom-drawer.tsx',
    markers: ['mx-auto mt-[2px] h-[2px] w-10 rounded-full'],
  },
  {
    label: 'workspace file row actions',
    file: 'src/components/workspace/workspace-file-panel.tsx',
    markers: ['bg-(--sidebar-hover)/95'],
  },
  // The one inversion: the diff-stat column *hides* on hover so the action overlay above
  // can take its place. On a phone the overlay is always shown, so this must be hidden
  // there — the opposite expectation, for the same reason.
  {
    label: 'git changed-file diff stats',
    file: 'src/components/git/git-panel-sections.tsx',
    markers: ['group-hover:opacity-0'],
    hiddenOnPhone: true,
  },
];

/**
 * Branch (b): the markup of the row the ticket was reported against, taken from the
 * component it ships in rather than restated, so this is the element the user taps.
 */
const FILE_ROW_SITE = {
  file: 'src/components/workspace/workspace-file-panel.tsx',
  containerMarkers: ['group relative border-l-2', 'border-l-transparent text-(--text-secondary) hover:bg-'],
  buttonMarkers: ['flex w-full min-w-0 items-center gap-2 border-l-transparent'],
};

/**
 * One of the 21 `active:` sites that already existed. Nothing here rewrites them; this
 * probe only asks whether the new block leaves them alone.
 */
const EXISTING_ACTIVE_SITE = {
  file: 'src/components/terminal/terminal-input-bar.tsx',
  // Was 'h-11 min-w-11 flex-1 rounded border'. #259 took the `rem` sizing off these keys
  // — it was 35.75px at the smallest font scale — and the size now comes from
  // PHONE_TOUCH_TARGET. Same element, same `active:` declarations, which are the only
  // part this probe is about.
  markers: ['flex-1 rounded border'],
};

/** Everything a press is compared through, so no single property is the contract. */
const VISUAL_PROPERTIES = [
  'background-color', 'background-image', 'opacity', 'filter',
  'box-shadow', 'transform', 'color', 'outline-color',
];

const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-mobile-hover-'));
const port = await reservePort();
const appOrigin = `http://127.0.0.1:${port}`;
let serverOutput = '';

// This suite may itself be running inside Tessera; nothing about the host app's session
// may leak into the server under test.
const serverEnv = { ...process.env };
for (const key of [
  'ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT', 'TESSERA_ELECTRON_SERVER',
  'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT', 'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID',
  'TESSERA_DEV_PORT', 'TESSERA_PROJECT_ID', 'TESSERA_WORKTREE_ID',
]) {
  delete serverEnv[key];
}

const server = spawn(
  process.execPath,
  ['./node_modules/.bin/tsx', 'server.ts'],
  {
    cwd: repoRoot,
    detached: true,
    env: {
      ...serverEnv,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'development',
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

server.stdout.on('data', (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
});
server.stderr.on('data', (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
});

let browser;
let appSecret;
try {
  const probes = await buildProbes();
  appSecret = await waitForServer(`${appOrigin}/api/settings`, server);

  const tapProbes = await buildTapProbes();
  browser = await chromium.launch({ headless: true });
  await testControlsAreVisibleOnAPhone(browser, probes);
  await testHoverRevealIsUnchangedOnADesktop(browser, probes);

  const onPhone = await measurePresses(browser, tapProbes, { touch: true });
  const onDesktop = await measurePresses(browser, tapProbes, { touch: false });
  assertTapsAreAcknowledgedOnAPhone(onPhone);
  assertNothingAcknowledgesAPressOnADesktop(onDesktop);
  assertExistingActiveSitesAreUntouched(onPhone, onDesktop);
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- isolated server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (server.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // The isolated server may already have exited after a startup failure.
    }
  }
  await waitForExit(server, 5_000);
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log(
  `ok — ${HOVER_REVEALED_SITES.length} hover-revealed controls and the touch feedback block`
  + ' checked on a phone and on a desktop',
);

// --------------------------------------------------------------------------- probes ---

/**
 * Reads each site's class list out of the source it ships from.
 *
 * `cn` is applied for the same reason the components apply it: two literals in one `cn`
 * call can each set an opacity, and tailwind-merge — not the cascade — decides which one
 * survives. A probe assembled any other way would not be the element the user sees.
 */
async function buildProbes() {
  return Promise.all(HOVER_REVEALED_SITES.map(async (site) => {
    const source = await fs.readFile(path.join(repoRoot, site.file), 'utf8');
    const literals = site.markers.map((marker) => {
      const occurrences = source.split(marker).length - 1;
      assert.equal(
        occurrences,
        1,
        `marker ${JSON.stringify(marker)} matches ${occurrences} places in ${site.file};`
          + ' it must identify exactly one, or this suite is testing the wrong element',
      );
      return classLiteralAround(source, marker, site.file);
    });
    return { ...site, className: twMerge(clsx(literals)) };
  }));
}

/**
 * The elements a press is measured on.
 *
 * `expectAcknowledged` is what branch (b) claims about each: the two targets that declare
 * a hover affordance must answer a tap, and everything the block deliberately excludes
 * must not. The exclusions are the point — a blanket `:active` rule would light all of
 * them up and nobody would notice, because the block never runs on a desktop.
 */
async function buildTapProbes() {
  const rowContainer = await classesFor(FILE_ROW_SITE.file, FILE_ROW_SITE.containerMarkers);
  const rowButton = await classesFor(FILE_ROW_SITE.file, FILE_ROW_SITE.buttonMarkers);
  const existingActive = await classesFor(EXISTING_ACTIVE_SITE.file, EXISTING_ACTIVE_SITE.markers);

  return [
    {
      name: 'the app\'s own add-project button',
      selector: '[data-testid="project-strip-add"]',
      expectAcknowledged: true,
    },
    {
      name: 'a workspace file row',
      html: `<div class="${rowContainer}"><button type="button" class="${rowButton}"`
        + ' data-probe="file-row">file.ts</button></div>',
      selector: '[data-probe="file-row"]',
      expectAcknowledged: true,
    },
    {
      name: 'a disabled control',
      html: '<button type="button" disabled class="hover:bg-(--sidebar-hover) px-4 py-2"'
        + ' data-probe="disabled">disabled</button>',
      selector: '[data-probe="disabled"]',
      expectAcknowledged: false,
    },
    {
      name: 'an aria-disabled control',
      html: '<button type="button" aria-disabled="true" class="hover:bg-(--sidebar-hover) px-4 py-2"'
        + ' data-probe="aria-disabled">disabled</button>',
      selector: '[data-probe="aria-disabled"]',
      expectAcknowledged: false,
    },
    {
      name: 'a drag handle',
      html: '<button type="button" class="cursor-grab active:cursor-grabbing px-4 py-2"'
        + ' data-probe="drag-handle">drag</button>',
      selector: '[data-probe="drag-handle"]',
      expectAcknowledged: false,
    },
    {
      name: 'a scroll container',
      html: '<div class="overflow-y-auto h-8 w-16 px-4 py-2" data-probe="scroll-container">'
        + '<div class="h-40">scroll</div></div>',
      selector: '[data-probe="scroll-container"]',
      expectAcknowledged: false,
    },
    {
      name: 'text being selected',
      html: '<p class="px-4 py-2" data-probe="text">a paragraph a finger may be selecting</p>',
      selector: '[data-probe="text"]',
      expectAcknowledged: false,
    },
    {
      name: 'a control that already declares its own active state',
      html: `<button type="button" class="${existingActive}" data-probe="own-active">key</button>`,
      selector: '[data-probe="own-active"]',
      // It answers the press either way; what matters is *which* rule answers it, which
      // `assertExistingActiveSitesAreUntouched` settles.
      expectAcknowledged: null,
    },
  ];
}

/** The merged class list of one site, read out of the source it ships from. */
async function classesFor(file, markers) {
  const source = await fs.readFile(path.join(repoRoot, file), 'utf8');
  return twMerge(clsx(markers.map((marker) => {
    const occurrences = source.split(marker).length - 1;
    assert.equal(
      occurrences,
      1,
      `marker ${JSON.stringify(marker)} matches ${occurrences} places in ${file};`
        + ' it must identify exactly one, or this suite is testing the wrong element',
    );
    return classLiteralAround(source, marker, file);
  })));
}

/** The whole quoted class string a marker sits inside. */
function classLiteralAround(source, marker, file) {
  const index = source.indexOf(marker);
  const opening = Math.max(
    source.lastIndexOf("'", index),
    source.lastIndexOf('"', index),
    source.lastIndexOf('`', index),
  );
  const quote = source[opening];
  const closing = source.indexOf(quote, index + marker.length);
  assert.ok(
    opening !== -1 && closing !== -1,
    `could not find the class literal around ${JSON.stringify(marker)} in ${file}`,
  );
  return source.slice(opening + 1, closing);
}

// ---------------------------------------------------------------------------- pages ---

/**
 * Mounts every probe inside one hoverable group.
 *
 * The host carries both the anonymous `group` and the named groups these sites use, so a
 * probe's `group-hover/…` variant has something to attach to. It is fixed at the top-left
 * above everything else so a real pointer can actually reach it.
 */
async function mountProbes(page, probes) {
  await page.evaluate(({ probes, box }) => {
    const host = document.createElement('div');
    host.id = 'hover-affordance-probe-host';
    host.className = 'group group/collection group/summary-copy';
    host.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;`
      + `width:${box.width}px;height:${box.height}px;`
      + 'z-index:2147483647;background:#808080;display:flex;gap:4px;align-items:center';
    for (const [index, probe] of probes.entries()) {
      const element = document.createElement('div');
      element.dataset.probe = String(index);
      element.className = probe.className;
      element.textContent = '·';
      host.append(element);
    }
    document.body.append(host);
  }, { probes: probes.map(({ className }) => ({ className })), box: PROBE_HOST_BOX });
}

/** What the browser thinks of each probe right now. */
async function readProbes(page) {
  // `transition-opacity` means a value read immediately is the one being animated away
  // from, not the one that settles.
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const host = document.querySelector('#hover-affordance-probe-host');
    return [...host.querySelectorAll('[data-probe]')].map((element) => ({
      visible: element.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
      }),
      opacity: getComputedStyle(element).opacity,
    }));
  });
}

async function unmountProbes(page) {
  await page.evaluate(() => {
    document.querySelector('#hover-affordance-probe-host')?.remove();
  });
}

/**
 * Branch (a) at Phone viewport: every one of these controls is visible with no hover
 * interaction at all.
 *
 * The pointer is emulated as absent — `hover: none`, `pointer: coarse` — which is what a
 * phone reports and what makes Tailwind's hover rules genuinely not exist. A viewport
 * alone would leave the desktop hover rules live and let a stray pointer account for a
 * pass.
 */
async function testControlsAreVisibleOnAPhone(browserInstance, probes) {
  const context = await createPhoneContext(browserInstance, {
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  const page = await context.newPage();

  try {
    await emulateTouchPointer(page);
    await openChat(page, appOrigin);
    await page.mouse.move(PHONE_VIEWPORT.width - 1, PHONE_VIEWPORT.height - 1);

    await mountProbes(page, probes);
    const measured = await readProbes(page);
    await unmountProbes(page);

    assert.deepEqual(
      disagreements(probes, measured, (probe) => !probe.hiddenOnPhone),
      [],
      `these controls have the wrong visibility at ${PHONE_VIEWPORT.width}px without hover`,
    );
  } finally {
    await context.close();
  }
}

/**
 * The overriding constraint for this wave: a pointer-driven window is untouched.
 *
 * Both halves are asserted, because "still hidden" and "still revealed" fail separately —
 * a fix that simply deleted the hover rules would pass the first and fail the second.
 */
async function testHoverRevealIsUnchangedOnADesktop(browserInstance, probes) {
  const context = await browserInstance.newContext({
    viewport: DESKTOP_VIEWPORT,
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  const page = await context.newPage();

  try {
    await openChat(page, appOrigin);
    await mountProbes(page, probes);

    await page.mouse.move(DESKTOP_VIEWPORT.width - 1, DESKTOP_VIEWPORT.height - 1);
    const away = await readProbes(page);
    assert.deepEqual(
      disagreements(probes, away, (probe) => Boolean(probe.hiddenOnPhone)),
      [],
      'the desktop hover reveal regressed: these controls no longer start hidden',
    );

    // Hovering the group is the whole desktop affordance.
    await page.mouse.move(
      PROBE_HOST_BOX.left + PROBE_HOST_BOX.width / 2,
      PROBE_HOST_BOX.top + PROBE_HOST_BOX.height / 2,
    );
    const onHover = await readProbes(page);
    assert.deepEqual(
      disagreements(probes, onHover, (probe) => !probe.hiddenOnPhone),
      [],
      'the desktop hover reveal regressed: hovering the group no longer reveals these controls',
    );

    await unmountProbes(page);
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------ branch (b) ---

/**
 * Presses each probe and records how it looked before and during the press.
 *
 * The pointer is moved onto the target and left to settle *before* the "before" reading,
 * so a hover style is present in both readings and cancels out. What remains between them
 * is the `:active` state and nothing else — which is what makes the desktop run a real
 * non-regression check rather than a restatement of the hover rules.
 */
async function measurePresses(browserInstance, tapProbes, { touch }) {
  const context = touch
    ? await createPhoneContext(browserInstance, {
      extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
    })
    : await browserInstance.newContext({
      viewport: DESKTOP_VIEWPORT,
      extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
    });
  const page = await context.newPage();

  try {
    if (touch) await emulateTouchPointer(page);
    await openChat(page, appOrigin);

    const readings = [];
    for (const probe of tapProbes) {
      if (probe.html) await mountMarkup(page, probe.html);
      readings.push({ probe, ...await press(page, probe.selector) });
      if (probe.html) await unmountMarkup(page);
    }
    return readings;
  } finally {
    await context.close();
  }
}

async function press(page, selector) {
  const target = page.locator(selector);
  await target.waitFor({ state: 'attached', timeout: 15_000 });
  const box = await target.boundingBox();
  assert.ok(box, `${selector} has no layout box, so it cannot be pressed`);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(250);
  const before = await visualState(page, selector);

  await page.mouse.down();
  await page.waitForTimeout(250);
  const during = await visualState(page, selector);
  await page.mouse.up();
  // A press on a real control opens something; nothing downstream depends on that.
  await page.keyboard.press('Escape').catch(() => undefined);

  return { before, during, acknowledged: JSON.stringify(before) !== JSON.stringify(during) };
}

function visualState(page, selector) {
  return page.evaluate(({ selector, properties }) => {
    const computed = getComputedStyle(document.querySelector(selector));
    return Object.fromEntries(properties.map((name) => [name, computed.getPropertyValue(name)]));
  }, { selector, properties: VISUAL_PROPERTIES });
}

async function mountMarkup(page, html) {
  await page.evaluate((markup) => {
    const host = document.createElement('div');
    host.id = 'tap-probe-host';
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#808080';
    host.innerHTML = markup;
    document.body.append(host);
  }, html);
}

async function unmountMarkup(page) {
  await page.evaluate(() => document.querySelector('#tap-probe-host')?.remove());
}

/** Branch (b): a tap on something that declares a hover affordance is answered. */
function assertTapsAreAcknowledgedOnAPhone(readings) {
  const wrong = readings
    .filter(({ probe }) => probe.expectAcknowledged !== null)
    .filter(({ probe, acknowledged }) => acknowledged !== probe.expectAcknowledged)
    .map(({ probe, acknowledged }) => (
      `${probe.name}: acknowledged=${acknowledged}, expected ${probe.expectAcknowledged}`
    ));
  assert.deepEqual(wrong, [], 'the touch feedback block answered the wrong set of elements');
}

/**
 * The overriding constraint again, and here it is structural: the block lives inside
 * `@media (hover: none)`, so on a pointer-driven window its rules do not exist to be got
 * wrong. Nothing may respond to a press that did not already.
 */
function assertNothingAcknowledgesAPressOnADesktop(readings) {
  const changed = readings
    .filter(({ probe }) => probe.expectAcknowledged !== null)
    .filter(({ acknowledged }) => acknowledged)
    .map(({ probe, before, during }) => (
      `${probe.name}: ${JSON.stringify(before)} -> ${JSON.stringify(during)}`
    ));
  assert.deepEqual(changed, [], 'a press changed a desktop appearance that it did not change before');
}

/**
 * Precedence against the `active:` sites that already existed: a control that declares its
 * own pressed appearance must look exactly the same pressed on a phone as on a desktop,
 * where the new block does not exist at all. Anything else means the block is fighting it.
 */
function assertExistingActiveSitesAreUntouched(onPhone, onDesktop) {
  for (const [index, { probe, during }] of onPhone.entries()) {
    if (probe.expectAcknowledged !== null) continue;
    assert.deepEqual(
      during,
      onDesktop[index].during,
      `${probe.name} looks different pressed on a phone than on a desktop;`
        + ' the touch feedback block is overriding a site that already had an active state',
    );
  }
}

/** The sites whose measured visibility is not what `expected` says it should be. */
function disagreements(probes, measured, expected) {
  return probes
    .map((probe, index) => ({ probe, ...measured[index] }))
    .filter(({ probe, visible }) => visible !== expected(probe))
    .map(({ probe, visible, opacity }) => (
      `${probe.label} (${probe.file}): visible=${visible} opacity=${opacity}`
    ));
}

// ------------------------------------------------------------------------ scaffolding ---

/**
 * Tells the renderer it has no hover-capable pointer. Playwright's `hasTouch` adds touch
 * events but leaves `@media (hover: hover)` matching, and this ticket is entirely about
 * which of those two media queries a rule landed in.
 */
async function emulateTouchPointer(page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'hover', value: 'none' },
      { name: 'any-hover', value: 'none' },
      { name: 'pointer', value: 'coarse' },
      { name: 'any-pointer', value: 'coarse' },
    ],
  });
}

async function openChat(page, origin) {
  // 'load' rather than 'domcontentloaded': an unstyled page has no utility layer at all,
  // which is the one thing every assertion here depends on.
  await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 60_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 30_000 });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
  if (await Promise.race([exited, timedOut]) !== 'timeout') return;
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The process exited between the timeout and the forced cleanup.
    }
  }
  await exited;
}

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const selectedPort = address.port;
  await new Promise((resolve, reject) => listener.close((error) => (
    error ? reject(error) : resolve()
  )));
  return selectedPort;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`isolated Tessera server exited with code ${child.exitCode}`);
    }
    try {
      const secret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      const response = await fetch(url, { headers: { 'x-tessera-app-secret': secret } });
      if (response.ok) return secret;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for isolated Tessera server at ${url}`);
}
