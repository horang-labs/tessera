import { z } from 'zod';
import { automationActivationSchema } from './activation-contracts';
import { isTerminalNamedKey } from '../terminal/session-control-input';
import { automationInputSchema, validateAutomationInput, sessionSelectionSnapshotSchema,
  type AutomationValidationContext, type InputOwnership, type AutomationRun } from './contracts';

export const AUTORUN_BOUNDS = {
  packetBytes: 98_304, objectiveConstraintBytes: 16_384, priorDecisionBytes: 8_192,
  priorDecisions: 10, scanBytes: 33_554_432, recordBytes: 2_097_152, toolExcerptBytes: 4_096,
  stdoutBytes: 262_144, stderrBytes: 32_768, flushWaitMs: 10_000, cancelGraceMs: 5_000,
  concurrentPerProfile: 2, noProgressLimit: 3,
} as const;
const id = z.string().min(1).max(256);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bytes = (value: string) => new TextEncoder().encode(value).length;
const text = (max: number) => z.string().refine(value => value.trim().length > 0 && bytes(value) <= max);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const supervisorSelectionSchema = z.object({
  provider: z.enum(['claude-code', 'codex']), model: text(256),
  reasoningEffort: text(64).refine(value => value !== 'auto'),
  serviceTier: z.enum(['default', 'fast']).nullable(),
}).strict().refine(value => value.provider === 'codex' ? value.serviceTier !== null : value.serviceTier === null);
export type SupervisorSelection = z.infer<typeof supervisorSelectionSchema>;
const criterionSchema = z.object({ id, text: text(2048) }).strict();
const criteriaSchema = z.array(criterionSchema).min(1).max(100)
  .refine(values => new Set(values.map(value => value.id)).size === values.length);
/** Client sends an explicit objective or an opaque preview reference; provenance is server-owned. */
export const objectiveInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explicit'), text: text(16_384) }).strict(),
  z.object({ kind: z.literal('preview'), previewId: id, goalRevision: count }).strict(),
]);
export const autorunInputConfigSchema = z.object({
  objective: objectiveInputSchema, constraints: z.array(text(16_384)).max(100), criteria: criteriaSchema,
  supervisor: supervisorSelectionSchema, maxAnalyses: z.number().int().min(1).max(100),
  analysisTimeoutMs: z.number().int().min(30_000).max(300_000),
}).strict().refine(value => bytes((value.objective.kind === 'explicit' ? value.objective.text : '') + value.constraints.join('')) <= AUTORUN_BOUNDS.objectiveConstraintBytes);
const base = automationInputSchema.shape;
const heartbeatSchema = automationInputSchema.extend({ version: z.literal(2), mode: z.literal('heartbeat'),
  target: z.object({ kind: z.literal('wake-session'), sessionId: id }).strict(),
  trigger: z.object({ kind: z.literal('turn-complete'), delayMs: z.number().int().min(30_000).max(86_400_000) }).strict(),
});
const scheduleSchema = automationInputSchema.extend({ version: z.literal(2), mode: z.literal('schedule'),
  target: base.target.options[1], trigger: z.union([base.trigger.options[0], base.trigger.options[1]]),
});
const autorunSchema = z.object({
  version: z.literal(2), mode: z.literal('autorun'), name: base.name, enabled: base.enabled,
  target: heartbeatSchema.shape.target, trigger: heartbeatSchema.shape.trigger, limits: base.limits,
  autorun: autorunInputConfigSchema,
}).strict();
export const automationInputV2Schema = z.union([heartbeatSchema, scheduleSchema, autorunSchema]);
export type AutomationInputV2 = z.infer<typeof automationInputV2Schema>;
export type AutorunInput = z.infer<typeof autorunSchema>;

/** Decoding is structural. Admission remains owner/runtime/capability-authorized in R2. */
export function decodeAutomationInput(value: unknown) {
  const legacy = automationInputSchema.safeParse(value);
  if (legacy.success) return automationInputV2Schema.safeParse({ ...legacy.data, version: 2,
    mode: legacy.data.target.kind === 'wake-session' ? 'heartbeat' : 'schedule' });
  return automationInputV2Schema.safeParse(value);
}
export function validateAutomationInputV2(value: unknown, context: AutomationValidationContext) {
  const decoded = decodeAutomationInput(value);
  if (!decoded.success) return { success: false as const, code: 'INVALID_AUTOMATION' as const };
  const input = decoded.data;
  if (input.mode === 'autorun') {
    return input.limits.expiresAt > context.now && input.limits.expiresAt <= context.now + 7_776_000_000
      ? { success: true as const, data: input }
      : { success: false as const, code: 'INVALID_AUTOMATION' as const };
  }
  const { version: _version, mode: _mode, ...legacy } = input;
  void _version; void _mode;
  const result = validateAutomationInput(legacy, context);
  return result.success ? { success: true as const, data: input }
    : { success: false as const, code: result.error.code };
}

