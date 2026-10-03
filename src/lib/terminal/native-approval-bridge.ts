import { nativeApprovalRequestSchema, type NativeApprovalRequest, type NativeWriteFence } from '@/lib/automation/activation-contracts';
import type { DispatchResult } from '@/lib/automation/runtime-port';
import { isDeepStrictEqual } from 'node:util';

export type NativeApprovalOffer = { requestId: string; requestHash: string; optionId: string };
export type NativeApprovalOutput = { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: { behavior: 'allow' | 'deny' } } };
type Pending = { request: NativeApprovalRequest; offer: (value: NativeApprovalOffer | null) => void;
  settled?: (result: DispatchResult) => void;
  timer: ReturnType<typeof setTimeout>; phase: 'waiting' | 'offered' | 'committed';
  response?: { finish: (result: DispatchResult) => void; fence: NativeWriteFence; assert: () => void;
    signal: AbortSignal; abort: () => void; optionId: string } };

/** One hook invocation, one native stdout response. HTTP offers are not native delivery. */
export class NativeApprovalBridge {
  private pending = new Map<string, Pending>();
  private seen = new Set<string>();

  open(raw: NativeApprovalRequest, settled?: (result: DispatchResult) => void): Promise<NativeApprovalOffer | null> {
    const request = nativeApprovalRequestSchema.parse(raw);
    if (this.seen.has(request.requestId) || this.seen.size >= 4096 || request.deadlineAt <= Date.now()
      || this.current(request.identity.userId, request.identity.sessionId)) {
      settled?.({ kind: 'cancelled', reason: 'APPROVAL_STALE' });
      return Promise.resolve(null);
    }
    this.seen.add(request.requestId);
    return new Promise(resolve => {
      const timer = setTimeout(() => this.cancel(request.requestId), Math.min(120_000, request.deadlineAt - Date.now()));
      timer.unref();
      this.pending.set(request.requestId, { request, offer: resolve, timer, phase: 'waiting', settled });
    });
  }
  current(userId: string, sessionId: string): NativeApprovalRequest | null {
    const value = [...this.pending.values()].find(p => p.request.identity.userId === userId && p.request.identity.sessionId === sessionId);
    return value ? structuredClone(value.request) : null;
  }
  respond(args: { expected: NativeApprovalRequest; optionId: string; writeFence: NativeWriteFence; signal: AbortSignal },
    assertCurrent: (request: NativeApprovalRequest) => void): Promise<DispatchResult> {
    const pending = this.pending.get(args.expected.requestId);
    if (!pending || pending.phase !== 'waiting' || !isDeepStrictEqual(pending.request, args.expected)
      || args.signal.aborted || !pending.request.options.some(o => o.id === args.optionId && ['approve-once', 'deny'].includes(o.effect)))
      return Promise.resolve({ kind: 'cancelled', reason: 'APPROVAL_STALE' });
    try { assertCurrent(pending.request); } catch { this.cancel(pending.request.requestId); return Promise.resolve({ kind: 'cancelled', reason: 'APPROVAL_STALE' }); }
    return new Promise(resolve => {
      const abort = () => this.cancel(pending.request.requestId);
      pending.response = { finish: resolve, fence: args.writeFence, assert: () => assertCurrent(pending.request),
        signal: args.signal, abort, optionId: args.optionId };
      args.signal.addEventListener('abort', abort, { once: true });
      pending.phase = 'offered';
      pending.offer({ requestId: pending.request.requestId, requestHash: pending.request.requestHash, optionId: args.optionId });
    });
  }
  commit(requestId: string, hash: string, send: (output: NativeApprovalOutput) => void): boolean {
    const pending = this.pending.get(requestId), response = pending?.response;
    if (!pending || !response || pending.request.requestHash !== hash || pending.phase !== 'offered') return false;
    try {
      response.assert();
      if (response.signal.aborted || pending.request.deadlineAt <= Date.now()) throw new Error('Approval cancelled.');
      // A durable fence can persist its marker then throw: possible response remains unknown.
      pending.phase = 'committed';
      response.fence('begin', () => {
        response.assert();
        if (response.signal.aborted) throw new Error('Approval cancelled.');
        const option = pending.request.options.find(o => o.id === response.optionId)!;
        send({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: option.effect === 'approve-once' ? 'allow' : 'deny' } } });
      });
      return true;
    } catch { this.cancel(requestId); return false; }
  }
  acknowledge(requestId: string, hash: string): boolean {
    const pending = this.pending.get(requestId), response = pending?.response;
    if (!pending || !response || pending.phase !== 'committed' || pending.request.requestHash !== hash) return false;
    try {
      response.fence('complete', () => response.assert());
      this.finish(pending, { kind: 'delivered', sessionId: pending.request.identity.sessionId,
        terminalId: pending.request.identity.terminalId, at: Date.now() });
      return true;
    } catch { this.cancel(requestId); return false; }
  }
  cancel(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending) this.finish(pending, pending.phase === 'committed'
      ? { kind: 'unknown', reason: 'APPROVAL_RESPONSE_UNKNOWN', sessionId: pending.request.identity.sessionId }
      : { kind: 'cancelled', reason: 'APPROVAL_CANCELLED' });
  }
  private finish(pending: Pending, result: DispatchResult) {
    clearTimeout(pending.timer);
    pending.response?.signal.removeEventListener('abort', pending.response.abort);
    this.pending.delete(pending.request.requestId);
    pending.offer(null);
    pending.response?.finish(result);
    pending.settled?.(result);
  }
}
