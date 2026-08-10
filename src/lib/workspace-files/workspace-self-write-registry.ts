/**
 * Suppress the file-watch echo of our own saves.
 *
 * The primary defence is the PUT response's `mtimeMs` becoming the editor's new
 * baseline, which already makes our own write stop looking like a change. This
 * registry covers the gap between the write landing and that response arriving:
 * a watcher event for a path we just wrote is ours, not the agent's.
 *
 * The TTL matches the slowest delivery path Tessera has — the WSL inotify
 * bridge in a bridged setup — rather than branching on environment.
 */
const SELF_WRITE_TTL_MS = 3_000;

const stampsByKey = new Map<string, number>();

function keyFor(sessionId: string, filePath: string): string {
  return `${sessionId}\u0000${filePath}`;
}

export function markSelfWrite(sessionId: string, filePath: string, now = Date.now()): void {
  stampsByKey.set(keyFor(sessionId, filePath), now);
}

/** Called when a save fails: nothing was written, so nothing should be suppressed. */
export function clearSelfWrite(sessionId: string, filePath: string): void {
  stampsByKey.delete(keyFor(sessionId, filePath));
}

export function isSelfWrite(sessionId: string, filePath: string, now = Date.now()): boolean {
  const key = keyFor(sessionId, filePath);
  const stampedAt = stampsByKey.get(key);
  if (stampedAt === undefined) return false;
  if (now - stampedAt > SELF_WRITE_TTL_MS) {
    stampsByKey.delete(key);
    return false;
  }
  return true;
}
