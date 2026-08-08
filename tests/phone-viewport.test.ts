import assert from 'node:assert/strict';
import test from 'node:test';
import { PHONE_VIEWPORT_MEDIA_QUERY } from '@/lib/viewport/phone-viewport';

/** The width the query stops at — `max-width` is inclusive. */
function widestPhoneWidth(): number {
  const bound = Number(/max-width:\s*([\d.]+)px/.exec(PHONE_VIEWPORT_MEDIA_QUERY)?.[1]);
  assert.ok(Number.isFinite(bound), `no max-width in ${PHONE_VIEWPORT_MEDIA_QUERY}`);
  return bound;
}

// The table from issue #242, read off the query the hook actually matches.
// Phone viewport is a strict subset of Compact viewport (<1024px): a narrowed
// desktop window and a tablet must stay out of it, or phone-only behaviour
// reaches a desktop. The 640px row is the one that bites — `max-width: 640px`
// would call a 640px window a phone while `sm:` had already applied to the CSS
// beside it.
test('the phone media query covers a phone and nothing wider', () => {
  const bound = widestPhoneWidth();
  const isPhone = (width: number) => width <= bound;

  assert.equal(isPhone(360), true, 'Galaxy Z Flip main display');
  assert.equal(isPhone(639), true, 'just inside the step');
  assert.equal(isPhone(640), false, "Tailwind's sm: applies from here");
  assert.equal(isPhone(800), false, 'tablet — compact, not phone');
  assert.equal(isPhone(1000), false, 'narrowed desktop window — compact, not phone');
  assert.equal(isPhone(1440), false, 'desktop');
});