export const humanInstructionSourceSchema = z.object({
  messageId: id, recordId: id, textHash: hash, excerpt: text(2048),
  origin: z.enum(['tessera-human-correlated', 'provider-human-verified']),
}).strict();
export const objectiveSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explicit'), text: text(16_384), revision: count }).strict(),
  z.object({ kind: z.literal('verified-human'), text: text(16_384), revision: count,
    sources: z.array(humanInstructionSourceSchema).min(1).max(100) }).strict(),
]);
export type AutorunObjective = z.infer<typeof objectiveSchema>;
export const autorunConfigSchema = z.object({
  ...autorunInputConfigSchema.innerType().shape, objective: objectiveSchema,
  criterionOrigin: z.enum(['verified-human', 'explicit', 'system-objective']),
}).strict().refine(value => bytes(value.objective.text + value.constraints.join('')) <= AUTORUN_BOUNDS.objectiveConstraintBytes);
export type AutorunConfig = z.infer<typeof autorunConfigSchema>;

const persisted = {
  id, revision: z.number().int().min(1), state: z.enum(['enabled', 'disabled', 'paused', 'exhausted', 'expired', 'deleted']),
  pauseReason: id.nullable(), ownerUserId: id, agentEnvironment: z.enum(['native', 'wsl']),
  savedSelection: sessionSelectionSnapshotSchema, nextDueAt: time.nullable(), dispatchCount: count,
  createdAt: time, updatedAt: time, deletedAt: time.nullable(),
};
const heartbeatDto = heartbeatSchema.omit({ enabled: true }).extend(persisted);
const scheduleDto = scheduleSchema.omit({ enabled: true }).extend(persisted);

export const supervisorDecisionSchema = z.object({
  outcome: z.enum(['continue', 'complete', 'needs-user']), proposedPrompt: text(32_768).nullable(),
  explanation: text(2048), progress: text(2048), evidenceIds: z.array(id).min(1).max(20),
  criterionResults: z.array(z.object({ criterionId: id, status: z.enum(['met', 'unmet', 'unknown']),
    evidenceIds: z.array(id).max(20) }).strict()).min(1).max(100),
  madeProgress: z.boolean(), blocker: text(2048).nullable(),
}).strict();
export type SupervisorDecision = z.infer<typeof supervisorDecisionSchema>;
/** Provider-side structural schema; host validation supplies byte bounds and contextual references. */
export const SUPERVISOR_DECISION_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'proposedPrompt', 'explanation', 'progress', 'evidenceIds', 'criterionResults', 'madeProgress', 'blocker'],
  properties: {
    outcome: { type: 'string', enum: ['continue', 'complete', 'needs-user'] },
    proposedPrompt: { type: ['string', 'null'], minLength: 1, maxLength: 32_768 },
    explanation: { type: 'string', minLength: 1, maxLength: 2048 },
    progress: { type: 'string', minLength: 1, maxLength: 2048 },
    evidenceIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 256 } },
    criterionResults: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', additionalProperties: false, required: ['criterionId', 'status', 'evidenceIds'],
      properties: { criterionId: { type: 'string', minLength: 1, maxLength: 256 },
        status: { type: 'string', enum: ['met', 'unmet', 'unknown'] },
        evidenceIds: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 256 } } },
    } },
    madeProgress: { type: 'boolean' }, blocker: { type: ['string', 'null'], minLength: 1, maxLength: 2048 },
  },
} as const;
export type DecisionValidationContext = { criterionIds: readonly string[]; evidenceIds: readonly string[] };
/** This validates a model judgment, never a worker delivery receipt or semantic truth. */
export function validateSupervisorDecision(value: unknown, context: DecisionValidationContext) {
  const invalid = { success: false as const, code: 'SUPERVISOR_INVALID_OUTPUT' as const };
  const parsed = supervisorDecisionSchema.safeParse(value);
  if (!parsed.success) return invalid;
  const decision = parsed.data;
  const criteria = new Set(context.criterionIds);
  const evidence = new Set(context.evidenceIds);
  if (criteria.size === 0 || criteria.size !== context.criterionIds.length ||
      decision.criterionResults.length !== criteria.size ||
      new Set(decision.criterionResults.map(result => result.criterionId)).size !== criteria.size ||
      decision.criterionResults.some(result => !criteria.has(result.criterionId) || result.evidenceIds.some(id => !evidence.has(id))) ||
      decision.evidenceIds.some(id => !evidence.has(id))) return invalid;
  if (decision.outcome === 'complete' && decision.criterionResults.some(result => result.status !== 'met' || result.evidenceIds.length === 0)) return invalid;
  if ((decision.outcome === 'continue') !== (decision.proposedPrompt !== null) ||
      (decision.outcome === 'needs-user') !== (decision.blocker !== null)) return invalid;
  if (decision.proposedPrompt !== null) {
    const proposal = decision.proposedPrompt.trim();
    // LF is task formatting. All other C0/C1 controls (including CR/ESC) are refused.
    if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(decision.proposedPrompt) ||
        proposal.split('\n').some(line => line.trimStart().startsWith('/')) ||
        isTerminalNamedKey(proposal.toLowerCase()) ||
        /^(?:y|yes|n|no|ok|okay|approve|approved|accept|confirm|allow(?: once| always)?|deny|reject|1|2|3)[.!]?$/i.test(proposal)) return invalid;
  }
  return { success: true as const, data: decision };
}

