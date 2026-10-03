import type { NativeAutomationInteractionPort } from './activation-contracts';

const bindings = new WeakMap<object, NativeAutomationInteractionPort>();
/** Terminal helpers bind their actual owned runtime; no global or cross-manager fallback. */
export function bindNativeAutomationInteraction(manager: object, port: NativeAutomationInteractionPort): void {
  bindings.set(manager, port);
}
export function getNativeAutomationInteraction(manager: object): NativeAutomationInteractionPort | null {
  return bindings.get(manager) ?? null;
}
