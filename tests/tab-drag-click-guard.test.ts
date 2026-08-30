import assert from 'node:assert/strict';
import test from 'node:test';

import { transitionTabClickSuppression } from '@/lib/tab/tab-drag-click-guard';

test('a normal tab click activates the tab', () => {
  const result = transitionTabClickSuppression(false, 'click');

  assert.deepEqual(result, { suppressed: false, shouldActivate: true });
});

test('the synthetic click emitted by a completed drag is suppressed once', () => {
  const dragging = transitionTabClickSuppression(false, 'drag-start');
  const syntheticClick = transitionTabClickSuppression(dragging.suppressed, 'click');

  assert.deepEqual(syntheticClick, { suppressed: false, shouldActivate: false });
});

test('a fresh pointer interaction clears suppression when dragend was missed', () => {
  const dragging = transitionTabClickSuppression(false, 'drag-start');
  const recovered = transitionTabClickSuppression(dragging.suppressed, 'pointer-down');
  const deliberateClick = transitionTabClickSuppression(recovered.suppressed, 'click');

  assert.deepEqual(deliberateClick, { suppressed: false, shouldActivate: true });
});