export const analysisBoundarySchema = z.object({
  id, serverInstanceId: id, terminalId: id, generation: count, sessionId: id, userId: id,
  turnSequence: count, inputRevision: count, completedAt: time, source: z.literal('confirmed-lead-turn'),
}).strict();
const correlationBase = {
  providerConversationId: id, observerSubmissionId: id, serverInstanceId: id, terminalGeneration: count,
  sourceIdentityHash: hash, fileGeneration: id, startByte: count, completionHookId: id, dedupKey: id,
};
/** #530 observed prompt_id/promptId and turn_id; never substitute a timestamp or last prose. */
export const providerTurnCorrelationSchema = z.discriminatedUnion('provider', [
  z.object({ ...correlationBase, provider: z.literal('claude-code'), nativePromptId: id, stopTextHash: hash }).strict(),
  z.object({ ...correlationBase, provider: z.literal('codex'), nativeTurnId: id }).strict(),
]);
export type ProviderTurnCorrelation = z.infer<typeof providerTurnCorrelationSchema>;
export const providerCompletionCutoffSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('claude-code'), promptId: id, humanRecordId: id,
    terminalRecordId: id, parentUuid: id, apiMessageId: id.nullable(), endByte: count }).strict(),
  z.object({ provider: z.literal('codex'), turnId: id, taskStartedRecordId: id,
    turnContextRecordId: id, terminalRecordId: id, endByte: count }).strict(),
]);
export type ProviderCompletionCutoff = z.infer<typeof providerCompletionCutoffSchema>;
const byteRange = z.object({ startByte: count, endByte: count }).strict()
  .refine(value => value.endByte > value.startByte);
/** Absolute offsets are independent of actual bytes read, including header/tail and rereads. */
export const contextSourceSchema = z.object({
  identityHash: hash, fileGeneration: id, startByte: count, endByte: count, latestTurnStartByte: count,
  scannedRanges: z.array(byteRange).min(1).max(1000), bytesScanned: count.max(AUTORUN_BOUNDS.scanBytes),
  maxRecordBytes: z.number().int().positive().max(AUTORUN_BOUNDS.recordBytes),
}).strict().refine(value => value.startByte <= value.latestTurnStartByte && value.latestTurnStartByte < value.endByte &&
  value.scannedRanges.reduce((sum, range) => sum + range.endByte - range.startByte, 0) <= value.bytesScanned &&
  value.scannedRanges.every((range, index) => index === 0 || range.startByte >= value.scannedRanges[index - 1].endByte));
function rangeWasScanned(start: number, end: number, ranges: { startByte: number; endByte: number }[]) {
  let cursor = start;
  for (const range of ranges) {
    if (range.endByte <= cursor) continue;
    if (range.startByte > cursor) return false;
    cursor = range.endByte;
    if (cursor >= end) return true;
  }
  return false;
}
export const contextCoverageSchema = z.object({
  kind: z.enum(['full', 'bounded', 'compacted', 'incomplete']), latestTurnComplete: z.literal(true),
  omittedRanges: z.array(byteRange).max(1000), omittedBytes: count, toolTruncation: z.boolean(),
  compactionRecordIds: z.array(id).max(1000),
}).strict();
export const contextItemSchema = z.object({
  id, role: z.enum(['user', 'assistant', 'tool-call', 'tool-result', 'compaction', 'omitted']),
  origin: z.enum(['tessera-human-correlated', 'provider-human-verified', 'automation', 'provider', 'synthetic']),
  text: text(AUTORUN_BOUNDS.packetBytes), startByte: count, endByte: count,
  omission: z.enum(['none', 'head-tail', 'non-text', 'range']),
}).strict().refine(value => value.endByte > value.startByte &&
  (value.omission !== 'head-tail' || bytes(value.text) <= AUTORUN_BOUNDS.toolExcerptBytes));
export type ContextItem = z.infer<typeof contextItemSchema>;
export const analysisContextSnapshotSchema = z.object({
  version: z.literal(1), provider: z.enum(['claude-code', 'codex']), cliVersion: id,
  providerConversationId: id, userId: id, agentEnvironment: z.enum(['native', 'wsl']),
  boundary: analysisBoundarySchema, inputEpoch: id, workerSelection: sessionSelectionSnapshotSchema,
  source: contextSourceSchema,
  cutoff: providerCompletionCutoffSchema, correlation: providerTurnCorrelationSchema,
  coverage: contextCoverageSchema, items: z.array(contextItemSchema).min(1).max(2000),
  parserVersion: id, contentHash: hash, capturedAt: time,
}).strict().refine(value => {
  const { correlation, source, cutoff, boundary } = value;
  return value.provider === value.workerSelection.provider && value.provider === cutoff.provider && value.provider === correlation.provider &&
    correlation.providerConversationId === value.providerConversationId && correlation.serverInstanceId === boundary.serverInstanceId &&
    correlation.terminalGeneration === boundary.generation && correlation.sourceIdentityHash === source.identityHash &&
    correlation.fileGeneration === source.fileGeneration && correlation.startByte <= cutoff.endByte &&
    (cutoff.provider === 'codex' && correlation.provider === 'codex' ? cutoff.turnId === correlation.nativeTurnId :
      cutoff.provider === 'claude-code' && correlation.provider === 'claude-code' && cutoff.promptId === correlation.nativePromptId) &&
    value.userId === boundary.userId && source.startByte < source.endByte && cutoff.endByte === source.endByte &&
    new Set(value.items.map(item => item.id)).size === value.items.length &&
    rangeWasScanned(source.latestTurnStartByte, source.endByte, source.scannedRanges) &&
    value.items.every(item => item.startByte >= source.startByte && item.endByte <= cutoff.endByte &&
      rangeWasScanned(item.startByte, item.endByte, source.scannedRanges)) &&
    bytes(JSON.stringify(value)) <= AUTORUN_BOUNDS.packetBytes;
});
export type AnalysisContextSnapshot = z.infer<typeof analysisContextSnapshotSchema>;
export type ContextUnavailableCode = 'CONTEXT_UNAVAILABLE' | 'CONTEXT_INCOMPLETE' | 'ANALYSIS_STALE' | 'SUPERVISOR_UNSUPPORTED';
export type AnalysisContextResult =
  | { kind: 'ok'; snapshot: AnalysisContextSnapshot }
  | { kind: 'unavailable'; code: ContextUnavailableCode; reason: ContextUnavailableReason };
