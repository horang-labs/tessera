const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;

interface PairingRateLimitState {
  windowStartedAt: number;
  failedAttempts: number;
}

const STATE_KEY = Symbol.for('tessera.pairingRateLimit');
const rateLimitGlobal = globalThis as typeof globalThis & {
  [STATE_KEY]?: PairingRateLimitState;
};
const state = rateLimitGlobal[STATE_KEY] ??= {
  windowStartedAt: 0,
  failedAttempts: 0,
};

function resetExpiredWindow(now: number): void {
  if (now - state.windowStartedAt >= WINDOW_MS) {
    state.windowStartedAt = now;
    state.failedAttempts = 0;
  }
}

export function getPairingRedemptionRateLimit(now = Date.now()): {
  limited: boolean;
  retryAfterSeconds?: number;
} {
  resetExpiredWindow(now);
  if (state.failedAttempts < MAX_FAILED_ATTEMPTS) return { limited: false };
  return {
    limited: true,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((state.windowStartedAt + WINDOW_MS - now) / 1000),
    ),
  };
}

export function recordPairingRedemptionFailure(now = Date.now()): void {
  resetExpiredWindow(now);
  state.failedAttempts += 1;
}

export function clearPairingRedemptionFailures(): void {
  state.windowStartedAt = 0;
  state.failedAttempts = 0;
}
