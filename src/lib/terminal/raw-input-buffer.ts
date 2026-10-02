import type { TerminalInputResult } from '@/lib/automation/contracts';

type RetainedInput = { requestId: string; terminalId: string; data: string; outcome: 'pending' | 'rejected' | 'unknown' };
const retained = new Map<string, RetainedInput>();
const listeners = new Set<() => void>();
let version = 0;
function changed() { version++; for (const listener of listeners) listener(); }
/** Socket enqueue is not acceptance. Pending/uncertain input is never replayed automatically. */
export function retainTerminalInput(requestId: string, terminalId: string, data: string) {
  retained.set(requestId, { requestId, terminalId, data, outcome: 'pending' }); changed();
}
export function settleTerminalInput(result: Pick<TerminalInputResult, 'requestId' | 'outcome'>) {
  const entry = retained.get(result.requestId);
  if (!entry) return;
  if (result.outcome === 'accepted') retained.delete(result.requestId);
  else retained.set(result.requestId, { ...entry, outcome: result.outcome });
  changed();
}
export function retainDisconnectedInput() {
  for (const [id, entry] of retained) if (entry.outcome === 'pending') retained.set(id, { ...entry, outcome: 'unknown' });
  changed();
}
export function getRetainedTerminalInput(terminalId: string): string {
  return [...retained.values()].filter(value => value.terminalId === terminalId && value.outcome !== 'pending').map(value => value.data).join('');
}
export function clearRetainedTerminalInput(terminalId: string) {
  for (const [id, entry] of retained) if (entry.terminalId === terminalId && entry.outcome !== 'pending') retained.delete(id);
  changed();
}
export function subscribeRetainedTerminalInput(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function retainedTerminalInputVersion() { return version; }
