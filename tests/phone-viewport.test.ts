import assert from 'node:assert/strict';
import test from 'node:test';
import { PHONE_VIEWPORT_MEDIA_QUERY, isPhoneViewportWidth } from '@/lib/viewport/phone-viewport';

// The table from issue #242. Phone viewport is a strict subset of Compact
// viewport (<1024px): a narrowed desktop window and a tablet must stay out of
// it, or phone-only behaviour reaches a desktop.
test('phone viewport covers a phone and nothing wider', () => {
  assert.equal(isPhoneViewportWidth(360), true, 'Galaxy Z Flip main display');
  assert.equal(isPhoneViewportWidth(639), true, 'just inside the step');
  assert.equal(isPhoneViewportWidth(640), false, "Tailwind's sm: applies from here");
  assert.equal(isPhoneViewportWidth(800), false, 'tablet — compact, not phone');
  assert.equal(isPhoneViewportWidth(1000), false, 'narrowed desktop window — compact, not phone');
  assert.equal(isPhoneViewportWidth(1440), false, 'desktop');
});

// The hook matches this query while the components above it read the predicate.
// A `max-width: 640px` here would call a 640px window a phone while `sm:` had
// already applied to the CSS beside it — the two must break at the same width.
test('the media query the hook matches breaks where the predicate does', () => {
  const upperBound = Number(/max-width:\s*([\d.]+)px/.exec(PHONE_VIEWPORT_MEDIA_QUERY)?.[1]);
  assert.ok(Number.isFinite(upperBound), `no max-width in ${PHONE_VIEWPORT_MEDIA_QUERY}`);

  assert.equal(isPhoneViewportWidth(upperBound), true, 'the widest matching width is a phone');
  assert.equal(isPhoneViewportWidth(640), false, 'and 640px is not, on either side');
  assert.ok(upperBound < 640, 'so the query must stop below 640px');
});