export type ContextUnavailableReason = 'missing' | 'flush-pending' | 'malformed' | 'ambiguous-cutoff' | 'unresolved-tools'
  | 'binding-mismatch' | 'unsupported-version' | 'instrumentation-required' | 'scan-limit' | 'record-limit'
  | 'packet-limit' | 'stale' | 'unsafe-runtime' | 'compacted-latest-turn';

export const SUPERVISOR_PROOF_POLICY = 'autorun-530-selection-v2' as const;
/** These describe #530 evidence, not current installation availability. R1 must re-attest preflight. */
export const PROVEN_SUPERVISOR_COMBINATIONS = [
  { selection: { provider: 'claude-code', model: 'claude-sonnet-5-5', reasoningEffort: 'high', serviceTier: null },
    cliVersion: '2.1.284', proofId: 'claude-2.1.284-safe-restricted-v1' },
  { selection: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' },
    cliVersion: '0.159.2', proofId: 'codex-0.159.2-packet-catalog-v1' },
] as const;
export function sameSupervisorSelection(a: SupervisorSelection, b: SupervisorSelection) {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort && a.serviceTier === b.serviceTier;
}
export const SUPERVISOR_ISOLATION_PROFILES = {
  'claude-code': { cliVersion: '2.1.284', proofId: 'claude-2.1.284-safe-restricted-v2' },
  codex: { cliVersion: '0.159.2', proofId: 'codex-0.159.2-packet-catalog-v2' },
} as const;
export const supervisorCapabilityUnavailableReasonSchema = z.enum(['version', 'selection', 'managed-policy', 'isolation', 'metadata-drift', 'adapter-missing']);
export type SupervisorCapabilityUnavailableReason = z.infer<typeof supervisorCapabilityUnavailableReasonSchema>;
export const supervisorCandidateSchema = z.object({
  provider: z.enum(['claude-code', 'codex']), model: text(256), label: text(256),
  reasoningEfforts: z.array(text(64)).max(20), serviceTiers: z.array(z.enum(['default', 'fast']).nullable()).max(3),
  source: z.enum(['native', 'curated', 'configured']),
  unavailableReason: z.enum(['metadata-unavailable', 'unsupported-selection', 'unsupported-policy']).nullable(),
}).strict();
export type SupervisorCandidate = z.infer<typeof supervisorCandidateSchema>;
export const supervisorDiscoverySchema = z.object({ candidates: z.array(supervisorCandidateSchema).max(200), complete: z.boolean() }).strict();
export type SupervisorDiscovery = z.infer<typeof supervisorDiscoverySchema>;
export const supervisorCapabilitySchema = z.object({
  version: z.literal(1), selection: supervisorSelectionSchema, cliVersion: id, proofId: id,
  metadataHash: hash, isolationPolicyVersion: z.literal(SUPERVISOR_PROOF_POLICY), available: z.literal(true), checkedAt: time,
}).strict().refine(value => { const profile = SUPERVISOR_ISOLATION_PROFILES[value.selection.provider]; return profile.cliVersion === value.cliVersion && profile.proofId === value.proofId; });
export type SupervisorCapability = z.infer<typeof supervisorCapabilitySchema>;
export type SupervisorCapabilityResult =
  | { kind: 'available'; capability: SupervisorCapability }
  | { kind: 'unavailable'; code: 'SUPERVISOR_UNSUPPORTED'; reason: SupervisorCapabilityUnavailableReason };
