import type { NativeApprovalRequest, NativeRuntimeIdentity, AutomationDraftVeto } from './activation-contracts';
import type { TerminalAutomationCompletion } from '@/lib/cli/providers/terminal-automation-evidence';
import { AutomationInputError } from './input-error';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type InputOwnership } from './contracts';
import { autorunHookEvidenceSchema, type AutorunHookEvidence, type AutorunTurnEvidence } from './autorun-contracts';
import type { ArmEvidence, AutomationAuthority, Boundary, RuntimeObservation } from './runtime-port';

type State = {
  ownership: InputOwnership; userId: string; generation: number; provider: string; environment: 'native' | 'wsl' | undefined;
  revision: number; turn: number; submittedRevision: number | null; confirmedRevision: number | null;
  children: Set<string>; lifecycleChildren: boolean; backgroundUnknown: boolean; leadCompletionAt: number | null;
  nativeApproval?: NativeApprovalRequest;
  conversationId?: string; nativeSubmission?: { event: Extract<AutorunHookEvidence, { kind: 'submission' }>; revision: number };
  nativeCompletion?: Extract<AutorunHookEvidence, { kind: 'completion' }>; seenNative?: Set<string>;
  boundary: Boundary | null; status: RuntimeObservation['state']; sequence: number;
  draftRevision?: number; writerDraftRevision?: number; lastHookAt: number; candidateRevision: number | null; writer: boolean; waiters: Set<() => void>; automated: boolean; live: boolean;
};

/** Process-owned evidence and input mutex. No screen/silence/subscriber heuristics. */
export class AutomationInputGate {
  readonly serverInstanceId = randomUUID();
  private states = new Map<string, State>();
  private startups = new Map<string, {automationId:string;runId:string}>();
  private drafts = new Map<string, Map<string, AutomationDraftVeto>>();
  authority: () => AutomationAuthority | null = () => null;
  publish: (userId: string, value: InputOwnership) => void = () => {};
  private key(userId: string, sessionId: string) { return JSON.stringify([userId, sessionId]); }
  private state(userId: string, sessionId: string) { return this.states.get(this.key(userId, sessionId)); }

  started(userId: string, sessionId: string, terminalId: string, generation: number, provider: string, environment?: 'native' | 'wsl') {
    const old = this.state(userId, sessionId);
    const startup = this.startups.get(this.key(userId,sessionId));
    this.startups.delete(this.key(userId,sessionId));
    const held = old && old.ownership.mode !== 'human' && old.ownership.mode !== 'unavailable';
    const state: State = { userId, generation, provider, environment, revision: 0, turn: 0, submittedRevision: null, confirmedRevision: null, children: new Set(), lifecycleChildren: false, backgroundUnknown: false, leadCompletionAt: null,
      boundary: null, status: 'starting', sequence: 0, lastHookAt: 0, candidateRevision: null, writer: old?.writer ?? false, waiters: old?.waiters ?? new Set(),
      automated: old?.automated ?? false, live: true,
      ownership: { sessionId, terminalId, epoch: randomUUID(), mode: startup ? 'armed' : held ? 'recovery-required' : 'human',
        automationId: startup?.automationId ?? (held ? old.ownership.automationId : null), runId: startup?.runId ?? (held ? old.ownership.runId : null),
        reason: held ? 'RUNTIME_REPLACED' : null } };
    this.states.set(this.key(userId, sessionId), state);
    this.changed(state);
    this.authority()?.recordRuntimeObservation(this.observation(state));
  }

