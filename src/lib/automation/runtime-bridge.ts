import type { AutomationAuthority, AutomationRuntime } from './runtime-port';

type Ports = {
  authority: AutomationAuthority | null;
  runtime: AutomationRuntime | null;
};

// Next routes and the standalone backend can evaluate different copies of this module.
const key = Symbol.for('tessera.automation.ports.v1');
const host = globalThis as typeof globalThis & { [key]?: Ports };
const ports = host[key] ??= { authority: null, runtime: null };

/** Null is unavailable; callers must not enable execution until both ports are installed. */
export function getAutomationAuthority(): AutomationAuthority | null {
  return ports.authority;
}

export function getAutomationRuntime(): AutomationRuntime | null {
  return ports.runtime;
}

function install<K extends keyof Ports>(kind: K, port: NonNullable<Ports[K]>): () => void {
  if (ports[kind]) throw new Error(`Automation ${kind} is already installed.`);
  ports[kind] = port;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (ports[kind] === port) ports[kind] = null;
  };
}

/** Returns an idempotent cleanup owned by this registration. */
export function installAutomationAuthority(authority: AutomationAuthority): () => void {
  return install('authority', authority);
}

export function installAutomationRuntime(runtime: AutomationRuntime): () => void {
  return install('runtime', runtime);
}
