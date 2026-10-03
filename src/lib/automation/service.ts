import { newActivation } from './activation-state';
import { createHash, randomUUID } from 'node:crypto';
import { type AutomationErrorCode, automationInputSchema, validateAutomationInput, type Automation, type AutomationInput, type ControlResult, type ControlResponse, type InputOwnership, type SessionSelectionSnapshot, type Target, sameSessionSelection } from './contracts';
import type { AutomationRuntime, ArmEvidence } from './runtime-port';
import { AutomationRepository, type StoredAutomation } from './repository';
import type { AutorunProviderPort } from '../cli/providers/session-types';
import { AutorunService } from './autorun-service';
import { isAutorun, type DurableAutomation, type DurableControlResult, type DurableControlResponse } from './autorun-storage';
import { decodeAutomation, decodeAutomationInput } from './autorun-contracts';
import { nextScheduledAt } from './schedule';

export type Inspection = { selection: SessionSelectionSnapshot; canonicalWorktreeId: string | null; assertCurrent(): void };
export type AutomationDependencies = {
  provider?: (provider: string) => AutorunProviderPort | null;
  publishAttention?: (owner: string, attention: import('./autorun-contracts').AutomationAttention) => void;
  now(): number;
  runtime(): AutomationRuntime | null;
  owner(): Promise<{ userId: string; agentEnvironment: 'native' | 'wsl' }>;
  inspect(userId: string, target: Target, environment: 'native' | 'wsl'): Promise<Inspection>;
  publish(automation: DurableAutomation): void;
};
export type ListOptions = { sessionId?: string; worktreeId?: string; includeDeleted?: boolean; cursor?: string; limit?: number };
export function fail(code: AutomationErrorCode, message: string = code): never { throw Object.assign(new Error(message), { code }); }
export function asInput(a: Exclude<DurableAutomation, import('./autorun-contracts').AutorunAutomation>): AutomationInput {
  return { name: a.name, enabled: a.state === 'enabled', target: a.target, trigger: a.trigger, prompt: a.prompt, limits: a.limits };
}
export class AutomationService {
  cancelActivation: (id: string) => void = () => {};
  readonly autorun = new AutorunService(this);
  constructor(readonly repo: AutomationRepository, readonly deps: AutomationDependencies) {}
  async authorize(userId: string) {
    const owner = await this.deps.owner();
    if (!owner.userId) fail('OWNER_UNAVAILABLE');
    if (userId !== owner.userId) fail('OWNER_NOT_ALLOWED');
    return owner;
  }
  owned(userId: string, id: string): StoredAutomation {
    const value = this.repo.get(id);
    if (!value || value.automation.ownerUserId !== userId) fail('NOT_FOUND');
    return value;
  }
  runtime(): AutomationRuntime { return this.deps.runtime() ?? fail('RUNTIME_ADAPTER_UNAVAILABLE'); }
  notify(a: DurableAutomation): void { try { this.deps.publish(a); } catch { /* Publication cannot undo durable delivery. */ } }
  detail(userId: string, id: string): DurableControlResult {
    const { automation, ownership, activation } = this.owned(userId, id);
    const inFlight = this.repo.activeRuns(id).find(r => r.run.state === 'dispatching' || (r.run.state === 'unknown' && r.resolvedAt === null));
    const decoded = decodeAutomation(automation);
    if (!decoded.success) fail('OWNER_UNAVAILABLE');
    return { activation: activation?.projection ?? null, automation: decoded.data, inputOwnership: ownership, inFlightRunId: inFlight?.run.id ?? null };
  }
  list(userId: string, options: ListOptions) {
    const values = this.repo.all().map(v => v.automation).filter(a => a.ownerUserId === userId &&
      (options.includeDeleted || a.state !== 'deleted') &&
      (!options.sessionId || (a.target.kind === 'wake-session' && a.target.sessionId === options.sessionId)) &&
      (!options.worktreeId || (a.target.kind === 'create-session' && a.target.worktreeId === options.worktreeId)))
      .sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
    return page(values.map(a => ({ version: 2 as const, id: a.id, name: a.name, revision: a.revision,
      mode: isAutorun(a) ? 'autorun' as const : a.target.kind === 'wake-session' ? 'heartbeat' as const : 'schedule' as const,
      state: a.state, pauseReason: a.pauseReason, sessionId: a.target.kind === 'wake-session' ? a.target.sessionId : null,
      worktreeId: a.target.kind === 'create-session' ? a.target.worktreeId : null, nextDueAt: a.nextDueAt, dispatchCount: a.dispatchCount,
      analysisCount: isAutorun(a) ? a.analysisCount : 0, latestDecisionId: isAutorun(a) ? a.latestDecisionId : null,
      attention: isAutorun(a) ? a.attention?.identity ?? null : null,
      activation: this.repo.get(a.id)?.activation?.projection ?? null })), options);
  }
  history(userId: string, id: string, options: ListOptions) {
    this.owned(userId, id);
    return page(this.repo.runs(id).map(v => ({ ...v.run, decisionId: v.run.decisionId ?? null })), options);
  }
  async sessionOwnership(userId: string, sessionId: string): Promise<InputOwnership> {
    const owner = await this.authorize(userId);
    const inspected = await this.deps.inspect(userId, { kind: 'wake-session', sessionId }, owner.agentEnvironment);
    inspected.assertCurrent();
    return this.deps.runtime()?.ownership(userId, sessionId) ?? {
      sessionId, terminalId: null, epoch: `unavailable:${sessionId}`, mode: 'unavailable',
      automationId: null, runId: null, reason: 'runtime-adapter-unavailable',
    };
  }
  async setDraftVeto(userId: string, sessionId: string, veto: import('./activation-contracts').AutomationDraftVeto) {
    const owner = await this.authorize(userId);
    const inspected = await this.deps.inspect(userId, { kind: 'wake-session', sessionId }, owner.agentEnvironment);
    inspected.assertCurrent();
    const port = this.runtime().activation ?? fail('RUNTIME_ADAPTER_UNAVAILABLE');
    port.setDraftVeto({ ...owner, sessionId }, veto);
    return { accepted: true as const };
  }
  async create(userId: string, key: string, raw: unknown): Promise<DurableControlResult> {
    const owner = await this.authorize(userId);
    const decoded = decodeAutomationInput(raw);
    if (decoded.success && decoded.data.mode === 'autorun') return this.autorun.create(userId, key, decoded.data, owner);
    if (decoded.success && 'version' in (raw as object)) { const { version: _v, mode: _m, ...legacy } = decoded.data; void _v; void _m; raw = legacy; }
    if (!key || key.length > 128) fail('INVALID_AUTOMATION', 'An Idempotency-Key of 1–128 characters is required.');
    const parsed = automationInputSchema.safeParse(raw);
    if (!parsed.success) fail('INVALID_AUTOMATION');
    const hash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    const replay = () => {
      const old = this.repo.replay(userId, key);
      if (old && old.hash !== hash) fail('IDEMPOTENCY_CONFLICT');
      return old?.response;
    };
    const old = replay(); if (old) return old;
    if (parsed.data.enabled && parsed.data.target.kind === 'create-session') this.runtime();
    const inspection = await this.deps.inspect(userId, parsed.data.target, owner.agentEnvironment);
    const checked = validateAutomationInput(parsed.data, { now: this.deps.now(), isSelectionSupported: () => true });
    if (!checked.success) fail(checked.error.code, checked.error.message);
    const input = checked.data, now = this.deps.now();
    const { enabled, ...config } = input;
    const a: Automation = { ...config, id: randomUUID(), revision: 1, state: enabled ? 'enabled' : 'disabled', pauseReason: null,
      ownerUserId: userId, agentEnvironment: owner.agentEnvironment, savedSelection: inspection.selection,
      nextDueAt: enabled ? nextScheduledAt(input.trigger, now) : null, dispatchCount: 0, createdAt: now, updatedAt: now, deletedAt: null };
    let response: DurableControlResult | undefined;
    const commit = (evidence: ArmEvidence | null = null, ownership: InputOwnership | null = null) => this.repo.transaction(() => {
      const concurrent = replay();
      if (concurrent) { response = concurrent; fail('IDEMPOTENCY_CONFLICT'); }
      if (this.repo.all().length >= 100) fail('INVALID_AUTOMATION', 'The retained automation limit of 100 has been reached.');
      inspection.assertCurrent();
      this.checkWakeAvailable(a);
      if (a.limits.expiresAt <= this.deps.now()) fail('INVALID_AUTOMATION');
      if (evidence?.kind === 'completed' && a.target.kind === 'wake-session' && this.repo.boundaryConsumed(userId,a.target.sessionId,evidence.boundary.id)) fail('INPUT_BOUNDARY_UNPROVEN');
      const stored = { automation: a, evidence, ownership: ownership ?? (a.target.kind === 'wake-session' ? this.deps.runtime()?.ownership(userId, a.target.sessionId) ?? null : null),
        ...(a.target.kind === 'wake-session' ? { activation: newActivation() } : {}) };
      this.repo.save(stored);
      response = this.detail(userId, a.id);
      this.repo.remember(userId, key, hash, response, now);
    });
    try {
      // Enabling records intent. The engine acquires input only for a proven action.
      commit();
    } catch (error) {
      // arm rolls back a temporary takeover when its callback throws. A concurrent
      // identical request can already have committed the retained original result.
      const concurrent = replay(); if (concurrent) return concurrent;
      throw error;
    }
    this.notify(a);
    return response!;
  }
  editable(userId: string, id: string, revision: number): StoredAutomation {
    const v = this.owned(userId, id);
    if (v.automation.state === 'deleted') fail('NOT_FOUND');
    if (v.automation.state === 'enabled') fail('PAUSE_REQUIRED');
    if ((v.ownership && ['armed', 'draining', 'recovery-required'].includes(v.ownership.mode)) ||
      this.repo.activeRuns(id).some(r => r.run.state === 'dispatching' || (r.run.state === 'unknown' && r.resolvedAt === null))) fail('UNRESOLVED_RUN');
    if (v.automation.revision !== revision) fail('REVISION_CONFLICT');
    return v;
  }
  async edit(userId: string, id: string, revision: number, raw: unknown): Promise<DurableControlResult> {
    const owner = await this.authorize(userId), previous = this.editable(userId, id, revision);
    const decoded = decodeAutomationInput(raw);
    if (isAutorun(previous.automation)) return this.autorun.edit(userId, id, revision, raw, owner);
    if (decoded.success && decoded.data.mode === 'autorun') fail('INVALID_AUTOMATION');
    if (decoded.success) { const { version: _v, mode: _m, ...legacy } = decoded.data; void _v; void _m; raw = legacy; }
    const parsed = automationInputSchema.safeParse(raw);
    if (!parsed.success || parsed.data.enabled) fail('INVALID_AUTOMATION');
    const target = parsed.data.target, old = previous.automation.target;
    if (target.kind !== old.kind ||
      (target.kind === 'wake-session' && old.kind === 'wake-session' && target.sessionId !== old.sessionId) ||
      (target.kind === 'create-session' && old.kind === 'create-session' && target.worktreeId !== old.worktreeId)) fail('INVALID_AUTOMATION', 'The automation target cannot change.');
    const inspection = await this.deps.inspect(userId, target, owner.agentEnvironment);
    const checked = validateAutomationInput(parsed.data, { now: this.deps.now(), previousInput: asInput(previous.automation as Automation), isSelectionSupported: () => true });
    if (!checked.success) fail(checked.error.code, checked.error.message);
    this.repo.transaction(() => {
      const v = this.editable(userId, id, revision); inspection.assertCurrent();
      const { enabled: _enabled, ...config } = checked.data;
      Object.assign(v.automation, config, { state: 'disabled', revision: revision + 1, pauseReason: null,
        savedSelection: inspection.selection, agentEnvironment: owner.agentEnvironment, updatedAt: this.deps.now(), nextDueAt: null });
      v.evidence = null; this.cancelUnsent(id, 'edited'); this.repo.save(v);
    });
    const result = this.detail(userId, id); this.notify(result.automation); return result;
  }
  async enable(userId: string, id: string, revision: number): Promise<DurableControlResponse> {
    const owner = await this.authorize(userId), previous = this.editable(userId, id, revision), a = previous.automation;
    if (isAutorun(a)) return this.autorun.enable(userId, id, revision, owner);
    if (a.dispatchCount >= a.limits.maxDispatches) fail('INVALID_AUTOMATION', 'The dispatch limit has been reached.');
    if (owner.agentEnvironment !== a.agentEnvironment) fail('OWNER_UNAVAILABLE', 'The saved agent environment has changed.');
    const inspection = await this.deps.inspect(userId, a.target, a.agentEnvironment);
    if (!sameSessionSelection(inspection.selection, a.savedSelection)) fail('UNSUPPORTED_SELECTION');
    const checked = validateAutomationInput({ ...asInput(a), enabled: true }, { now: this.deps.now(), previousInput: asInput(a), isSelectionSupported: () => true });
    if (!checked.success) fail(checked.error.code, checked.error.message);
    const commit = () => this.repo.transaction(() => {
      const v = this.editable(userId, id, revision); inspection.assertCurrent(); this.checkWakeAvailable({ ...v.automation, state: 'enabled' });
      if (v.automation.limits.expiresAt <= this.deps.now()) fail('INVALID_AUTOMATION');
      this.cancelUnsent(id, 're-enabled');
      v.automation.state = 'enabled'; v.automation.revision++; v.automation.pauseReason = null; v.automation.updatedAt = this.deps.now();
      v.automation.nextDueAt = nextScheduledAt(a.trigger, this.deps.now());
      v.evidence = null;
      if (a.target.kind === 'wake-session') {
        v.activation = newActivation(v.activation?.approvals);
        v.ownership = this.deps.runtime()?.ownership(userId, a.target.sessionId) ?? null;
      }
      this.repo.save(v);
    });
    commit();
    const body = this.detail(userId, id); this.notify(body.automation); return { status: 200, body };
  }
  async resolve(userId: string, id: string, runId: string): Promise<DurableControlResult & { run: import('./contracts').AutomationRun }> {
    await this.authorize(userId); this.owned(userId, id);
    const r = this.repo.run(runId);
    if (!r || r.run.automationId !== id) fail('NOT_FOUND');
    if (r.run.state !== 'unknown') fail('UNRESOLVED_RUN');
    if (r.resolvedAt !== null) return { ...this.detail(userId, id), run: r.run };
    if (!r.run.sessionId) fail('UNRESOLVED_RUN', 'Runtime identity must be reconciled before recovery.');
    const ownership = this.runtime().releaseRecovery({ userId, sessionId: r.run.sessionId, runId }, () => this.repo.transaction(() => {
      const current = this.repo.run(runId)!;
      if (current.run.state !== 'unknown') fail('UNRESOLVED_RUN');
      current.resolvedAt = this.deps.now(); current.overlapHeld = false;
      this.repo.saveRun(current);
      const v = this.owned(userId, id);
      if (v.automation.state !== 'deleted') { v.automation.state = 'disabled'; v.automation.pauseReason = 'acknowledged-no-retry'; v.automation.revision++; }
      v.automation.nextDueAt = null; v.automation.updatedAt = this.deps.now();
      this.repo.save(v);
    }));
    const v = this.owned(userId, id);
    if (v.automation.target.kind === 'wake-session') { v.ownership = ownership; this.repo.save(v); }
    this.notify(v.automation);
    return { ...this.detail(userId, id), run: this.repo.run(runId)!.run };
  }
  checkWakeAvailable(a: DurableAutomation): void {
    if (a.target.kind !== 'wake-session') return;
    const sessionId = a.target.sessionId;
    if (this.repo.all().some(v => v.automation.id !== a.id && v.automation.ownerUserId === a.ownerUserId &&
      ((v.automation.target.kind === 'wake-session' && v.automation.target.sessionId === sessionId && ['enabled', 'paused'].includes(v.automation.state) && ['enabled', 'paused'].includes(a.state)) ||
        (v.ownership?.sessionId === sessionId && ['armed', 'draining', 'recovery-required'].includes(v.ownership.mode))))) fail('ACTIVE_WAKE_EXISTS');
  }
  cancelUnsent(id: string, reason: string): void {
    this.cancelActivation(id);
    for (const r of this.repo.activeRuns(id)) {
      if (!['pending', 'deferred'].includes(r.run.state)) continue;
      r.run.state = 'cancelled'; r.run.reason = reason; r.run.finishedAt = this.deps.now(); r.overlapHeld = false;
      this.repo.saveRun(r);
    }
  }
  async pause(userId: string, id: string, deleted = false): Promise<DurableControlResponse> {
    await this.authorize(userId);
    return this.inhibit(userId, id, deleted ? 'deleted' : 'paused', deleted ? 'deleted' : 'user-pause');
  }
  inhibit(userId: string, id: string, state: DurableAutomation['state'], reason: string): DurableControlResponse {
    const previousRevision=this.owned(userId,id).automation.revision;
    this.repo.transaction(() => {
      const value = this.owned(userId, id), a = value.automation;
      if (a.state !== 'deleted' && (a.state !== state || a.pauseReason !== reason)) {
        a.state = state; a.pauseReason = reason; a.revision++; a.updatedAt = this.deps.now(); a.nextDueAt = null;
        if (state === 'deleted') a.deletedAt = this.deps.now();
        this.repo.save(value);
      }
      this.autorun.inhibit(id, reason);
      this.cancelUnsent(id, reason);
    });
    const value = this.owned(userId, id), a = value.automation;
    if (a.target.kind === 'wake-session' && this.deps.runtime()) {
      value.ownership = this.runtime().drain({ userId, sessionId: a.target.sessionId, automationId: id });
      this.repo.transaction(() => {
        const current = this.owned(userId, id);
        if (!value.ownership?.automationId || value.ownership.automationId === id) {
          current.ownership = value.ownership; this.repo.save(current);
        }
      });
    }
    this.notify(a);
    const current=this.owned(userId,id).automation;
    if (isAutorun(current) && current.revision!==previousRevision && current.attention?.identity.revision===current.revision)
      this.autorun.publishAttention(userId,current.attention.identity);
    const body = this.detail(userId, id);
    return { status: body.inputOwnership?.mode === 'draining' ? 202 : 200, body };
  }
}
function page<T extends { id: string }>(items: T[], options: ListOptions) {
  const start = options.cursor ? items.findIndex(v => v.id === options.cursor) + 1 : 0;
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const selected = items.slice(start, start + limit);
  return { items: selected, nextCursor: start + limit < items.length ? selected.at(-1)!.id : null };
}
