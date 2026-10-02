import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { AutomationService, fail, type ListOptions } from './service';
import { sameSessionSelection } from './contracts';
import { AUTORUN_BOUNDS, PROVEN_SUPERVISOR_COMBINATIONS, autorunConfigSchema, autorunPreviewSchema,
  autorunPreviewInputSchema, autorunEvidenceResultSchema, decodeAutomationInput, sameSupervisorSelection,
  supervisorCapabilitySchema, validateAutomationInputV2, type AutorunInput, type AutorunPreview, type AutorunAutomation,
  type AutorunConfig, type AutomationAttention, type AutorunDecisionSummary } from './autorun-contracts';
import { isAutorun, type DurableControlResult, type DurableControlResponse } from './autorun-storage';
import type { ArmEvidence, AutorunRuntimePort } from './runtime-port';

type Owner = { userId: string; agentEnvironment: 'native' | 'wsl' };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class AutorunService {
  cancelAnalysis: (id: string) => void = () => {};
  private previews = new Map<string, { owner: string; preview: AutorunPreview; at: number }>();
  constructor(readonly service: AutomationService) {}
  private get repo() { return this.service.repo; }
  private get now() { return this.service.deps.now(); }
  runtime(): AutorunRuntimePort { return this.service.runtime().autorun ?? fail('RUNTIME_ADAPTER_UNAVAILABLE'); }
  provider(provider: string) { return this.service.deps.provider?.(provider) ?? fail('SUPERVISOR_UNSUPPORTED'); }
  async preview(userId: string, sessionId: string, raw: unknown = {}, saved?: AutorunAutomation): Promise<AutorunPreview> {
    const owner = await this.service.authorize(userId);
    const parsed = autorunPreviewInputSchema.safeParse(raw);
    if (!parsed.success) fail('INVALID_AUTOMATION');
    const input = parsed.data;
    const inspection = await this.service.deps.inspect(userId, { kind: 'wake-session', sessionId }, owner.agentEnvironment);
    const runtime = this.runtime(), ownership = this.service.runtime().ownership(userId, sessionId);
    const turn = runtime.readTurnEvidence({ userId, agentEnvironment: owner.agentEnvironment, sessionId });
    const previous = saved ?? this.repo.all().map(v => v.automation).filter(isAutorun)
      .filter(a => a.ownerUserId === userId && a.target.sessionId === sessionId).sort((a,b) => b.updatedAt-a.updatedAt)[0];
    const goalRevision = (previous?.autorun.objective.revision ?? 0) + 1;
    let objective: AutorunConfig['objective'] | null = null;
    let newHumanInstructions: AutorunPreview['newHumanInstructions'] = [];
    let readiness: AutorunPreview['readiness'] = turn.kind === 'idle' ? turn :
      { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: turn.kind === 'unavailable' ? turn.reason : 'missing' };
    if (turn.kind === 'running' || turn.kind === 'completed') {
      const native = turn.kind === 'running' ? turn.submission : turn.correlation;
      const evidence = autorunEvidenceResultSchema.safeParse(await this.provider(inspection.selection.provider).readAutorunEvidence({
        userId, agentEnvironment: owner.agentEnvironment, sessionId, providerConversationId: native.providerConversationId,
        inputEpoch: ownership.epoch, workerSelection: inspection.selection, turnEvidence: turn, goalRevision,
        previousHumanSourceIds: previous?.autorun.objective.kind === 'verified-human' ? previous.autorun.objective.sources.map(s => s.recordId) : [],
        signal: AbortSignal.timeout(AUTORUN_BOUNDS.flushWaitMs),
      }));
      if (!evidence.success) fail('CONTEXT_UNAVAILABLE');
      if (evidence.data.kind === 'ok') {
        if (!isDeepStrictEqual(evidence.data.turnEvidence, turn)) fail('ANALYSIS_STALE');
        if (evidence.data.goal.kind === 'verified') objective = { ...evidence.data.goal.objective, revision: goalRevision };
        else if (evidence.data.goal.kind === 'missing' && previous?.autorun.objective.kind === 'explicit')
          objective = { ...previous.autorun.objective, revision: goalRevision };
        newHumanInstructions = evidence.data.newHumanInstructions;
        if (turn.kind === 'running') readiness = turn;
        else if (this.repo.boundaryConsumed(userId, sessionId, turn.boundary.id)) readiness = { kind: 'idle', reason: 'consumed-boundary' };
        else {
          const context = await runtime.captureAnalysisContext({ userId, agentEnvironment: owner.agentEnvironment, sessionId,
            expectedBoundary: turn.boundary, signal: AbortSignal.timeout(AUTORUN_BOUNDS.flushWaitMs) });
          readiness = context.kind === 'ok' ? { kind: 'completed', boundary: turn.boundary, fresh: true,
            context: { contentHash: context.snapshot.contentHash, coverage: context.snapshot.coverage } } : { kind: 'unavailable', code: context.code, reason: context.reason };
        }
      } else readiness = { kind: 'unavailable', code: evidence.data.code, reason: evidence.data.reason };
    }
    if (input.objectiveOverride) objective = { kind: 'explicit', text: input.objectiveOverride, revision: goalRevision };
    const options: AutorunPreview['supervisorOptions'] = [];
    for (const proof of PROVEN_SUPERVISOR_COMBINATIONS) {
      const port = this.service.deps.provider?.(proof.selection.provider);
      if (!port) continue;
      const result = await port.checkSupervisorCapability({ ...owner, selection: proof.selection });
      if (result.kind === 'available') {
        const parsed = supervisorCapabilitySchema.safeParse(result.capability);
        if (parsed.success && sameSupervisorSelection(parsed.data.selection, proof.selection)) options.push(parsed.data);
      }
    }
    inspection.assertCurrent();
    if (ownership.epoch !== this.service.runtime().ownership(userId, sessionId).epoch ||
      !isDeepStrictEqual(turn, runtime.readTurnEvidence({ ...owner, sessionId }))) fail('ANALYSIS_STALE');
    const worker = inspection.selection;
    const preferred = previous?.autorun.supervisor ?? (worker.model && worker.reasoningEffort ? worker : null);
    const recommended = options.find(o => preferred && sameSupervisorSelection(o.selection, preferred as AutorunConfig['supervisor'])) ?? options.find(o => o.selection.serviceTier !== 'fast');
    if (!options.length) readiness = { kind: 'unavailable', code: 'SUPERVISOR_UNSUPPORTED', reason: 'unsupported-version' };
    const preview = autorunPreviewSchema.parse({ version: 1, previewId: randomUUID(), sessionId, goalRevision, objective,
      newHumanInstructions, constraints: input.constraints ?? previous?.autorun.constraints ?? [],
      criteria: input.criteria ?? previous?.autorun.criteria ?? [{ id: 'goal', text: 'Supervisor judgment against the saved objective.' }],
      criterionOrigin: input.criteria ? 'explicit' : previous?.autorun.criterionOrigin ?? 'system-objective',
      workerSelection: worker, supervisorOptions: options, recommendedSupervisor: recommended?.selection ?? null, readiness,
      defaults: { delayMs: 120_000, maxDispatches: 10, maxAnalyses: 20, analysisTimeoutMs: 120_000, expiresAt: this.now + 28_800_000 },
      remaining: { dispatches: previous ? Math.max(0,previous.limits.maxDispatches-previous.dispatchCount) : 10,
        analyses: previous ? Math.max(0,previous.autorun.maxAnalyses-previous.analysisCount) : 20 } });
    for (const [id, cached] of this.previews) if (cached.at < this.now-300_000) this.previews.delete(id);
    if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.previewId, { owner: userId, preview, at: this.now });
    return preview;
  }
  private async prepare(userId: string, input: AutorunInput, saved?: AutorunAutomation) {
    const reference = input.autorun.objective.kind === 'preview' ? this.previews.get(input.autorun.objective.previewId) : null;
    if (input.autorun.objective.kind === 'preview' && (!reference || reference.owner !== userId || reference.preview.sessionId !== input.target.sessionId ||
      reference.at < this.now-300_000 || reference.preview.goalRevision !== input.autorun.objective.goalRevision)) fail('ANALYSIS_STALE');
    const preview = await this.preview(userId, input.target.sessionId, {
      ...(input.autorun.objective.kind === 'explicit' ? { objectiveOverride: input.autorun.objective.text } : reference?.preview.objective?.kind === 'explicit' ? { objectiveOverride: reference.preview.objective.text } : {}),
      constraints: input.autorun.constraints, criteria: input.autorun.criteria,
    }, saved);
    if (reference && digest(preview.objective) !== digest(reference.preview.objective)) fail('ANALYSIS_STALE');
    if (!preview.objective) fail('OBJECTIVE_REQUIRED');
    if (input.enabled && preview.readiness.kind === 'unavailable') fail(preview.readiness.code);
    if (input.enabled && preview.readiness.kind === 'idle') fail('INPUT_BOUNDARY_UNPROVEN');
    if (!preview.supervisorOptions.some(o => sameSupervisorSelection(o.selection, input.autorun.supervisor))) fail('SUPERVISOR_UNSUPPORTED');
    const config = autorunConfigSchema.parse({ ...input.autorun, objective: preview.objective, criterionOrigin: reference?.preview.criterionOrigin ?? preview.criterionOrigin });
    return { preview, config };
  }
  async create(userId: string, key: string, input: AutorunInput, owner: Owner): Promise<DurableControlResult> {
    if (!key || key.length>128) fail('INVALID_AUTOMATION');
    const checked = validateAutomationInputV2(input, { now: this.now });
    if (!checked.success) fail(checked.code);
    const hash = digest(input), replay = () => {
      const existing = this.repo.replay(userId, key);
      if (existing && existing.hash !== hash) fail('IDEMPOTENCY_CONFLICT');
      return existing?.response;
    };
    const old = replay(); if (old) return old;
    const { preview, config } = await this.prepare(userId, input);
    const { enabled, autorun: _config, ...base } = input; void _config;
    const a: AutorunAutomation = { ...base, autorun: config, id: randomUUID(), revision: 1, state: enabled ? 'enabled' : 'disabled', pauseReason: null,
      ownerUserId: userId, agentEnvironment: owner.agentEnvironment, savedSelection: preview.workerSelection,
      nextDueAt: null, dispatchCount: 0, analysisCount: 0, latestDecisionId: null, autorunStatus: 'waiting', attention: null,
      createdAt: this.now, updatedAt: this.now, deletedAt: null };
    const commit = (evidence: ArmEvidence | null = null, ownership: DurableControlResult['inputOwnership'] = null) => this.repo.transaction(() => {
      if (replay()) fail('IDEMPOTENCY_CONFLICT');
      if (this.repo.all().length>=100) fail('INVALID_AUTOMATION');
      this.service.checkWakeAvailable(a); this.assertAdmission(a, preview, evidence);
      if (evidence?.kind === 'completed') a.nextDueAt = this.now+a.trigger.delayMs;
      this.repo.save({ automation: a, evidence, ownership });
      this.repo.remember(userId, key, hash, this.service.detail(userId, a.id), this.now);
    });
    try {
      if (enabled) await this.service.runtime().arm({ userId, sessionId: a.target.sessionId, automationId: a.id, selection: a.savedSelection }, commit);
      else commit();
    } catch (error) { const concurrent = replay(); if (concurrent) return concurrent; throw error; }
    this.service.notify(a); return this.service.detail(userId, a.id);
  }
  private assertAdmission(a: AutorunAutomation, preview: AutorunPreview, evidence: ArmEvidence | null) {
    if (a.limits.expiresAt <= this.now || !sameSessionSelection(a.savedSelection, preview.workerSelection)) fail('ANALYSIS_STALE');
    const turn = this.runtime().readTurnEvidence({ userId: a.ownerUserId, agentEnvironment: a.agentEnvironment, sessionId: a.target.sessionId });
    if (evidence?.kind === 'completed') {
      if (preview.readiness.kind !== 'completed' || turn.kind !== 'completed' || !isDeepStrictEqual(turn.boundary, preview.readiness.boundary) ||
        !isDeepStrictEqual(evidence.boundary, turn.boundary) || this.repo.boundaryConsumed(a.ownerUserId, a.target.sessionId, turn.boundary.id)) fail('ANALYSIS_STALE');
    } else if (evidence) {
      if (preview.readiness.kind !== 'running' || turn.kind !== 'running' || !isDeepStrictEqual(turn, preview.readiness)) fail('ANALYSIS_STALE');
    }
  }
  async edit(userId: string, id: string, revision: number, raw: unknown, owner: Owner): Promise<DurableControlResult> {
    const value = this.service.editable(userId, id, revision);
    const old = value.automation, parsed = decodeAutomationInput(raw);
    if (!isAutorun(old) || !parsed.success || parsed.data.mode !== 'autorun' || parsed.data.enabled || parsed.data.target.sessionId !== old.target.sessionId) fail('INVALID_AUTOMATION');
    const checked = validateAutomationInputV2(parsed.data, { now: this.now }); if (!checked.success) fail(checked.code);
    const { config } = await this.prepare(userId, parsed.data, old);
    const input = parsed.data;
    this.repo.transaction(() => {
      const current = this.service.editable(userId, id, revision); if (!isAutorun(current.automation)) fail('INVALID_AUTOMATION');
      const { enabled: _enabled, autorun: _autorun, ...base } = input; void _enabled; void _autorun;
      Object.assign(current.automation, base, { autorun: config, revision: revision+1, state: 'disabled', pauseReason: null,
        agentEnvironment: owner.agentEnvironment, updatedAt: this.now, nextDueAt: null, autorunStatus: 'paused' });
      current.evidence = null; this.repo.save(current);
    });
    const result = this.service.detail(userId,id); this.service.notify(result.automation); return result;
  }
  async enable(userId: string, id: string, revision: number, owner: Owner): Promise<DurableControlResponse> {
    const a = this.service.editable(userId,id,revision).automation; if (!isAutorun(a)) fail('INVALID_AUTOMATION');
    if (owner.agentEnvironment !== a.agentEnvironment) fail('OWNER_UNAVAILABLE');
    if (a.analysisCount>=a.autorun.maxAnalyses) fail('ANALYSIS_LIMIT');
    if (a.dispatchCount>=a.limits.maxDispatches) fail('INVALID_AUTOMATION');
    if (this.repo.decisions(id).some(d => d.active)) fail('UNRESOLVED_RUN');
    const input: AutorunInput = { ...a, enabled: true, autorun: { ...a.autorun, objective: { kind: 'explicit', text: a.autorun.objective.text } } };
    // Build current human provenance again; retain explicit authored override, require conflicts to be resolved in Edit.
    const preview = await this.preview(userId,a.target.sessionId, a.autorun.objective.kind === 'explicit' ? { objectiveOverride: a.autorun.objective.text } : {}, a);
    if (!preview.objective) fail('OBJECTIVE_REQUIRED');
    if (preview.readiness.kind === 'idle') fail('INPUT_BOUNDARY_UNPROVEN');
    if (preview.readiness.kind === 'unavailable') fail(preview.readiness.code);
    if (!preview.supervisorOptions.some(o => sameSupervisorSelection(o.selection,a.autorun.supervisor))) fail('SUPERVISOR_UNSUPPORTED');
    if (!sameSessionSelection(a.savedSelection,preview.workerSelection) || a.limits.expiresAt<=this.now) fail('ANALYSIS_STALE');
    void input;
    await this.service.runtime().arm({ userId, sessionId: a.target.sessionId, automationId:id, selection:a.savedSelection }, (e,o) => this.repo.transaction(() => {
      const current = this.service.editable(userId,id,revision); if (!isAutorun(current.automation)) fail('INVALID_AUTOMATION');
      this.service.checkWakeAvailable({ ...current.automation,state:'enabled' }); this.assertAdmission(current.automation,preview,e);
      Object.assign(current.automation,{ revision:revision+1,state:'enabled',pauseReason:null,autorunStatus:'waiting',updatedAt:this.now,
        nextDueAt:e.kind==='completed'?this.now+a.trigger.delayMs:null,autorun:{...a.autorun,objective:preview.objective} });
      current.evidence=e;current.ownership=o;this.repo.save(current);
    }));
    const body=this.service.detail(userId,id);this.service.notify(body.automation);return {status:200,body};
  }
  inhibit(id: string, reason: string) {
    this.cancelAnalysis(id);
    for (const decision of this.repo.decisions(id)) if (decision.active && ['reserved','analysing'].includes(decision.detail.phase)) {
      decision.detail.phase='cancelled'; decision.detail.reason='ANALYSIS_STALE'; decision.detail.finishedAt=this.now;
      // In-flight owned processes retain their slot until actual settlement.
      if (!decision.detail.attempts.some(a=>a.finishedAt===null)) decision.active=false;
      this.repo.saveDecision(decision);
    }
    const value=this.repo.get(id);if (!value || !isAutorun(value.automation)) return;
    const a=value.automation;
    if (!['complete','needs-user','error'].includes(a.autorunStatus)) a.autorunStatus='paused';
    this.repo.save(value);void reason;
  }
  decisions(userId: string,id: string,options:ListOptions) {
    this.service.owned(userId,id);
    const values=this.repo.decisions(id).map(d=> { const {packet:_p,packetHash:_h,decision:_d,effectiveSelection:_e,attempts:_a,attention:_t,...summary}=d.detail;
      void _p;void _h;void _d;void _e;void _a;void _t;return summary as AutorunDecisionSummary; });
    const start=options.cursor?values.findIndex(d=>d.id===options.cursor)+1:0,limit=options.limit??50;
    return {items:values.slice(start,start+limit),nextCursor:start+limit<values.length?values[start+limit-1].id:null};
  }
  decision(userId:string,id:string,decisionId:string) {
    this.service.owned(userId,id);const value=this.repo.decision(decisionId);
    if (!value || value.detail.automationId!==id) fail('NOT_FOUND');return value.detail;
  }
  publishAttention(userId:string,identity:AutomationAttention) {
    try { this.service.deps.publishAttention?.(userId,identity); } catch { /* Persisted detail is authoritative. */ }
  }
}
