import { AutorunEngine } from './autorun-engine';
import { randomUUID } from 'node:crypto';
import type { AutomationAuthority, Boundary, DispatchPermit, DispatchResult, RunSpec, RuntimeObservation } from './runtime-port';
import { isAutorun } from './autorun-storage';
import logger from '../logger';
import { sameSessionSelection, type InputOwnership } from './contracts';
import type { StoredAutomation, StoredRun } from './repository';
import { AutomationService, fail, type Inspection } from './service';
import { dueOccurrence, MAX_LATENESS_MS } from './schedule';
import { automationServiceTier } from './service-tier';

const pending = (r: StoredRun) => ['pending', 'deferred', 'dispatching'].includes(r.run.state);
export class AutomationEngine implements AutomationAuthority {
  private epoch: number | null = null;
  private recoveredEpoch: number | null = null;
  private recoveredRuntime = false;
  private ticking = false;
  private stopping = false;
  private inFlight = new Map<string, Promise<void>>();
  private inspections = new Map<string, Inspection>();
  private counts = { due: 0, deferred: 0, delivered: 0, unknown: 0, duplicateClaimsPrevented: 0, leaseLoss: 0, missedSlots: 0 };
  private lastClock: { wall: number; monotonic: number } | null = null;
  readonly autorun: AutorunEngine;
  constructor(readonly service: AutomationService, readonly instanceId = randomUUID()) { this.autorun=new AutorunEngine(service,instanceId,()=>this.epoch,(a,d,prompt)=>this.createAutorunRun(a,d,prompt),id=>this.dispatchAutorun(id)); }
  get repo() { return this.service.repo; }
  get now() { return this.service.deps.now(); }
  private lease(epoch = this.epoch): void {
    if (epoch === null || !this.repo.ownsLease(this.instanceId, epoch, this.now)) fail('OWNER_UNAVAILABLE', 'Scheduler lease is unavailable.');
  }
  loadRun(runId: string): RunSpec {
    const r = this.requiredRun(runId);
    return { run: r.run, target: r.snapshot.target, prompt: isAutorun(r.snapshot) ? r.prompt ?? fail('UNRESOLVED_RUN') : r.snapshot.prompt, ownerUserId: r.snapshot.ownerUserId };
  }
  private requiredRun(id: string): StoredRun { return this.repo.run(id) ?? fail('NOT_FOUND'); }
  private createAutorunRun(a: import('./autorun-contracts').AutorunAutomation, d: import('./autorun-storage').StoredDecision, prompt: string): string {
    const b=d.identity.expectedBoundary;
    const r: StoredRun={
      run:{id:randomUUID(),automationId:a.id,automationRevision:a.revision,decisionId:d.detail.id,occurrenceKey:`decision:${d.detail.id}`,
        dueAt:this.now,deadlineAt:Math.min(this.now+MAX_LATENESS_MS,a.limits.expiresAt),coalescedCount:0,state:'pending',reason:null,
        sessionId:a.target.sessionId,terminalId:b.terminalId,boundaryId:b.id,attemptStartedAt:null,deliveredAt:null,finishedAt:null,
        effectiveSelection:a.savedSelection,agentEnvironment:a.agentEnvironment,observedRuntime:'unobserved'},
      snapshot:structuredClone(a),boundary:b,prompt,leaseEpoch:this.epoch,permitToken:null,externalStarted:false,completedWrite:false,retryAt:null,
      canonicalWorktreeId:null,overlapHeld:false,resolvedAt:null,observation:null,recoveryStartedAt:null,recoveryEpoch:null,recoveryOwnerInstance:null,recoveryStatus:'none'};
    this.repo.saveRun(r);return r.run.id;
  }
  private async dispatchAutorun(id:string):Promise<void> {
    if (this.inFlight.has(id)) return this.inFlight.get(id);
    const task=this.dispatch(id).finally(()=>{this.inFlight.delete(id);this.inspections.delete(id);});
    this.inFlight.set(id,task);await task;
  }
  private eligible(r: StoredRun, expectedRevision: number, includeStarted = false) {
    const a = this.repo.get(r.run.automationId)?.automation ?? fail('NOT_FOUND');
    if (this.stopping || a.state !== 'enabled' || a.revision !== expectedRevision || r.run.automationRevision !== expectedRevision ||
      a.limits.expiresAt <= this.now || r.run.deadlineAt <= this.now ||
      a.dispatchCount >= a.limits.maxDispatches + (includeStarted ? 1 : 0)) fail('PAUSE_REQUIRED');
    if (isAutorun(a)) {
      const decision=r.run.decisionId?this.repo.decision(r.run.decisionId):null;
      if (!decision || decision.detail.phase!=='decided' || decision.detail.outcome!=='continue' || decision.detail.runId!==r.run.id ||
        decision.detail.decision?.proposedPrompt!==r.prompt || decision.identity.goalRevision!==a.autorun.objective.revision ||
        decision.identity.leaseEpoch!==r.leaseEpoch || decision.identity.automationRevision!==a.revision) fail('ANALYSIS_STALE');
    }
    this.inspections.get(r.run.id)?.assertCurrent();
    if (!this.inspections.has(r.run.id)) fail('OWNER_UNAVAILABLE');
    return a;
  }
  private reservedSession(r: StoredRun): void {
    if (r.snapshot.target.kind !== 'create-session') return;
    if (!r.run.sessionId) fail('UNRESOLVED_RUN');
    const row = this.repo.db.prepare(`SELECT * FROM sessions WHERE id=? AND deleted=0 AND archived=0 AND worktree_deleted_at IS NULL`).get(r.run.sessionId);
    if (!row) fail('NOT_FOUND');
    const saved = r.run.effectiveSelection;
    if (row.provider !== saved.provider || row.model !== saved.model || row.reasoning_effort !== saved.reasoningEffort ||
      automationServiceTier(row.provider,row.service_tier,true) !== saved.serviceTier || row.worktree_id !== r.snapshot.target.worktreeId) fail('UNSUPPORTED_SELECTION');
  }
  reserveSession(runId: string, create: (sessionId: string) => void): string {
    return this.repo.transaction(() => {
      const r = this.requiredRun(runId); this.lease(r.leaseEpoch);
      this.eligible(r, r.run.automationRevision, r.run.state === 'dispatching');
      if (r.run.sessionId) return r.run.sessionId;
      if (r.snapshot.target.kind !== 'create-session' || !pending(r)) fail('PAUSE_REQUIRED');
      const id = randomUUID(); create(id); r.run.sessionId = id; this.reservedSession(r); this.repo.saveRun(r); return id;
    });
  }
  beginAttempt(runId: string, leaseEpoch: number, expectedRevision: number): DispatchPermit {
    return this.repo.transaction(() => {
      this.lease(leaseEpoch);
      const r = this.requiredRun(runId);
      if (!['pending', 'deferred'].includes(r.run.state) || r.leaseEpoch !== leaseEpoch) fail('UNRESOLVED_RUN');
      this.eligible(r, expectedRevision);
      const stored = this.repo.get(r.run.automationId)!;
      stored.automation.dispatchCount++; stored.automation.updatedAt = this.now;
      r.run.state = 'dispatching'; r.run.attemptStartedAt = this.now; r.permitToken = randomUUID();
      this.repo.save(stored); this.repo.saveRun(r);
      return { runId, leaseEpoch, token: r.permitToken };
    });
  }
  private permit(permit: DispatchPermit): StoredRun {
    this.lease(permit.leaseEpoch);
    const r = this.requiredRun(permit.runId);
    if (r.run.state !== 'dispatching' || r.permitToken !== permit.token || r.leaseEpoch !== permit.leaseEpoch) fail('UNRESOLVED_RUN');
    return r;
  }
  withWriteFence(permit: DispatchPermit, phase: 'begin' | 'complete', write: () => void): void {
    // The marker commits BEFORE calling an external writer. Its exception cannot roll it back.
    this.repo.transaction(() => {
      const r = this.permit(permit);
      if (phase === 'begin') {
        this.eligible(r, r.run.automationRevision, true);
        if (r.externalStarted) fail('UNRESOLVED_RUN');
        r.externalStarted = true;
      } else {
        if (!r.externalStarted || r.completedWrite) fail('UNRESOLVED_RUN');
        r.completedWrite = true;
      }
      this.repo.saveRun(r);
    });
    this.repo.transaction(() => {
      const r = this.permit(permit);
      if (phase === 'begin') this.eligible(r, r.run.automationRevision, true);
      this.inspections.get(r.run.id)?.assertCurrent();
      this.reservedSession(r);
      write();
    });
  }
  recordOutcome(runId: string, outcome: DispatchResult): void {
    let state: string = '';
    const automationId = this.repo.transaction(() => {
      const r = this.requiredRun(runId);
      if (!pending(r)) return r.run.automationId; // callback/return/publication races are idempotent
      if (outcome.kind === 'deferred' && r.run.attemptStartedAt !== null) outcome = { kind: r.externalStarted ? 'unknown' : 'failed', reason: 'admission-after-attempt', sessionId: r.run.sessionId };
      if (['failed', 'cancelled'].includes(outcome.kind) && r.externalStarted) outcome = { kind: 'unknown', reason: 'external-action-uncertain', sessionId: r.run.sessionId };
      if (outcome.kind === 'delivered' && (!r.externalStarted || outcome.sessionId !== r.run.sessionId)) outcome = { kind: 'unknown', reason: 'delivery-identity-unproven', sessionId: r.run.sessionId };
      if (outcome.kind === 'deferred' || outcome.kind === 'delivered' || outcome.kind === 'unknown') this.counts[outcome.kind]++;
      r.run.state = outcome.kind; r.run.reason = 'reason' in outcome ? outcome.reason : null;
      r.retryAt = outcome.kind === 'deferred' ? Math.min(Math.max(this.now + 30_000, outcome.retryAt), r.run.deadlineAt) : null;
      if (outcome.kind !== 'deferred') r.run.finishedAt = this.now;
      if (outcome.kind === 'delivered') { r.run.deliveredAt = outcome.at; r.run.terminalId = outcome.terminalId; }
      if (outcome.kind === 'unknown' && outcome.sessionId && !r.run.sessionId) r.run.sessionId = outcome.sessionId;
      if (['failed', 'cancelled'].includes(outcome.kind)) r.overlapHeld = false;
      if (r.snapshot.target.kind === 'wake-session' && outcome.kind !== 'deferred') {
        const current = this.repo.get(r.run.automationId)!;
        if (current.automation.nextDueAt === r.run.dueAt) { current.automation.nextDueAt = null; this.repo.save(current); }
      }
      this.repo.saveRun(r); state = r.run.state; return r.run.automationId;
    });
    const a = this.repo.get(automationId)!.automation;
    const finished = this.requiredRun(runId).run;
    if (state) logger.info({ automationId, runId, ownerUserId: a.ownerUserId, ruleRevision: finished.automationRevision, leaseEpoch: this.epoch, sessionId: finished.sessionId, dueLateness: this.now - finished.dueAt, duration: finished.attemptStartedAt === null ? null : this.now - finished.attemptStartedAt, outcome: state, admissionReason: finished.reason && /^[a-zA-Z0-9_-]{1,80}$/.test(finished.reason) ? finished.reason : null, counts: this.counts }, 'Automation dispatch outcome');
    if (state === 'unknown' || state === 'failed') this.service.inhibit(a.ownerUserId, a.id, 'paused', state === 'unknown' ? 'delivery-unknown' : 'dispatch-failed');
    else if (state !== 'deferred' && a.state === 'enabled' && a.dispatchCount >= a.limits.maxDispatches) this.service.inhibit(a.ownerUserId, a.id, 'exhausted', 'dispatch-limit');
    this.service.notify(this.repo.get(automationId)!.automation);
  }
  recordInputOwnership(userId: string, ownership: InputOwnership): void {
    this.repo.transaction(() => {
      const values = ownership.automationId ? [this.repo.get(ownership.automationId)] : this.repo.all().filter(v => v.ownership?.sessionId === ownership.sessionId);
      for (const v of values) {
        if (!v || v.automation.ownerUserId !== userId || v.automation.target.kind !== 'wake-session' || v.automation.target.sessionId !== ownership.sessionId) continue;
        v.ownership = ownership; this.repo.save(v);
      }
    });
  }
  pauseWake(userId: string, sessionId: string, reason: string): void {
    for (const v of this.repo.all()) {
      if (v.automation.ownerUserId === userId && v.automation.target.kind === 'wake-session' && v.automation.target.sessionId === sessionId && v.automation.state !== 'deleted') this.service.inhibit(userId, v.automation.id, 'paused', reason);
    }
  }
  private occurrence(value: StoredAutomation, occurrenceKey: string, dueAt: number, coalescedCount = 0, boundary: Boundary | null = null): StoredRun | null {
    const a = value.automation;
    if (isAutorun(a)) return null;
    if (this.repo.occurrenceExists(a.id, a.revision, occurrenceKey)) { this.counts.duplicateClaimsPrevented++; return null; }
    if (boundary && !this.repo.consumeBoundary(boundary,a.id,'heartbeat',this.now)) return null;
    const r: StoredRun = {
      run: { id: randomUUID(), automationId: a.id, automationRevision: a.revision, occurrenceKey, dueAt,
        deadlineAt: Math.min(dueAt + MAX_LATENESS_MS, a.limits.expiresAt), coalescedCount, state: 'pending', reason: null,
        sessionId: a.target.kind === 'wake-session' ? a.target.sessionId : null, terminalId: boundary?.terminalId ?? null,
        boundaryId: boundary?.id ?? null, attemptStartedAt: null, deliveredAt: null, finishedAt: null,
        effectiveSelection: a.savedSelection, agentEnvironment: a.agentEnvironment, observedRuntime: 'unobserved' },
      snapshot: structuredClone(a), boundary, leaseEpoch: this.epoch, permitToken: null, externalStarted: false, completedWrite: false,
      retryAt: null, canonicalWorktreeId: a.target.kind === 'create-session' ? a.target.worktreeId : null,
      overlapHeld: false, resolvedAt: null, observation: null, recoveryStartedAt: null, recoveryEpoch: null,
      recoveryOwnerInstance: null, recoveryStatus: 'none',
    };
    this.repo.saveRun(r); this.counts.due++; this.counts.missedSlots += coalescedCount; return r;
  }
  recordBoundary(event: { userId: string; boundary: Boundary }): void {
    this.repo.transaction(() => {
      this.lease();
      const b = event.boundary;
      if (b.source !== 'confirmed-lead-turn' || b.userId !== event.userId) return;
      for (const v of this.repo.all()) {
        const a = v.automation, e = v.evidence;
        if (a.state !== 'enabled' || a.ownerUserId !== event.userId || a.target.kind !== 'wake-session' ||
          a.target.sessionId !== b.sessionId || a.trigger.kind !== 'turn-complete' || !e || v.ownership?.mode !== 'armed') continue;
        const previous = e.kind === 'completed' ? e.boundary : e;
        if (previous.serverInstanceId !== b.serverInstanceId || previous.terminalId !== b.terminalId || previous.generation !== b.generation ||
          b.turnSequence < previous.turnSequence || (e.kind === 'completed' && b.turnSequence === previous.turnSequence) || b.inputRevision < previous.inputRevision) continue;
        const due = b.completedAt + a.trigger.delayMs;
        if (!isAutorun(a) && !this.occurrence(v, `turn:${b.serverInstanceId}:${b.generation}:${b.turnSequence}`, due, 0, b)) continue;
        v.evidence = { kind: 'completed', boundary: b }; a.nextDueAt = due; a.updatedAt = this.now; this.repo.save(v);
      }
    });
  }
  async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      this.checkClock();
      const now = this.now;
      this.epoch = this.repo.acquireLease(this.instanceId, now);
      if (this.epoch === null || !this.service.deps.runtime()) return;
      if (this.recoveredEpoch !== this.epoch) { await this.recover(); this.recoveredEpoch = this.epoch; this.recoveredRuntime = true; }
      for (const v of this.repo.all()) {
        const a = v.automation;
        if (a.state !== 'enabled') continue;
        if (a.limits.expiresAt <= this.now) { this.service.inhibit(a.ownerUserId, a.id, 'expired', 'expired'); continue; }
        if (a.dispatchCount >= a.limits.maxDispatches && !this.repo.activeRuns(a.id).some(r => r.run.state === 'dispatching')) { this.service.inhibit(a.ownerUserId, a.id, 'exhausted', 'dispatch-limit'); continue; }
        if (isAutorun(a)) continue;
        const ruleId = a.id;
        this.repo.transaction(() => {
          this.lease();
          const current = this.repo.get(ruleId)!;
          const a = current.automation;
          if (a.state !== 'enabled') return;
          const v = current;
          if (a.trigger.kind === 'turn-complete') {
            if (a.nextDueAt !== null && v.evidence?.kind === 'completed') {
              const b = v.evidence.boundary;
              this.occurrence(v, `turn:${b.serverInstanceId}:${b.generation}:${b.turnSequence}`, a.nextDueAt, 0, b);
            }
          } else {
            const due = dueOccurrence(a.trigger, a.nextDueAt, this.now, a.limits.expiresAt);
            if (due && this.occurrence(v, due.occurrenceKey, due.dueAt, due.coalescedCount)) { a.nextDueAt = due.nextDueAt; this.repo.save(v); }
          }
        });
      }
      for (const r of this.repo.dueRuns(this.now)) {
        if (!['pending', 'deferred'].includes(r.run.state) || r.run.dueAt > this.now || (r.retryAt !== null && r.retryAt > this.now) || this.inFlight.has(r.run.id)) continue;
        const task = this.dispatch(r.run.id).finally(() => { this.inFlight.delete(r.run.id); this.inspections.delete(r.run.id); });
        this.inFlight.set(r.run.id, task);
      }
      // Tick never owns a lease renewal while waiting for a provider's preparation/paste.
    } finally { this.ticking = false; }
    await Promise.all([...this.inFlight.values(), this.autorun.tick()]);
  }
  private async dispatch(id: string): Promise<void> {
    let r = this.requiredRun(id);
    if (r.run.deadlineAt <= this.now) {
      this.repo.transaction(() => { r.run.state = 'skipped'; r.run.reason = 'missed-deadline'; r.run.finishedAt = this.now; r.overlapHeld = false; this.repo.saveRun(r); });
      if (r.snapshot.trigger.kind === 'once') this.service.inhibit(r.snapshot.ownerUserId, r.snapshot.id, 'disabled', 'missed-deadline');
      return;
    }
    try {
      const owner = await this.service.authorize(r.snapshot.ownerUserId);
      if (owner.agentEnvironment !== r.snapshot.agentEnvironment) fail('OWNER_UNAVAILABLE');
      const inspection = await this.service.deps.inspect(owner.userId, r.snapshot.target, owner.agentEnvironment);
      if (!sameSessionSelection(inspection.selection, r.run.effectiveSelection)) fail('UNSUPPORTED_SELECTION');
      this.inspections.set(id, inspection);
      const acquired = this.repo.transaction(() => {
        this.lease(); r = this.requiredRun(id);
        if (!['pending', 'deferred'].includes(r.run.state)) return false;
        this.eligible(r, r.run.automationRevision);
        if (this.repo.overlapExists(id, r.run.automationId, inspection.canonicalWorktreeId)) {
          this.counts.deferred++; r.run.state = 'deferred'; r.run.reason = 'overlap-active'; r.retryAt = Math.min(this.now + 30_000, r.run.deadlineAt); this.repo.saveRun(r); return false;
        }
        r.canonicalWorktreeId = inspection.canonicalWorktreeId; r.overlapHeld = r.snapshot.target.kind === 'create-session';
        r.leaseEpoch = this.epoch; this.repo.saveRun(r); return true;
      });
      if (!acquired) return;
      const result = await this.service.runtime().dispatch({ runId: id, leaseEpoch: this.epoch!, expectedRevision: r.run.automationRevision, expectedBoundary: r.boundary });
      this.recordOutcome(id, result);
    } catch {
      r = this.requiredRun(id);
      this.recordOutcome(id, r.externalStarted ? { kind: 'unknown', reason: 'dispatch-uncertain', sessionId: r.run.sessionId } : { kind: 'failed', reason: 'admission-unavailable' });
    }
  }
  private async recover(): Promise<void> {
    this.lease();
    this.autorun.recover();
    for (const value of this.repo.all()) {
      const a = value.automation;
      if (a.target.kind === 'wake-session' && a.state === 'enabled') {
        const live = this.service.runtime().ownership(a.ownerUserId, a.target.sessionId);
        if (this.recoveredRuntime && live.mode === 'armed' && live.automationId === a.id && live.epoch === value.ownership?.epoch) continue;
        this.service.inhibit(a.ownerUserId, a.id, 'paused', 'restart-rearm-required');
      }
    }
    for (let r of this.repo.activeRuns()) {
      if (r.run.state === 'dispatching') {
        this.repo.transaction(() => {
          this.lease(); r.run.state = 'unknown'; r.run.reason = 'restart-during-attempt'; r.run.finishedAt = this.now;
          this.repo.saveRun(r);
        });
        this.service.inhibit(r.snapshot.ownerUserId, r.snapshot.id, 'paused', 'delivery-unknown');
      }
      if (!(r.run.state === 'unknown' && r.resolvedAt === null) && !(r.run.state === 'delivered' && r.overlapHeld)) continue;
      try {
        const owner = await this.service.authorize(r.snapshot.ownerUserId);
        if (owner.agentEnvironment !== r.snapshot.agentEnvironment) fail('OWNER_UNAVAILABLE');
        const inspection = await this.service.deps.inspect(owner.userId, r.snapshot.target, owner.agentEnvironment);
        this.inspections.set(r.run.id, inspection);
        this.lease();
        const result = await this.service.runtime().reconcileRun({ runId: r.run.id, leaseEpoch: this.epoch! });
        this.lease();
        r = this.requiredRun(r.run.id);
        r.recoveryStatus = result.kind === 'observed' || result.kind === 'resumed' ? 'observed' : 'unknown';
        if ('observation' in result && result.observation.userId === r.snapshot.ownerUserId && result.observation.sessionId === r.run.sessionId) {
          r.observation = null; r.run.terminalId = result.observation.terminalId;
        }
        this.repo.saveRun(r);
        this.recordInputOwnership(r.snapshot.ownerUserId, result.inputOwnership);
        if ('observation' in result) this.recordRuntimeObservation(result.observation);
      } catch {
        r = this.requiredRun(r.run.id); r.recoveryStatus = 'unknown'; this.repo.saveRun(r);
      }
    }
  }
  recordRuntimeObservation(event: RuntimeObservation): void {
    const stop = new Set<string>();
    this.repo.transaction(() => {
      for (const r of this.repo.observedRuns(event.userId, event.sessionId)) {
        if (r.snapshot.ownerUserId !== event.userId || r.run.sessionId !== event.sessionId ||
          !['dispatching', 'delivered', 'unknown'].includes(r.run.state)) continue;
        const previous = r.observation;
        if (r.run.terminalId && r.run.terminalId !== event.terminalId) continue;
        if (previous && (previous.serverInstanceId !== event.serverInstanceId || previous.generation !== event.generation ||
          previous.terminalId !== event.terminalId || previous.sequence >= event.sequence)) continue;
        if (!previous && r.boundary && (r.boundary.serverInstanceId !== event.serverInstanceId ||
          r.boundary.generation !== event.generation || r.boundary.terminalId !== event.terminalId)) continue;
        r.observation = event; r.run.terminalId = event.terminalId; r.run.observedRuntime = event.state;
        if (r.run.state !== 'unknown' && ((event.state === 'turn-complete' && event.backgroundWork === 'clear') ||
          (event.state === 'exited' && event.exitKind === 'natural'))) r.overlapHeld = false;
        if (event.exitKind === 'explicit-stop' || event.exitKind === 'shutdown' || event.state === 'input-required') stop.add(r.snapshot.id);
        this.repo.saveRun(r);
      }
    });
    for (const id of stop) this.service.inhibit(event.userId, id, 'paused', event.exitKind ?? 'input-required');
  }
  withRecoveryFence(args: { runId: string; leaseEpoch: number; sessionId: string }, verifyRuntimeOwnership: () => boolean, resume: () => void): void {
    const validate = () => {
      this.lease(args.leaseEpoch);
      const r = this.requiredRun(args.runId), a = this.repo.get(r.run.automationId)!.automation;
      if (this.stopping || r.run.sessionId !== args.sessionId || r.snapshot.target.kind !== 'create-session' ||
        a.state === 'deleted' || a.pauseReason === 'explicit-stop' ||
        !['unknown', 'delivered'].includes(r.run.state)) fail('UNRESOLVED_RUN');
      this.inspections.get(r.run.id)?.assertCurrent();
      this.reservedSession(r);
      return r;
    };
    this.repo.transaction(() => {
      const r = validate();
      if (r.recoveryStartedAt !== null && r.recoveryStatus !== 'observed') fail('UNRESOLVED_RUN', 'A previous resume requires ownership reconciliation.');
      r.recoveryStartedAt = this.now; r.recoveryEpoch = args.leaseEpoch; r.recoveryOwnerInstance = this.instanceId; r.recoveryStatus = 'started';
      this.repo.saveRun(r);
    });
    this.repo.transaction(() => { validate(); if (!verifyRuntimeOwnership()) fail('UNRESOLVED_RUN'); resume(); });
  }
  private checkClock(): boolean {
    const now = this.now, monotonic = performance.now();
    const jumped = Boolean(this.lastClock && Math.abs(now - this.lastClock.wall - (monotonic - this.lastClock.monotonic)) > 10_000);
    this.lastClock = { wall: now, monotonic };
    if (jumped && this.inFlight.size && this.epoch !== null) {
      this.repo.releaseLease(this.instanceId, this.epoch); this.epoch = null; this.recoveredEpoch = null; this.counts.leaseLoss++;
    }
    return jumped;
  }
  heartbeat(): void {
    this.checkClock();
    if (!this.stopping && this.epoch !== null) {
      const current = this.repo.acquireLease(this.instanceId, this.now);
      if (current !== this.epoch) { this.recoveredEpoch = null; this.counts.leaseLoss++; }
      this.epoch = current;
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await this.autorun.stop();
    const elected = this.epoch !== null && this.repo.ownsLease(this.instanceId, this.epoch, this.now);
    for (const v of elected ? this.repo.all() : []) {
      if (v.automation.state === 'enabled' && v.automation.target.kind === 'wake-session') this.service.inhibit(v.automation.ownerUserId, v.automation.id, 'paused', 'shutdown');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.inFlight.values()]), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
    for (const r of this.repo.activeRuns()) {
      if (r.run.state === 'dispatching' && this.inFlight.has(r.run.id)) this.recordOutcome(r.run.id, { kind: 'unknown', reason: 'shutdown-during-attempt', sessionId: r.run.sessionId });
    }
    if (this.epoch !== null) this.repo.releaseLease(this.instanceId, this.epoch);
    this.epoch = null;
  }
}