  claimStartup(userId:string,sessionId:string,automationId:string,runId:string) {
    const state = this.state(userId,sessionId);
    if (state?.live || state?.writer || this.startups.has(this.key(userId,sessionId)) || this.hasDraft(userId,sessionId))
      throw new AutomationInputError('INPUT_BOUNDARY_UNPROVEN','Startup ownership changed.');
    this.startups.set(this.key(userId,sessionId),{automationId,runId});
  }
  cancelStartup(userId:string,sessionId:string,runId:string) {
    if (this.startups.get(this.key(userId,sessionId))?.runId === runId) this.startups.delete(this.key(userId,sessionId));
  }
  readNativeState(userId: string, sessionId: string): import('./activation-contracts').NativeGateSnapshot | null {
    const state = this.state(userId, sessionId);
    if (!state || !state.environment || !['codex', 'claude-code'].includes(state.provider)) return null;
    return { identity: { userId, sessionId, agentEnvironment: state.environment, serverInstanceId: this.serverInstanceId,
      terminalId: state.ownership.terminalId!, generation: state.generation, provider: state.provider as 'codex' | 'claude-code',
      providerConversationId: state.conversationId ?? null, inputRevision: state.revision }, state: state.status === 'unobserved' ? 'unknown' : state.status, live: state.live, writer: state.writer,
      backgroundWork: state.backgroundUnknown ? 'unknown' : state.children.size || state.lifecycleChildren ? 'active' : 'clear',
      hasDraft: this.hasDraft(userId, sessionId), ownershipMode: state.ownership.mode, nativeApprovalId: state.nativeApproval?.requestId ?? null };
  }
  canSuperviseNativeApproval(userId: string, sessionId: string, request?: NativeApprovalRequest): boolean {
    const state = this.readNativeState(userId, sessionId);
    if (request) {
      if (!isDeepStrictEqual(request, this.state(userId, sessionId)?.nativeApproval)) return false;
      try { this.assertNativeIdentity(request.identity); } catch { return false; }
    }
    return !!state?.live && !!this.authority()?.canSuperviseNativeApproval?.({ userId, sessionId,
      agentEnvironment: state.identity.agentEnvironment, provider: state.identity.provider, request });
  }
  setDraftVeto(userId: string, sessionId: string, veto: AutomationDraftVeto) {
    const key = this.key(userId, sessionId), drafts = this.drafts.get(key) ?? new Map<string, AutomationDraftVeto>();
    const previous = drafts.get(veto.surfaceId);
    if (previous && previous.revision >= veto.revision) return;
    drafts.set(veto.surfaceId, { ...veto }); this.drafts.set(key, drafts);
    if (veto.hasDraft || previous?.hasDraft) {
      const state = this.state(userId,sessionId);
      if (state) { state.draftRevision=(state.draftRevision ?? 0)+1; state.ownership.epoch=randomUUID(); this.changed(state); }
    }
  }
  hasDraft(userId: string, sessionId: string) {
    return [...(this.drafts.get(this.key(userId, sessionId))?.values() ?? [])].some(draft => draft.hasDraft);
  }
  assertNativeIdentity(identity: NativeRuntimeIdentity) {
    const state = this.state(identity.userId, identity.sessionId);
    if (!state?.live || identity.serverInstanceId !== this.serverInstanceId || identity.terminalId !== state.ownership.terminalId ||
      identity.generation !== state.generation || identity.provider !== state.provider || identity.agentEnvironment !== state.environment ||
      identity.inputRevision !== state.revision || (state.conversationId ?? null) !== identity.providerConversationId ||
      state.children.size || state.lifecycleChildren || state.backgroundUnknown || this.hasDraft(identity.userId, identity.sessionId))
      throw new AutomationInputError('INPUT_BOUNDARY_UNPROVEN', 'Native interaction identity or draft changed.');
  }
  claimNativeAction(identity: NativeRuntimeIdentity, automationId: string, runId: string) {
    this.assertNativeIdentity(identity);
    const state = this.state(identity.userId, identity.sessionId)!;
    if (state.writer || !['human', 'armed'].includes(state.ownership.mode) ||
      (state.ownership.mode === 'armed' && state.ownership.automationId !== automationId))
      throw new AutomationInputError('INPUT_BOUNDARY_UNPROVEN', 'Native action ownership changed.');
    state.ownership = { ...state.ownership, mode: 'armed', automationId, runId,
      epoch: state.ownership.mode === 'human' ? randomUUID() : state.ownership.epoch, reason: null };
    state.writer = true; state.writerDraftRevision = state.draftRevision ?? 0; state.automated = true; this.changed(state);
  }
  verifyNativeAction(identity: NativeRuntimeIdentity, automationId: string, runId: string) {
    this.assertNativeIdentity(identity);
    const state = this.state(identity.userId, identity.sessionId)!;
    if (!state.writer || state.writerDraftRevision !== (state.draftRevision ?? 0) || state.ownership.mode !== 'armed' || state.ownership.automationId !== automationId || state.ownership.runId !== runId)
      throw new AutomationInputError('INPUT_BOUNDARY_UNPROVEN', 'Native action was paused.');
  }
  holdNativeApproval(userId: string, sessionId: string, request: NativeApprovalRequest) {
    this.assertNativeIdentity(request.identity);
    if (request.identity.userId !== userId || request.identity.sessionId !== sessionId) throw new AutomationInputError('OWNER_UNAVAILABLE', 'Approval owner changed.');
    this.state(userId, sessionId)!.nativeApproval = request;
  }
  releaseNativeApproval(userId: string, sessionId: string, requestId: string) {
    const state = this.state(userId, sessionId);
    if (state?.nativeApproval?.requestId !== requestId) return;
    state.nativeApproval = undefined;
    // Resolution resumes this accepted turn; it is not a new submission/completion.
    if (state.submittedRevision === state.revision && state.confirmedRevision === state.revision) state.status = 'running';
  }

