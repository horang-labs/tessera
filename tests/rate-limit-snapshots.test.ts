import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexRateLimitSnapshot } from '../src/lib/status-display/rate-limit-snapshots';

test('normalizes duration-less Codex windows to the known five-hour and weekly limits', () => {
  const snapshot = buildCodexRateLimitSnapshot({
    primary: { usedPercent: 42, resetsAt: null, windowDurationMins: null },
    secondary: { usedPercent: 9, resetsAt: null, windowDurationMins: null },
  });

  assert.equal(snapshot.windows[0]?.key, 'primary');
  assert.equal(snapshot.windows[0]?.windowDurationMins, 300);
  assert.equal(snapshot.windows[1]?.key, 'secondary');
  assert.equal(snapshot.windows[1]?.windowDurationMins, 10080);
});
