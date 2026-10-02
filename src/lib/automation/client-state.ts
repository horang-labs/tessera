import type { InputOwnership } from './contracts';

const ownership = new Map<string, Readonly<InputOwnership>>();
const listeners = new Map<string, Set<() => void>>();

/** Stable snapshots for React subscription wrappers; no snapshot ever implies human ownership. */
export function getSessionInputOwnership(sessionId: string): Readonly<InputOwnership> {
  let value = ownership.get(sessionId);
  if (!value) {
    value = Object.freeze({
      sessionId, terminalId: null, epoch: '', mode: 'unavailable',
      automationId: null, runId: null, reason: 'RUNTIME_ADAPTER_UNAVAILABLE',
    });
    ownership.set(sessionId, value);
  }
  return value;
}

export function subscribeSessionInputOwnership(sessionId: string, listener: () => void): () => void {
  let subscribers = listeners.get(sessionId);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(sessionId, subscribers);
  }
  // Each subscription owns its cleanup even when callbacks are reused.
  const notify = () => listener();
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && listeners.get(sessionId) === subscribers) listeners.delete(sessionId);
  };
}

/** B supplies authoritative snapshots/events, and unavailable on disconnect/reconnect pending snapshot.
 * Epochs are opaque: arrival order is transport-owned, never compared lexically here.
 */
export function applySessionInputOwnership(value: InputOwnership): void {
  ownership.set(value.sessionId, Object.freeze({ ...value }));
  for (const listener of [...(listeners.get(value.sessionId) ?? [])]) listener();
}