  ownership(userId: string, sessionId: string): InputOwnership {
    return { ...(this.state(userId, sessionId)?.ownership ?? { sessionId, terminalId: null,
      epoch: '', mode: 'unavailable', automationId: null, runId: null, reason: 'RUNTIME_UNAVAILABLE' }) };
  }

  bindConversation(userId: string, sessionId: string, conversationId: string) {
    const state = this.state(userId, sessionId);
    if (!state || state.conversationId === conversationId) return;
    if (state.conversationId) {
      state.boundary = null; state.nativeSubmission = undefined; state.nativeCompletion = undefined;
      state.submittedRevision = null; state.confirmedRevision = null; state.candidateRevision = null;
      this.inhibit(state, 'WORKER_IDENTITY_CHANGED');
    }
    state.conversationId = conversationId;
  }
  recordHookEvidence(raw: AutorunHookEvidence): { kind: 'accepted' | 'rejected' } {
    const parsed = autorunHookEvidenceSchema.safeParse(raw);
    if (!parsed.success) return { kind: 'rejected' };
    const event = parsed.data, state = this.state(event.userId, event.sessionId), e = event.evidence;
    if (!state?.live || state.environment !== event.agentEnvironment || state.ownership.terminalId !== event.terminalId ||
      e.serverInstanceId !== this.serverInstanceId || e.terminalGeneration !== state.generation || e.provider !== state.provider ||
      e.providerConversationId !== state.conversationId || state.submittedRevision !== state.revision || state.status === 'input-required') return { kind: 'rejected' };
    state.seenNative ??= new Set();
    const key = `${event.kind}:${e.dedupKey}`;
    if (state.seenNative.has(key)) {
      const current = event.kind === 'submission' ? state.nativeSubmission?.event : state.nativeCompletion;
      return { kind: current && JSON.stringify(current.evidence) === JSON.stringify(e) ? 'accepted' : 'rejected' };
    }
    if (event.kind === 'submission') {
      if (state.nativeSubmission?.revision === state.revision) return { kind: 'rejected' };
      state.nativeSubmission = { event, revision: state.revision }; state.nativeCompletion = undefined;
    } else {
      const submission = state.nativeSubmission;
      if (!submission || submission.revision !== state.revision) return { kind: 'rejected' };
      const { completionHookId: _hook, ...native } = event.evidence;
      void _hook;
      // Claude completion adds its exact Stop-text hash to the original submit association.
      const { stopTextHash: _hash, ...association } = native as typeof native & { stopTextHash?: string };
      void _hash;
      if (JSON.stringify(association) !== JSON.stringify(submission.event.evidence)) {
        // Field order is irrelevant in a validated native identity.
        if (Object.entries(association).some(([name, value]) => name !== 'dedupKey' &&
          (submission.event.evidence as unknown as Record<string, unknown>)[name] !== value)) return { kind: 'rejected' };
      }
      state.nativeCompletion = event;
    }
    state.seenNative.add(key);
    return { kind: 'accepted' };
  }
  readTurnEvidence(args: { userId: string; agentEnvironment: 'native' | 'wsl'; sessionId: string }): AutorunTurnEvidence {
    const state = this.state(args.userId, args.sessionId);
    if (!state?.live || state.environment !== args.agentEnvironment || state.writer || this.hasDraft(args.userId,args.sessionId) || state.children.size ||
      state.lifecycleChildren || state.backgroundUnknown || state.status === 'input-required') return { kind: 'unavailable', reason: 'unsafe-runtime' };
    if (state.submittedRevision === null || state.submittedRevision !== state.revision) return { kind: 'idle', reason: 'no-accepted-turn' };
    if (!state.nativeSubmission || state.nativeSubmission.revision !== state.revision || state.confirmedRevision !== state.revision)
      return { kind: 'unavailable', reason: 'instrumentation-required' };
    if (state.boundary) return state.nativeCompletion
      ? { kind: 'completed', boundary: { ...state.boundary }, correlation: state.nativeCompletion.evidence }
      : { kind: 'unavailable', reason: 'instrumentation-required' };
    if (state.status !== 'running') return { kind: 'unavailable', reason: 'unsafe-runtime' };
    return { kind: 'running', submission: state.nativeSubmission.event.evidence, acceptedTurn: {
      serverInstanceId: this.serverInstanceId, terminalId: state.ownership.terminalId!, generation: state.generation,
      sessionId: args.sessionId, userId: args.userId, turnSequence: state.turn, inputRevision: state.revision,
    } };
  }
  assertAnalysis(args: { userId: string; agentEnvironment: 'native' | 'wsl'; sessionId: string; expectedBoundary: Boundary; inputEpoch: string; automationId?: string; providerConversationId?: string }) {
    const state = this.state(args.userId, args.sessionId);
    const turn = this.readTurnEvidence(args);
    if (!state || turn.kind !== 'completed' || JSON.stringify(turn.boundary) !== JSON.stringify(args.expectedBoundary) ||
      state.ownership.epoch !== args.inputEpoch || (args.automationId && (state.ownership.mode !== 'armed' || state.ownership.automationId !== args.automationId)) ||
      (args.providerConversationId && state.conversationId !== args.providerConversationId)) throw new AutomationInputError('ANALYSIS_STALE', 'Analysis identity changed.');
    return turn;
  }
  commitAnalysis(args: Parameters<AutomationInputGate['assertAnalysis']>[0], commit: () => import('./runtime-port').AnalysisDecisionCommit): import('./runtime-port').AnalysisCommitResult {
    try { this.assertAnalysis(args); }
    catch { return { kind: 'rejected', code: 'ANALYSIS_STALE' }; }
    return { kind: 'committed', receipt: commit() };
  }
  verifyEnvironment(userId: string, sessionId: string, environment: 'native' | 'wsl') {
    const state = this.state(userId, sessionId);
    if (state?.live && state.environment !== environment) throw new AutomationInputError('OWNER_UNAVAILABLE', 'The runtime agent environment changed.');
  }
  assertHuman(userId: string, sessionId: string, epoch?: string, trusted = false) {
    const state = this.state(userId, sessionId);
    if (!state) return;
    if (state.ownership.mode !== 'human') {
      throw new AutomationInputError('INPUT_OWNED_BY_AUTOMATION', 'Pause automation before entering input.');
    }
    if (!trusted && ((state.automated && !epoch) || (epoch && epoch !== state.ownership.epoch))) {
      throw new AutomationInputError('INPUT_OWNERSHIP_STALE', 'The input ownership epoch changed.');
    }
    if (state.writer) throw new AutomationInputError('INPUT_BOUNDARY_UNPROVEN', 'A prompt is still being submitted.');
  }

