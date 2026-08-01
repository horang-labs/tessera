/**
 * Whether the server is on its way out.
 *
 * Shutdown kills every PTY it owns, and those deaths look exactly like a
 * process finishing on its own — a preparation run torn down mid-script
 * reports an exit code like any other. Anything that records an outcome from a
 * runtime exit has to be able to tell the two apart, or an interrupted run is
 * written down as though it had completed.
 *
 * Kept on globalThis because the flag is set by the server entrypoint and read
 * from inside the Next bundle, which are separate module graphs.
 */

const SERVER_SHUTTING_DOWN_KEY = Symbol.for('tessera.serverShuttingDown');
const lifecycleGlobal = globalThis as unknown as Record<symbol, boolean | undefined>;

export function markServerShuttingDown(): void {
  lifecycleGlobal[SERVER_SHUTTING_DOWN_KEY] = true;
}

export function isServerShuttingDown(): boolean {
  return lifecycleGlobal[SERVER_SHUTTING_DOWN_KEY] === true;
}
