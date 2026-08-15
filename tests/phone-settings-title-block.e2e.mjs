/**
 * The Settings title block leaves the body most of the dialog (issue #267).
 *
 * "Send feedback" and the close button sat beside the title text, so at 360px the
 * text column was squeezed to 96px at the default font scale and to nothing at all
 * at the largest: the description wrapped one word to a line and the block took
 * 265px, then 463px, of a 698px dialog — more than the nav and the body together.
 *
 * Measured at the phone viewport (360x776 — the height the device really gives the
 * page, #265) at the three font scales the issue names, and once at desktop, which
 * the change also reaches.
 *
 * What this cannot settle: whether the collapsed feedback button is recognisable as
 * "send feedback" from its icon alone. That is on the issue as a device step.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHONE_VIEWPORT } from './helpers/phone-viewport.mjs';
import { startSettingsHarness } from './helpers/settings-dialog-harness.mjs';

/**
 * Both ends of `FONT_SCALE_OPTIONS`. The largest is where the text column collapsed
 * to nothing; the smallest is where a `rem`-declared hit area is at its thinnest, so
 * the 44px floor below is only really tested there.
 */
const SMALLEST_FONT_SCALE = 0.8125;
const LARGEST_FONT_SCALE = 1.375;

/**
 * The defect as a number: the description got 29% of the dialog's inner width at
 * the default scale and 0% at the largest, which is what "one word per line" is.
 * 88% and 82% once the buttons moved off its row.
 */
const MIN_DESCRIPTION_WIDTH_SHARE = 0.6;

/**
 * And the block's share of the dialog's height: 38% and 66% before, 17% and 32%
 * after. The nav beside it is held to 25% by #264; the body keeps the rest.
 */
const MAX_TITLE_SHARE = 0.35;

/** Desktop must not pay for the phone layout. It measured 129px before the change. */
const MAX_DESKTOP_TITLE_HEIGHT = 140;

/**
 * The floor a finger needs, in CSS px (`PHONE_TOUCH_TARGET_PX`, #259) — restated here
 * because that constant is TypeScript. The feedback button is what makes this this
 * ticket's problem: collapsing its label to an icon is what shrank it.
 */
const MIN_TOUCH_TARGET = 44;

const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-settings-title-e2e');
const results = [];

/** The block, the dialog it sits in, and the description whose width is the defect. */
async function measureTitleBlock(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const modal = document.querySelector('[data-testid="settings-modal"]');
    const content = document.querySelector('[data-testid="settings-content"]');
    // The title block is whatever sits between the nav and the body — found by
    // position, not by a class name, which is not what anyone would change.
    const header = content.previousElementSibling;
    const description = Array.from(header.querySelectorAll('p')).at(-1);
    return {
      modalHeight: round(modal.getBoundingClientRect().height),
      modalClientWidth: modal.clientWidth,
      titleHeight: round(header.getBoundingClientRect().height),
      bodyHeight: round(content.getBoundingClientRect().height),
      descriptionWidth: round(description.getBoundingClientRect().width),
      feedbackBox: (() => {
        const rect = document.querySelector('[data-testid="settings-feedback"]').getBoundingClientRect();
        return { width: round(rect.width), height: round(rect.height) };
      })(),
      feedbackText: document.querySelector('[data-testid="settings-feedback"]').innerText.trim(),
      rootFontSize: round(parseFloat(getComputedStyle(document.documentElement).fontSize)),
      documentScrollWidth: document.documentElement.scrollWidth,
    };
  });
}

async function phonePhase(harness, fontScale) {
  const label = `phone/scale-${fontScale}`;
  const { context, page } = await harness.openSettingsPage({ viewport: 'phone', fontScale });
  try {
    const m = await measureTitleBlock(page);
    assert.ok(
      Math.abs(m.rootFontSize - 16 * fontScale) <= 0.5,
      `${label}: the root font is ${m.rootFontSize}px, not ${16 * fontScale}px — the scale never applied`,
    );
    const widthShare = m.descriptionWidth / m.modalClientWidth;
    const titleShare = m.titleHeight / m.modalHeight;
    results.push(
      `${label}: dialog ${m.modalHeight}px, title ${m.titleHeight} (${Math.round(titleShare * 100)}%),`
      + ` body ${m.bodyHeight}; description ${m.descriptionWidth}px of ${m.modalClientWidth}`
      + ` (${Math.round(widthShare * 100)}%); feedback ${m.feedbackBox.width}x${m.feedbackBox.height}`,
    );

    assert.ok(
      widthShare >= MIN_DESCRIPTION_WIDTH_SHARE,
      `${label}: the description gets ${m.descriptionWidth}px of a ${m.modalClientWidth}px dialog`
        + ` (${Math.round(widthShare * 100)}%, floor ${Math.round(MIN_DESCRIPTION_WIDTH_SHARE * 100)}%)`
        + ' — something beside it is squeezing its column again',
    );
    assert.ok(
      titleShare <= MAX_TITLE_SHARE,
      `${label}: the title block takes ${m.titleHeight}px of ${m.modalHeight}px`
        + ` (${Math.round(titleShare * 100)}%, ceiling ${Math.round(MAX_TITLE_SHARE * 100)}%)`,
    );
    assert.ok(
      m.feedbackBox.width >= MIN_TOUCH_TARGET && m.feedbackBox.height >= MIN_TOUCH_TARGET,
      `${label}: the collapsed feedback button is ${m.feedbackBox.width}x${m.feedbackBox.height},`
        + ` under the ${MIN_TOUCH_TARGET}px a finger needs`,
    );
    assert.equal(
      m.documentScrollWidth,
      PHONE_VIEWPORT.width,
      `${label}: the page scrolls sideways (scrollWidth ${m.documentScrollWidth})`,
    );

    await page.screenshot({ path: path.join(artifactDir, `phone-settings-title-${fontScale}.png`) });
  } finally {
    await context.close();
  }
}

/**
 * Above the Phone viewport step the block keeps the height it had, and the button
 * whose label collapses on a phone still carries it here.
 */
async function desktopPhase(harness) {
  const { context, page } = await harness.openSettingsPage({ viewport: 'desktop', fontScale: 1 });
  try {
    const m = await measureTitleBlock(page);
    results.push(`desktop: title ${m.titleHeight}px, feedback button reads "${m.feedbackText}"`);
    assert.ok(
      m.titleHeight <= MAX_DESKTOP_TITLE_HEIGHT,
      `desktop: the title block grew to ${m.titleHeight}px, over the ${MAX_DESKTOP_TITLE_HEIGHT}px it had`,
    );
    assert.ok(
      m.feedbackText.length > 0,
      'desktop: the feedback button lost its label — the phone collapse leaked above the step',
    );
    await page.screenshot({ path: path.join(artifactDir, 'desktop-settings-title.png') });
  } finally {
    await context.close();
  }
}

await fs.mkdir(artifactDir, { recursive: true });
const harness = await startSettingsHarness();
try {
  for (const scale of [SMALLEST_FONT_SCALE, 1, LARGEST_FONT_SCALE]) {
    await phonePhase(harness, scale);
    console.log(`ok phone/${scale}`);
  }
  await desktopPhase(harness);
  console.log('ok desktop');
  console.log(results.join('\n'));
  console.log(`\nartifacts: ${artifactDir}`);
} catch (error) {
  console.error(results.join('\n'));
  console.error(harness.logs());
  console.error(error);
  process.exitCode = 1;
} finally {
  await harness.stop();
}