const finalityFields = { structuredDecisionCount: z.literal(1), executableReceipts: z.literal(0) };
export const supervisorFinalResultSchema = z.object({
  kind: z.literal('ok'), capability: supervisorCapabilitySchema, decision: supervisorDecisionSchema, selection: supervisorSelectionSchema, cliVersion: id,
  effectiveSelection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('verified'), selection: supervisorSelectionSchema }).strict(),
    z.object({ kind: z.literal('requested-only') }).strict(),
  ]), invocationId: id, settlement: z.object({ exitCode: z.literal(0), quiescent: z.literal(true) }).strict(),
  finality: z.discriminatedUnion('provider', [
    z.object({ ...finalityFields, provider: z.literal('claude-code'), event: z.literal('result/success'),
      isError: z.literal(false), terminalReason: z.literal('completed') }).strict(),
    z.object({ ...finalityFields, provider: z.literal('codex'), event: z.literal('turn.completed') }).strict(),
  ]),
}).strict();
export type SupervisorFinalResult = z.infer<typeof supervisorFinalResultSchema>;
export const supervisorFailureSchema = z.object({
  kind: z.enum(['cancelled', 'timeout', 'capacity', 'auth', 'unsupported', 'invalid-output', 'provider-error']),
  code: z.enum(['SUPERVISOR_CANCELLED', 'SUPERVISOR_TIMEOUT', 'SUPERVISOR_CAPACITY', 'SUPERVISOR_AUTH',
    'SUPERVISOR_UNSUPPORTED', 'SUPERVISOR_INVALID_OUTPUT', 'SUPERVISOR_PROVIDER_ERROR', 'SUPERVISOR_PROCESS_UNCERTAIN']),
  invocationId: id.nullable(), settlement: z.object({ quiescent: z.boolean(), exitCode: z.number().int().nullable() }).strict(),
  retryAfterMs: z.number().int().positive().max(7_776_000_000).optional(),
}).strict().refine(value => {
  const codes = { cancelled: 'SUPERVISOR_CANCELLED', timeout: 'SUPERVISOR_TIMEOUT', capacity: 'SUPERVISOR_CAPACITY',
    auth: 'SUPERVISOR_AUTH', unsupported: 'SUPERVISOR_UNSUPPORTED', 'invalid-output': 'SUPERVISOR_INVALID_OUTPUT',
    'provider-error': 'SUPERVISOR_PROVIDER_ERROR' };
  return (value.code === codes[value.kind] || (value.code === 'SUPERVISOR_PROCESS_UNCERTAIN' && !value.settlement.quiescent)) &&
    (value.retryAfterMs === undefined || (value.settlement.quiescent && (value.kind === 'capacity' || value.kind === 'provider-error')));
});
export type SupervisorFailure = z.infer<typeof supervisorFailureSchema>;
export type SupervisorFailureKind = SupervisorFailure['kind'];
export const supervisorResultSchema = z.union([supervisorFinalResultSchema, supervisorFailureSchema]);
export type SupervisorResult = z.infer<typeof supervisorResultSchema>;
const settlementObservationIdentity = {
  version: z.literal(1), userId: id, agentEnvironment: z.enum(['native', 'wsl']), invocationId: id, observedAt: time,
};
/** Recovery releases only an exact invocation's capacity. It never returns/replays model output. */
export const supervisorSettlementObservationSchema = z.discriminatedUnion('kind', [
  z.object({ ...settlementObservationIdentity, kind: z.literal('quiescent'), code: z.literal('SUPERVISOR_QUIESCENT'),
    proof: z.object({ kind: z.literal('owned-invocation-closed'), launchId: id, closedAt: time, settledAt: time }).strict(),
  }).strict(),
  z.object({ ...settlementObservationIdentity, kind: z.literal('unknown'), code: z.literal('SUPERVISOR_PROCESS_UNCERTAIN'),
    reason: z.enum(['missing', 'identity-mismatch', 'active', 'incomplete', 'unsupported']),
  }).strict(),
]).refine(value => value.kind !== 'quiescent' || (value.proof.closedAt <= value.proof.settledAt && value.proof.settledAt <= value.observedAt));
export type SupervisorSettlementObservation = z.infer<typeof supervisorSettlementObservationSchema>;
export function sameSupervisorCapability(a: SupervisorCapability, b: SupervisorCapability) {
  return sameSupervisorSelection(a.selection,b.selection) && a.cliVersion === b.cliVersion && a.proofId === b.proofId && a.isolationPolicyVersion === b.isolationPolicyVersion && a.metadataHash === b.metadataHash;
}
export function validateSupervisorFinalResult(value: unknown, context: DecisionValidationContext & { selection: SupervisorSelection; capability?: SupervisorCapability }) {
  const invalid = { success: false as const, code: 'SUPERVISOR_INVALID_OUTPUT' as const };
  const result = supervisorFinalResultSchema.safeParse(value);
  if (!result.success) return invalid;
  const final = result.data;
  if (final.finality.provider !== final.selection.provider || !sameSupervisorSelection(final.selection, context.selection) ||
      (final.effectiveSelection.kind === 'verified' && !sameSupervisorSelection(final.effectiveSelection.selection, context.selection)) ||
      !context.capability || !sameSupervisorCapability(final.capability,context.capability) || final.cliVersion !== final.capability.cliVersion || !sameSupervisorSelection(final.selection,final.capability.selection)) return invalid;
  return validateSupervisorDecision(final.decision, context).success ? { success: true as const, data: final } : invalid;
}

export const priorDecisionSummarySchema = z.object({
  decisionId: id, outcome: z.enum(['continue', 'complete', 'needs-user']), explanation: text(2048),
  progress: text(2048), madeProgress: z.boolean(),
}).strict();
export const supervisorPacketSchema = z.object({
  version: z.literal(1), objective: objectiveSchema, constraints: z.array(text(16_384)).max(100),
  criteria: criteriaSchema, criterionOrigin: z.enum(['verified-human', 'explicit', 'system-objective']),
  context: analysisContextSnapshotSchema, priorDecisions: z.array(priorDecisionSummarySchema).max(10),
}).strict().refine(value => bytes(value.objective.text + value.constraints.join('')) <= AUTORUN_BOUNDS.objectiveConstraintBytes &&
  bytes(JSON.stringify(value.priorDecisions)) <= AUTORUN_BOUNDS.priorDecisionBytes && bytes(JSON.stringify(value)) <= AUTORUN_BOUNDS.packetBytes);
export type SupervisorPacket = z.infer<typeof supervisorPacketSchema>;