  dirty(userId: string, sessionId: string, submitted = false) {
    const state = this.state(userId, sessionId);
    if (!state) return;
    state.nativeApproval = undefined;
    state.revision++;
    state.candidateRevision = submitted ? state.revision : null;
    state.boundary = null; state.leadCompletionAt = null;
  }

  isBusy(userId: string, sessionId: string): boolean {
    return this.state(userId, sessionId)?.writer ?? false;
  }

  writer(userId: string, sessionId: string, active: boolean) {
    const state = this.state(userId, sessionId);
    if (state) { state.writer = active; if (!active) this.settleWriters(state); }
  }

  submitted(userId: string, sessionId: string, event: string) {
    const state = this.state(userId, sessionId);
    if (state) this.hook(userId, sessionId, event, 'running', Math.max(Date.now(), state.lastHookAt + 1), false);
  }
  hook(userId: string, sessionId: string, event: string, status: 'running' | 'completed' | 'input_required' | 'idle', at: number, children: boolean, completion: TerminalAutomationCompletion = null) {
    const state = this.state(userId, sessionId);
    if (!state || !state.live || at <= state.lastHookAt) return;
    // Codex emits startup on its first real turn, after our host Enter can be delivered.
    // Preserve that pending submit; only the subsequent native submit confirms it.
    const pendingHostStartup = event === 'SessionStart' && status === 'idle' && state.status === 'running'
      && state.submittedRevision === state.revision && state.confirmedRevision === null;
    state.lastHookAt = at;
    state.lifecycleChildren = children;
    if (event === 'UserPromptSubmit') {
      const confirmsHostSubmit = state.status === 'running' && state.submittedRevision === state.revision
        && state.confirmedRevision === null;
      const fresh = state.candidateRevision === state.revision || (state.turn === 0 && state.revision === 0);
      if (!confirmsHostSubmit && !fresh) return;
      if (!confirmsHostSubmit) state.turn++;
      state.submittedRevision = state.revision;
      state.confirmedRevision = state.revision;
      state.candidateRevision = null;
      state.leadCompletionAt = null;
      state.boundary = null;
    } else if (event === 'ControlPromptSubmit' || event === 'AutomationPromptSubmit') {
      state.turn++;
      state.submittedRevision = state.revision;
      state.confirmedRevision = null;
      state.candidateRevision = null;
      state.leadCompletionAt = null;
      state.boundary = null;
    } else if (status === 'running' && state.status === 'turn-complete') {
      state.submittedRevision = null;
      this.inhibit(state, 'TURN_UNPROVEN');
    }
    state.status = status === 'input_required' ? 'input-required' : status === 'completed' ? 'turn-complete' : status === 'running' || pendingHostStartup ? 'running' : 'unknown';
    const clean = state.submittedRevision !== null && state.submittedRevision === state.revision;
    if (completion === 'failed-lead-stop') {
      state.leadCompletionAt = null;
      state.submittedRevision = null;
      this.inhibit(state, 'TURN_FAILED');
    }
    if (completion === 'successful-lead-stop' && clean && state.confirmedRevision === state.revision) state.leadCompletionAt = at;
    const completed = status === 'completed' && (completion === 'successful-lead-stop' || completion === 'children-settled')
      && state.leadCompletionAt !== null && !children && state.children.size === 0 && !state.backgroundUnknown
      && clean && state.submittedRevision !== null && state.confirmedRevision === state.revision;
    if (completed && !state.boundary) {
      this.complete(state, at);
    } else if (!completed) state.boundary = null;
    if ((status === 'input_required' && !state.nativeApproval) || (status === 'idle' && event !== 'SessionStart')) {
      state.submittedRevision = null;
      this.inhibit(state, status === 'input_required' ? 'INPUT_REQUIRED' : 'BOUNDARY_UNPROVEN');
    }
    this.authority()?.recordRuntimeObservation(this.observation(state, completed ? 'clear' : children || state.children.size > 0 ? 'active' : 'unknown'));
  }

