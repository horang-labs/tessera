import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearPairingRedemptionFailures,
  getPairingRedemptionRateLimit,
  recordPairingRedemptionFailure,
} from '../src/lib/auth/pairing-rate-limit';

test('rate limits pairing redemption globally after five failures in one minute', () => {
  const startedAt = new Date('2026-08-03T00:00:00.000Z').getTime();
  clearPairingRedemptionFailures();

  for (let index = 0; index < 5; index += 1) {
    assert.equal(getPairingRedemptionRateLimit(startedAt).limited, false);
    recordPairingRedemptionFailure(startedAt);
  }

  assert.deepEqual(getPairingRedemptionRateLimit(startedAt), {
    limited: true,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(getPairingRedemptionRateLimit(startedAt + 60_000), {
    limited: false,
  });
  clearPairingRedemptionFailures();
});