export const providerTurnSubmissionSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('claude-code'), ...correlationBase, nativePromptId: id }).omit({ completionHookId: true }).strict(),
  z.object({ provider: z.literal('codex'), ...correlationBase, nativeTurnId: id }).omit({ completionHookId: true }).strict(),
]);
export type ProviderTurnSubmission = z.infer<typeof providerTurnSubmissionSchema>;
export const acceptedTurnIdentitySchema = analysisBoundarySchema.omit({ id: true, completedAt: true, source: true });
export const autorunReadinessSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed'), boundary: analysisBoundarySchema, fresh: z.literal(true),
    context: z.object({ contentHash: hash, coverage: contextCoverageSchema }).strict() }).strict(),
  z.object({ kind: z.literal('running'), acceptedTurn: acceptedTurnIdentitySchema, submission: providerTurnSubmissionSchema }).strict(),
  z.object({ kind: z.literal('idle'), reason: z.enum(['consumed-boundary', 'no-accepted-turn']) }).strict(),
  z.object({ kind: z.literal('unavailable'), code: z.enum(['CONTEXT_UNAVAILABLE', 'CONTEXT_INCOMPLETE', 'ANALYSIS_STALE', 'SUPERVISOR_UNSUPPORTED']),
    reason: z.enum(['missing', 'flush-pending', 'malformed', 'ambiguous-cutoff', 'unresolved-tools', 'binding-mismatch',
      'unsupported-version', 'instrumentation-required', 'scan-limit', 'record-limit', 'packet-limit', 'stale', 'unsafe-runtime', 'compacted-latest-turn']) }).strict(),
]);
export type AutorunReadiness = z.infer<typeof autorunReadinessSchema>;
export const autorunPreviewSchema = z.object({
  activation: automationActivationSchema.nullable().optional(),
  version: z.literal(1), previewId: id, sessionId: id, goalRevision: count, objective: objectiveSchema.nullable(),
  newHumanInstructions: z.array(humanInstructionSourceSchema).max(100), constraints: z.array(text(16_384)).max(100),
  criteria: criteriaSchema, criterionOrigin: z.enum(['verified-human', 'explicit', 'system-objective']),
  workerSelection: sessionSelectionSnapshotSchema, supervisorOptions: z.array(supervisorCapabilitySchema).max(1),
  supervisorDiscovery: supervisorDiscoverySchema,
  supervisorCheck: z.object({ selection: supervisorSelectionSchema.nullable(), status: z.enum(['unselected','available','unavailable']), reason: supervisorCapabilityUnavailableReasonSchema.nullable() }).strict(),
  recommendedSupervisor: supervisorSelectionSchema.nullable(), readiness: autorunReadinessSchema,
  defaults: z.object({ delayMs: z.number().int().min(30_000).max(86_400_000), maxDispatches: z.number().int().min(1).max(100),
    maxAnalyses: z.number().int().min(1).max(100), analysisTimeoutMs: z.number().int().min(30_000).max(300_000), expiresAt: time }).strict(),
  remaining: z.object({ dispatches: z.number().int().min(0).max(100), analyses: z.number().int().min(0).max(100) }).strict(),
}).strict().refine(value => {
  const check = value.supervisorCheck;
  if (check.status === 'available' ? (!check.selection || check.reason !== null || value.supervisorOptions.length !== 1 || !sameSupervisorSelection(value.supervisorOptions[0].selection,check.selection))
    : (value.supervisorOptions.length !== 0 || (check.status === 'unselected' ? check.selection !== null || check.reason !== null : !check.selection || check.reason === null))) return false;
  const readiness = value.readiness;
  if (readiness.kind === 'completed' && readiness.boundary.sessionId !== value.sessionId) return false;
  if (readiness.kind === 'running' && (readiness.acceptedTurn.sessionId !== value.sessionId ||
      readiness.submission.serverInstanceId !== readiness.acceptedTurn.serverInstanceId ||
      readiness.submission.terminalGeneration !== readiness.acceptedTurn.generation ||
      readiness.submission.provider !== value.workerSelection.provider)) return false;
  return (!value.objective || (value.objective.revision === value.goalRevision &&
      bytes(value.objective.text + value.constraints.join('')) <= AUTORUN_BOUNDS.objectiveConstraintBytes)) &&
    (!value.recommendedSupervisor || (value.recommendedSupervisor.serviceTier !== 'fast' &&
      value.supervisorOptions.some(option => sameSupervisorSelection(option.selection, value.recommendedSupervisor!))));
});
export type AutorunPreview = z.infer<typeof autorunPreviewSchema>;
export function getAutorunSetupDefaults(now: number): AutorunPreview['defaults'] {
  return { delayMs: 120_000, maxDispatches: 10, maxAnalyses: 20,
    analysisTimeoutMs: 120_000, expiresAt: now + 28_800_000 };
}
export const autorunPreviewInputSchema = z.object({
  includeSupervisorDiscovery: z.boolean().default(true),
  supervisor: supervisorSelectionSchema.optional(),
  objectiveOverride: text(16_384).optional(), constraints: z.array(text(16_384)).max(100).optional(),
  criteria: criteriaSchema.optional(),
}).strict().refine(value => bytes((value.objectiveOverride ?? '') + (value.constraints ?? []).join('')) <= AUTORUN_BOUNDS.objectiveConstraintBytes);

