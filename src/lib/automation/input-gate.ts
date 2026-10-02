import type { TerminalAutomationCompletion } from '@/lib/cli/providers/terminal-automation-evidence';
import { AutomationInputError } from './input-error';
import { randomUUID } from 'node:crypto';
import { type InputOwnership } from './contracts';
import { autorunHookEvidenceSchema, type AutorunHookEvidence, type AutorunTurnEvidence } from './autorun-contracts';
import type { ArmEvidence, AutomationAuthority, Boundary, RuntimeObservation } from './runtime-port';

type State = {
  ownership: InputOwnership; userId: string; generation: number; provider: string; environment: 'native' | 'wsl' | undefined;
  revision: number; turn: number; submittedRevision: number | null; confirmedRevision: number | null;
  children: Set<string>; lifecycleChildren: boolean; backgroundUnknown: boolean; leadCompletionAt: number | null;
  conversationId?: string; nativeSubmission?: { event: Extract<AutorunHookEvidence, { kind: 'submission' }>; revision: number };
  nativeCompletion?: Extract<AutorunHookEvidence, { kind: 'completion' }>; seenNative?: Set<string>;
  boundary: Boundary | null; status: RuntimeObservation['state']; sequence: number;
  lastHookAt: number; candidateRevision: number | null; writer: boolean; waiters: Set<() => void>; automated: boolean; live: boolean;
};

/** Process-owned evidence and input mutex. No screen/silence/subscriber heuristics. */
export class AutomationInputGate {
  readonly serverInstanceId = randomUUID();
  private states = new Map<string, State>();
  authority: () => AutomationAuthority | null = () => null;
  publish: (userId: string, value: InputOwnership) => void = () => {};
  private key(userId: string, sessionId: string) { return JSON.stringify([userId, sessionId]); }
  private state(userId: string, sessionId: string) { return this.states.get(this.key(userId, sessionId)); }

  started(userId: string, sessionId: string, terminalId: string, generation: number, provider: string, environment?: 'native' | 'wsl') {
    const old = this.state(userId, sessionId);
    const held = old && old.ownership.mode !== 'human' && old.ownership.mode !== 'unavailable';
    const state: State = { userId, generation, provider, environment, revision: 0, turn: 0, submittedRevision: null, confirmedRevision: null, children: new Set(), lifecycleChildren: false, backgroundUnknown: false, leadCompletionAt: null,
      boundary: null, status: 'starting', sequence: 0, lastHookAt: 0, candidateRevision: null, writer: old?.writer ?? false, waiters: old?.waiters ?? new Set(),
      automated: old?.automated ?? false, live: true,
      ownership: { sessionId, terminalId, epoch: randomUUID(), mode: held ? 'recovery-required' : 'human',
        automationId: held ? old.ownership.automationId : null, runId: held ? old.ownership.runId : null,
        reason: held ? 'RUNTIME_REPLACED' : null } };
    this.states.set(this.key(userId, sessionId), state);
    this.changed(state);
    this.authority()?.recordRuntimeObservation(this.observation(state));
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
    if (!state?.live || state.environment !== args.agentEnvironment || state.writer || state.children.size ||
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
    state.status = status === 'input_required' ? 'input-required' : status === 'completed' ? 'turn-complete' : status === 'running' ? 'running' : 'unknown';
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
    if (status === 'input_required' || (status === 'idle' && event !== 'SessionStart')) {
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
      || state.children.size > 0 || state.lifecycleChildren || state.backgroundUnknown || state.ownership.mode !== 'human' || state.submittedRevision === null
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
    if (!state || state.writer || !state.live || state.ownership.mode !== 'armed'
      || state.ownership.automationId !== automationId || !boundary || !state.boundary
      || JSON.stringify(state.boundary) !== JSON.stringify(boundary)) {
      throw new AutomationInputError('INPUT_BOUNDARY_UNPROVEN', 'The completed turn boundary changed.');
    }
    state.writer = true; state.ownership.runId = runId;
  }
  verify(userId: string, sessionId: string, boundary: Boundary) {
    const state = this.state(userId, sessionId);
    if (!state?.live || !state.writer || !state.boundary || state.boundary.id !== boundary.id
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
  settleAnalysisHold(userId: string,sessionId: string,automationId: string) {
    const state=this.state(userId,sessionId);
    if (state && !state.writer && state.ownership.automationId===automationId && state.ownership.runId===null &&
      state.ownership.mode==='recovery-required' && state.ownership.reason==='SUPERVISOR_PROCESS_UNCERTAIN')
      this.transition(state,state.live?'human':'unavailable');
  }
  holdAnalysis(userId: string, sessionId: string, automationId: string) {
    if (!this.state(userId,sessionId)) this.recover(userId,sessionId,automationId,null);
    const state=this.state(userId,sessionId)!;
    if (state.ownership.automationId && state.ownership.automationId!==automationId) return;
    state.automated=true;state.ownership.automationId=automationId;state.ownership.runId=null;
    this.transition(state,'recovery-required','SUPERVISOR_PROCESS_UNCERTAIN');
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