  private complete(state: State, at: number) {
    const sessionId = state.ownership.sessionId;
    const userId = state.userId;
    state.boundary = { id: `${this.serverInstanceId}:${state.generation}:${sessionId}:${state.turn}`,
        serverInstanceId: this.serverInstanceId, generation: state.generation,
        terminalId: state.ownership.terminalId!, sessionId, userId, turnSequence: state.turn,
        inputRevision: state.revision, completedAt: at, source: 'confirmed-lead-turn' };
    if (state.ownership.mode === 'armed') {
      try {
        const authority = this.authority();
        if (!authority) throw new Error('Automation authority is unavailable.');
        authority.recordBoundary({ userId, boundary: state.boundary });
      } catch {
        state.boundary = null;
        state.leadCompletionAt = null;
        state.submittedRevision = null;
        // Persistence cannot leave an occurrence alive only in this process.
        // inhibit installs the local lock before any further persistence call.
        try { this.inhibit(state, 'BOUNDARY_UNRECORDED'); } catch { /* Retain the local draining hold. */ }
      }
    }
  }

  background(userId: string, sessionId: string, childId: string, work: RuntimeObservation['backgroundWork']) {
    const state = this.state(userId, sessionId);
    if (!state?.live) return;
    if (work === 'active') state.children.add(childId);
    if (work === 'clear') state.children.delete(childId);
    if (work === 'unknown') { state.backgroundUnknown = true; this.inhibit(state, 'BACKGROUND_UNPROVEN'); }
    if (work !== 'clear') state.boundary = null;
    if (work === 'clear' && state.children.size === 0 && !state.lifecycleChildren && !state.backgroundUnknown && state.leadCompletionAt !== null
      && state.submittedRevision === state.revision && state.confirmedRevision === state.revision && !state.boundary) this.complete(state, Date.now());
    this.authority()?.recordRuntimeObservation(this.observation(state, state.backgroundUnknown ? 'unknown' : state.children.size ? 'active' : 'clear'));
  }