export const autorunPauseReasonSchema = z.enum([
  'OBJECTIVE_REQUIRED', 'CONTEXT_UNAVAILABLE', 'CONTEXT_INCOMPLETE', 'ANALYSIS_STALE', 'ANALYSIS_LIMIT',
  'SUPERVISOR_UNSUPPORTED', 'SUPERVISOR_CAPACITY', 'SUPERVISOR_TIMEOUT', 'SUPERVISOR_INVALID_OUTPUT',
  'SUPERVISOR_AUTH', 'SUPERVISOR_PROVIDER_ERROR', 'SUPERVISOR_PROCESS_UNCERTAIN', 'ANALYSIS_INTERRUPTED',
  'NATIVE_APPROVAL', 'INPUT_BOUNDARY_UNPROVEN', 'WORKER_IDENTITY_CHANGED', 'NO_PROGRESS', 'REPEATED_PROPOSAL',
]);
const attentionIdentity = { automationId: id, revision: z.number().int().min(1), sessionId: id };
const decisionAttentionSchema = z.object({ ...attentionIdentity, kind: z.literal('decision'), decisionId: id,
  outcome: z.enum(['complete', 'needs-user', 'paused', 'error']), reason: autorunPauseReasonSchema.nullable() }).strict();
const ruleAttentionSchema = z.object({ ...attentionIdentity, kind: z.literal('rule'), decisionId: z.null(),
  outcome: z.enum(['paused', 'error']), reason: autorunPauseReasonSchema }).strict();
export const automationAttentionSchema = z.discriminatedUnion('kind', [decisionAttentionSchema, ruleAttentionSchema]);
export type AutomationAttention = z.infer<typeof automationAttentionSchema>;
/** Owner-scoped invalidation only; text is fetched from authorized persisted detail. */
export const automationAttentionEventSchema = z.discriminatedUnion('kind', [
  decisionAttentionSchema.extend({ type: z.literal('automation_attention') }),
  ruleAttentionSchema.extend({ type: z.literal('automation_attention') }),
]);
export type AutomationAttentionEvent = z.infer<typeof automationAttentionEventSchema>;
export const automationAttentionSummarySchema = z.object({
  identity: automationAttentionSchema, summary: text(2048), createdAt: time,
}).strict();
export type AutomationAttentionSummary = z.infer<typeof automationAttentionSummarySchema>;

