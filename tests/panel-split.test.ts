import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getPanelSplitSpec,
  isPanelLargeEnoughToSplit,
  isPanelSplitPlacement,
} from '@/lib/panel/panel-split';

test('maps all four placements onto the panel store split model', () => {
  assert.deepEqual(getPanelSplitSpec('left'), { direction: 'horizontal', position: 'before' });
  assert.deepEqual(getPanelSplitSpec('right'), { direction: 'horizontal', position: 'after' });
  assert.deepEqual(getPanelSplitSpec('up'), { direction: 'vertical', position: 'before' });
  assert.deepEqual(getPanelSplitSpec('down'), { direction: 'vertical', position: 'after' });
});

test('validates split placement values crossing the Electron bridge', () => {
  assert.equal(isPanelSplitPlacement('left'), true);
  assert.equal(isPanelSplitPlacement('down'), true);
  assert.equal(isPanelSplitPlacement('center'), false);
  assert.equal(isPanelSplitPlacement(null), false);
});

test('requires enough room for both resulting panels', () => {
  assert.equal(isPanelLargeEnoughToSplit({ width: 500, height: 300 }, 'horizontal'), true);
  assert.equal(isPanelLargeEnoughToSplit({ width: 499, height: 300 }, 'horizontal'), false);
  assert.equal(isPanelLargeEnoughToSplit({ width: 500, height: 300 }, 'vertical'), true);
  assert.equal(isPanelLargeEnoughToSplit({ width: 500, height: 299 }, 'vertical'), false);
});
