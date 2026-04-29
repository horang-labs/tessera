/**
 * In-memory login rate limiter
 * Blocks an IP after too many failed attempts within a time window.
 */

interface AttemptRecord {
  count: number;
  firstAttempt: number;
}

const attempts = new Map<string, AttemptRecord>();

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const BLOCK_MS = 15 * 60 * 1000; // 15 minutes block

/** Clean up expired entries periodically */
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of attempts) {
    if (now - record.firstAttempt > WINDOW_MS + BLOCK_MS) {
      attempts.delete(ip);
    }
  }
}, 60 * 1000);

export function isRateLimited(ip: string): { limited: boolean; retryAfterSeconds?: number } {
  const record = attempts.get(ip);
  if (!record) return { limited: false };

  const elapsed = Date.now() - record.firstAttempt;

  // Window expired — reset
  if (elapsed > WINDOW_MS + BLOCK_MS) {
    attempts.delete(ip);
    return { limited: false };
  }

  if (record.count >= MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil((WINDOW_MS + BLOCK_MS - elapsed) / 1000);
    return { limited: true, retryAfterSeconds };
  }

  return { limited: false };
}

export function recordFailedAttempt(ip: string): void {
  const record = attempts.get(ip);
  const now = Date.now();

  if (!record || now - record.firstAttempt > WINDOW_MS + BLOCK_MS) {
    attempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    record.count++;
  }
}

export function clearAttempts(ip: string): void {
  attempts.delete(ip);
}
