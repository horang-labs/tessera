import assert from 'node:assert/strict';
import test from 'node:test';
import * as anchoredViewport from '../src/lib/ui/anchored-viewport.ts';

const {
  ANCHORED_VIEWPORT_MARGIN,
  resolveAnchoredSideLeft,
  resolveAnchoredAlignedLeft,
} = anchoredViewport.default ?? anchoredViewport;

test('an anchored element opens to the right of its anchor when there is room', () => {
  // A 320px panel beside a 44px strip on a 1440px desktop: 44 + 6 = 50, and
  // 50 + 320 = 370, far inside 1440 - 12.
  assert.equal(
    resolveAnchoredSideLeft({
      anchorLeft: 0,
      anchorRight: 44,
      elementWidth: 320,
      viewportWidth: 1440,
      gap: 6,
    }),
    50,
  );
});

test('an anchored element flips to the left of its anchor when the right edge is short', () => {
  // Anchor at 700..744 on an 800px viewport: 750 + 320 overflows 788, and the
  // flipped position 700 - 320 - 6 = 374 clears the left margin.
  assert.equal(
    resolveAnchoredSideLeft({
      anchorLeft: 700,
      anchorRight: 744,
      elementWidth: 320,
      viewportWidth: 800,
      gap: 6,
    }),
    374,
  );
});

test('an anchored element sits against the right margin when neither side fits', () => {
  // The reported defect: the bell is in the 44px left strip of a 360px phone, so
  // 44 + 6 + 320 = 370 runs off the screen and there is no room to flip into
  // either. The element is pushed back to 360 - 320 - 12.
  assert.equal(
    resolveAnchoredSideLeft({
      anchorLeft: 0,
      anchorRight: 44,
      elementWidth: 320,
      viewportWidth: 360,
      gap: 6,
    }),
    28,
  );
});

test('an element wider than the viewport still starts at the left margin', () => {
  assert.equal(
    resolveAnchoredSideLeft({
      anchorLeft: 0,
      anchorRight: 44,
      elementWidth: 400,
      viewportWidth: 360,
      gap: 6,
    }),
    ANCHORED_VIEWPORT_MARGIN,
  );
});

test('a right-aligned element keeps its right edge on the anchor when there is room', () => {
  // A 320px panel hanging off a header button ending at 1000px on a 1440px viewport.
  assert.equal(
    resolveAnchoredAlignedLeft({ anchorRight: 1000, elementWidth: 320, viewportWidth: 1440 }),
    680,
  );
});

test('a right-aligned element is pushed off the left edge back to the margin', () => {
  // The same panel hung off a button ending at 200px: 200 - 320 is off-screen.
  assert.equal(
    resolveAnchoredAlignedLeft({ anchorRight: 200, elementWidth: 320, viewportWidth: 360 }),
    ANCHORED_VIEWPORT_MARGIN,
  );
});

test('a right-aligned element is pulled back inside the right margin', () => {
  // An anchor at the very right edge of a 360px phone would put a 320px panel at
  // 40, whose right edge lands on 360 — the margin pulls it to 360 - 320 - 12.
  assert.equal(
    resolveAnchoredAlignedLeft({ anchorRight: 360, elementWidth: 320, viewportWidth: 360 }),
    28,
  );
});