  private observation(state: State, backgroundWork: RuntimeObservation['backgroundWork'] = 'unknown', exitKind: RuntimeObservation['exitKind'] = null): RuntimeObservation {
    return { userId: state.userId, sessionId: state.ownership.sessionId, terminalId: state.ownership.terminalId!,
      serverInstanceId: this.serverInstanceId, generation: state.generation, sequence: ++state.sequence,
      observedAt: Date.now(), state: state.status, backgroundWork, exitKind };
  }
  observe(userId: string, sessionId: string): RuntimeObservation | null {
    const state = this.state(userId, sessionId);
    return state?.live ? this.observation(state) : null;
  }
  rebound(userId: string, oldSessionId: string, sessionId: string, terminalId: string, generation: number) {
    const previous = this.state(userId, oldSessionId);
    if (previous) { previous.live = false; previous.boundary = null; this.inhibit(previous, 'RUNTIME_REBOUND'); }
    this.started(userId, sessionId, terminalId, generation, previous?.provider ?? '', previous?.environment);
  }
  exited(userId: string, sessionId: string, kind: RuntimeObservation['exitKind']) {
    const state = this.state(userId, sessionId);
    if (!state) return;
    state.live = false; state.status = 'exited'; state.boundary = null;
    this.inhibit(state, 'RUNTIME_EXITED');
    if (state.ownership.mode === 'human') this.transition(state, 'unavailable');
    this.authority()?.recordRuntimeObservation(this.observation(state, 'unknown', kind));
  }
  private inhibit(state: State, reason: string) {
    if (state.ownership.automationId) {
      // Lock locally even if the persistence port is temporarily unavailable.
      const recoveryHeld = state.ownership.mode === 'recovery-required';
      if (!recoveryHeld) this.transition(state, 'draining', reason);
      const authority = this.authority();
      authority?.pauseWake(state.userId, state.ownership.sessionId, reason);
      if (authority && !state.writer && !recoveryHeld && state.ownership.automationId) this.drain(state.userId, state.ownership.sessionId, state.ownership.automationId);
      if (!authority && !state.writer && !recoveryHeld) this.transition(state, 'recovery-required', reason);
    }
  }
  arm(userId: string, sessionId: string, automationId: string, provider: string, commit: (evidence: ArmEvidence, value: InputOwnership) => void): InputOwnership {
    const state = this.state(userId, sessionId);
    if (!state || !state.live || !['claude-code', 'codex'].includes(state.provider) || state.provider !== provider || state.writer
      || state.children.size > 0 || state.lifecycleChildren || state.backgroundUnknown || this.hasDraft(userId, sessionId) || state.ownership.mode !== 'human' || state.submittedRevision === null
      || state.submittedRevision !== state.revision
      || (!state.boundary && state.status !== 'running')) {
      throw new AutomationInputError('INPUT_BOUNDARY_UNPROVEN', 'A clean submitted turn boundary is required.');
    }
    const evidence: ArmEvidence = state.boundary ? { kind: 'completed', boundary: state.boundary } : {
      kind: 'submitted-running', serverInstanceId: this.serverInstanceId, terminalId: state.ownership.terminalId!,
      generation: state.generation, sessionId, userId, turnSequence: state.turn, inputRevision: state.revision };
    const ownership: InputOwnership = { ...state.ownership, epoch: randomUUID(), mode: 'armed', automationId, reason: null };
    const previous = state.ownership;
    state.ownership = ownership;
    try { commit(evidence, ownership); }
    catch (error) { state.ownership = previous; throw error; }
    state.automated = true;
    this.changed(state);
    return this.ownership(userId, sessionId);
  }
  begin(userId: string, sessionId: string, automationId: string, runId: string, boundary: Boundary | null) {
    const state = this.state(userId, sessionId);
    if (!state || state.writer || !state.live || this.hasDraft(userId,sessionId) || state.ownership.mode !== 'armed'
      || state.ownership.automationId !== automationId || !boundary || !state.boundary
      || JSON.stringify(state.boundary) !== JSON.stringify(boundary)) {
      throw new AutomationInputError('INPUT_BOUNDARY_UNPROVEN', 'The completed turn boundary changed.');
    }
    state.writer = true; state.writerDraftRevision = state.draftRevision ?? 0; state.ownership.runId = runId;
  }
  verify(userId: string, sessionId: string, boundary: Boundary) {
    const state = this.state(userId, sessionId);
    if (!state?.live || !state.writer || this.hasDraft(userId,sessionId) || state.writerDraftRevision !== (state.draftRevision ?? 0) || !state.boundary || state.boundary.id !== boundary.id
      || state.revision !== boundary.inputRevision || state.status !== 'turn-complete') {
      throw new AutomationInputError('INPUT_BOUNDARY_UNPROVEN', 'The provider boundary changed during delivery.');
    }
  }
  finish(userId: string, sessionId: string, unknown: boolean) {
    const state = this.state(userId, sessionId);
    if (!state) return;
    state.writer = false;
    this.settleWriters(state);
    if (unknown) this.transition(state, 'recovery-required', 'DELIVERY_UNKNOWN');
    else if (state.ownership.mode === 'draining') this.transition(state, state.live ? 'human' : 'unavailable');
    else { state.ownership.runId = null; this.changed(state); }
  }
  waitForWriter(userId: string, sessionId: string): Promise<void> {
    const state = this.state(userId, sessionId);
    return state?.writer ? new Promise(resolve => { state.waiters.add(resolve); }) : Promise.resolve();
  }
  private settleWriters(state: State) {
    for (const resolve of state.waiters) resolve();
    state.waiters.clear();
  }
  drain(userId: string, sessionId: string, automationId: string): InputOwnership {
    const state = this.state(userId, sessionId);
    if (state && state.ownership.automationId === automationId) {
      if (state.writer) this.transition(state, 'draining');
      else if (state.ownership.mode !== 'recovery-required') this.transition(state, state.live ? 'human' : 'unavailable');
    }
    return this.ownership(userId, sessionId);
  }
  recover(userId: string, sessionId: string, automationId: string, runId: string | null) {
    let state = this.state(userId, sessionId);
    if (!state) {
      state = { userId, generation: 0, provider: '', environment: undefined, revision: 0, turn: 0, submittedRevision: null, confirmedRevision: null, children: new Set(), lifecycleChildren: false, backgroundUnknown: false, leadCompletionAt: null,
        boundary: null, status: 'unknown', sequence: 0, lastHookAt: 0, candidateRevision: null, writer: false, waiters: new Set(), automated: true, live: false,
        ownership: { sessionId, terminalId: null, epoch: randomUUID(), mode: 'recovery-required', automationId, runId, reason: 'DELIVERY_UNKNOWN' } };
      this.states.set(this.key(userId, sessionId), state);
    }
    state.automated = true; state.ownership.automationId = automationId; state.ownership.runId = runId;
    this.transition(state, 'recovery-required', 'DELIVERY_UNKNOWN');
  }
  release(userId: string, sessionId: string, runId: string, commit: () => void) {
    const state = this.state(userId, sessionId);
    if (!state || state.writer || state.ownership.mode !== 'recovery-required' || state.ownership.runId !== runId) {
      throw new AutomationInputError('UNRESOLVED_RUN', 'The previous writer must be quiescent before recovery.');
    }
    commit();
    this.transition(state, state.live ? 'human' : 'unavailable');
    return this.ownership(userId, sessionId);
  }
  private transition(state: State, mode: InputOwnership['mode'], reason: string | null = null) {
    if (state.ownership.mode === mode && state.ownership.reason === reason) return;
    state.ownership = { ...state.ownership, mode, reason, epoch: randomUUID(),
      ...(['human', 'unavailable'].includes(mode) ? { automationId: null, runId: null } : {}) };
    this.changed(state);
  }
  private changed(state: State) {
    try { this.authority()?.recordInputOwnership(state.userId, { ...state.ownership }); }
    finally { this.publish(state.userId, { ...state.ownership }); }
  }
}