export const autorunDecisionSummarySchema = z.object({
  id, automationId: id, automationRevision: z.number().int().min(1), goalRevision: count, boundaryId: id,
  phase: z.enum(['reserved', 'analysing', 'decided', 'cancelled', 'failed', 'interrupted']),
  outcome: z.enum(['continue', 'complete', 'needs-user']).nullable(), reason: autorunPauseReasonSchema.nullable(),
  coverage: contextCoverageSchema, supervisorSelection: supervisorSelectionSchema, cliVersion: id,
  runId: id.nullable(), delivery: z.enum(['not-requested', 'pending', 'deferred', 'dispatching', 'delivered', 'skipped', 'failed', 'unknown', 'cancelled']),
  createdAt: time, finishedAt: time.nullable(), retryAt: time.nullable(), analysisAttempts: count,
}).strict();
export type AutorunDecisionSummary = z.infer<typeof autorunDecisionSummarySchema>;
export const autorunAnalysisAttemptSchema = z.object({
  ordinal: z.number().int().min(1).max(100), invocationId: id, startedAt: time, finishedAt: time.nullable(), deadlineAt: time,
  failureCode: autorunPauseReasonSchema.nullable(), retryAt: time.nullable(), quiescent: z.boolean().nullable(),
}).strict();
export const autorunDecisionDetailSchema = autorunDecisionSummarySchema.extend({
  packet: supervisorPacketSchema, packetHash: hash, decision: supervisorDecisionSchema.nullable(),
  effectiveSelection: supervisorFinalResultSchema.shape.effectiveSelection.nullable(),
  attempts: z.array(autorunAnalysisAttemptSchema).max(100), attention: automationAttentionSummarySchema.nullable(),
}).strict().refine(value => {
  if (value.boundaryId !== value.packet.context.boundary.id || value.goalRevision !== value.packet.objective.revision ||
      (value.effectiveSelection?.kind === 'verified' && !sameSupervisorSelection(value.effectiveSelection.selection, value.supervisorSelection)) ||
      (value.attention !== null && (value.attention.identity.kind !== 'decision' ||
        value.attention.identity.decisionId !== value.id || value.attention.identity.automationId !== value.automationId))) return false;
  if (value.decision === null) return value.phase !== 'decided' && value.outcome === null && value.runId === null && value.delivery === 'not-requested';
  return value.phase === 'decided' && value.outcome === value.decision.outcome &&
    (value.outcome === 'continue' ? value.runId !== null && value.delivery !== 'not-requested' : value.runId === null && value.delivery === 'not-requested') &&
    validateSupervisorDecision(value.decision, {
      criterionIds: value.packet.criteria.map(criterion => criterion.id), evidenceIds: value.packet.context.items.map(item => item.id),
    }).success;
});
export type AutorunDecisionDetail = z.infer<typeof autorunDecisionDetailSchema>;
export const autorunDecisionPageSchema = z.object({
  items: z.array(autorunDecisionSummarySchema).max(100), nextCursor: id.nullable(),
}).strict();
export type AutorunDecisionPage = z.infer<typeof autorunDecisionPageSchema>;
export const autorunDecisionQuerySchema = z.object({
  cursor: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const autorunAutomationSchema = autorunSchema.omit({ enabled: true, autorun: true }).extend({
  ...persisted, autorun: autorunConfigSchema, analysisCount: count, latestDecisionId: id.nullable(),
  autorunStatus: z.enum(['waiting', 'analysing', 'paused', 'complete', 'needs-user', 'error']),
  attention: automationAttentionSummarySchema.nullable(),
}).refine(value => value.attention === null || (value.attention.identity.automationId === value.id &&
  value.attention.identity.sessionId === value.target.sessionId && value.attention.identity.revision <= value.revision));
export const automationV2Schema = z.union([heartbeatDto, scheduleDto, autorunAutomationSchema]);
export type AutomationV2 = z.infer<typeof automationV2Schema>;
export type AutorunAutomation = z.infer<typeof autorunAutomationSchema>;
const legacyAutomationSchema = automationInputSchema.omit({ enabled: true }).extend(persisted);
export function decodeAutomation(value: unknown) {
  const legacy = legacyAutomationSchema.safeParse(value);
  if (legacy.success) return automationV2Schema.safeParse({ ...legacy.data, version: 2,
    mode: legacy.data.target.kind === 'wake-session' ? 'heartbeat' : 'schedule' });
  return automationV2Schema.safeParse(value);
}
/** Text-free list metadata. Existing v1 lists remain untouched until R2 installs its handlers. */
export const automationSummaryV2Schema = z.object({
  version: z.literal(2), id, name: base.name, revision: persisted.revision,
  mode: z.enum(['heartbeat', 'schedule', 'autorun']), state: persisted.state, pauseReason: persisted.pauseReason,
  sessionId: id.nullable(), worktreeId: id.nullable(), nextDueAt: time.nullable(),
  dispatchCount: count, analysisCount: count, latestDecisionId: id.nullable(),
  attention: automationAttentionSchema.nullable(),
}).strict();
export type AutomationSummaryV2 = z.infer<typeof automationSummaryV2Schema>;
export const automationPageV2Schema = z.object({ items: z.array(automationSummaryV2Schema).max(100), nextCursor: id.nullable() }).strict();
export type AutomationPageV2 = z.infer<typeof automationPageV2Schema>;
export type ControlResultV2 = { automation: AutomationV2; inputOwnership: InputOwnership | null; inFlightRunId: string | null };
export type ControlResponseV2 = { status: 200 | 202; body: ControlResultV2 };
/** A run still records host delivery only; null links legacy Heartbeat/Schedule runs. */
export type AutomationRunV2 = AutomationRun & { decisionId: string | null };

/** R1 authenticated hook bridge publishes this internally; it is never a renderer WS payload. */
const hookIdentity = { userId: id, agentEnvironment: z.enum(['native', 'wsl']), sessionId: id, terminalId: id, observedAt: time };
export const autorunHookEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ ...hookIdentity, kind: z.literal('submission'), evidence: providerTurnSubmissionSchema }).strict(),
  z.object({ ...hookIdentity, kind: z.literal('completion'), evidence: providerTurnCorrelationSchema }).strict(),
]);
export type AutorunHookEvidence = z.infer<typeof autorunHookEvidenceSchema>;
/** Runtime-owned accepted identity plus R1-observed native association, without claiming eligibility. */
export const autorunTurnEvidenceSchema = z.discriminatedUnion('kind', [
  autorunReadinessSchema.options[1],
  z.object({ kind: z.literal('completed'), boundary: analysisBoundarySchema, correlation: providerTurnCorrelationSchema }).strict(),
  z.object({ kind: z.literal('idle'), reason: z.literal('no-accepted-turn') }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['instrumentation-required', 'unsafe-runtime', 'binding-mismatch']) }).strict(),
]).refine(value => {
  if (value.kind === 'idle' || value.kind === 'unavailable') return true;
  const runtime = value.kind === 'running' ? value.acceptedTurn : value.boundary;
  const native = value.kind === 'running' ? value.submission : value.correlation;
  return runtime.serverInstanceId === native.serverInstanceId && runtime.generation === native.terminalGeneration;
});
export type AutorunTurnEvidence = z.infer<typeof autorunTurnEvidenceSchema>;
export const autorunGoalEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verified'), objective: objectiveSchema.options[1] }).strict(),
  z.object({ kind: z.literal('missing'), reason: z.enum(['no-human-instructions', 'unverified-human-origin', 'objective-limit']) }).strict(),
  z.object({ kind: z.literal('conflicting'), sources: z.array(humanInstructionSourceSchema).min(1).max(100) }).strict(),
]);
export type AutorunGoalEvidence = z.infer<typeof autorunGoalEvidenceSchema>;
export const autorunEvidenceResultSchema = z.union([
  z.object({ kind: z.literal('ok'), goal: autorunGoalEvidenceSchema, newHumanInstructions: z.array(humanInstructionSourceSchema).max(100),
    turnEvidence: autorunTurnEvidenceSchema }).strict(),
  z.object({ kind: z.literal('unavailable'), code: z.enum(['CONTEXT_UNAVAILABLE', 'CONTEXT_INCOMPLETE', 'ANALYSIS_STALE', 'SUPERVISOR_UNSUPPORTED']),
    reason: autorunReadinessSchema.options[3].shape.reason }).strict(),
]);
export type AutorunEvidenceResult = z.infer<typeof autorunEvidenceResultSchema>;
