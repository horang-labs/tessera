import { z } from 'zod';
import type { DispatchResult } from './runtime-port';
import type { AutorunObjective, SupervisorCapability, SupervisorSelection } from './autorun-contracts';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative();
export const nativeRuntimeIdentitySchema = z.object({
  userId: id, sessionId: id, agentEnvironment: z.enum(['native', 'wsl']), serverInstanceId: id,
  terminalId: id, generation: count, provider: z.enum(['codex', 'claude-code']),
  providerConversationId: id.nullable(), inputRevision: count, observationRevision: count,
}).strict();
export type NativeRuntimeIdentity = z.infer<typeof nativeRuntimeIdentitySchema>;
export type NativeGateSnapshot = { identity: Omit<NativeRuntimeIdentity, 'observationRevision'>;
  state: 'starting' | 'running' | 'input-required' | 'turn-complete' | 'exited' | 'unknown'; live: boolean; writer: boolean;
  backgroundWork: 'clear' | 'active' | 'unknown'; hasDraft: boolean;
  ownershipMode: 'human' | 'armed' | 'draining' | 'recovery-required' | 'unavailable'; nativeApprovalId: string | null };

const requestBase = {
  requestId: id, nativeRequestId: id, identity: nativeRuntimeIdentitySchema,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  options: z.array(z.object({ id, effect: z.enum(['approve-once', 'deny', 'persistent-grant', 'other']) }).strict()).min(1).max(20)
    .refine(options => new Set(options.map(option => option.id)).size === options.length),
  context: z.object({ text: z.string().min(1).max(32_768), complete: z.boolean() }).strict(),
  deadlineAt: count,
};
export const nativeApprovalRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...requestBase, kind: z.literal('command'), operation: z.object({ command: z.string().min(1).max(16_384), cwd: id }).strict() }).strict(),
  z.object({ ...requestBase, kind: z.literal('file-change'), operation: z.object({ paths: z.array(id).min(1).max(100), changes: z.string().min(1).max(16_384) }).strict() }).strict(),
  z.object({ ...requestBase, kind: z.literal('permission'), operation: z.object({ toolName: id, input: z.record(z.unknown()) }).strict() }).strict(),
  z.object({ ...requestBase, kind: z.literal('plan'), operation: z.object({ text: z.string().min(1).max(16_384) }).strict() }).strict(),
]);
export type NativeApprovalRequest = z.infer<typeof nativeApprovalRequestSchema>;
export const nativeInteractionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), identity: nativeRuntimeIdentitySchema, proofVersion: id, empty: z.literal(true) }).strict(),
  z.object({ kind: z.literal('approval'), request: nativeApprovalRequestSchema }).strict(),
  z.object({ kind: z.literal('running'), identity: nativeRuntimeIdentitySchema }).strict(),
  z.object({ kind: z.literal('draft'), identity: nativeRuntimeIdentitySchema }).strict(),
  z.object({ kind: z.literal('starting'), identity: nativeRuntimeIdentitySchema }).strict(),
  z.object({ kind: z.literal('unknown'), reason: id }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: id }).strict(),
]);
export type NativeInteraction = z.infer<typeof nativeInteractionSchema>;
export type ReadyPromptEvidence = Extract<NativeInteraction, { kind: 'ready' }>;
export type InteractionScope = { userId: string; sessionId: string; agentEnvironment: 'native' | 'wsl' };
export type NativeWriteFence = (phase: 'begin' | 'complete', write: () => void) => void;
/** Bound by the terminal-owned helper. Observations are evidence, never authority. */
export interface NativeAutomationInteractionPort {
  observe(scope: InteractionScope): Promise<NativeInteraction>;
  /** Synchronous identity/state check immediately before each fenced native action. */
  assertCurrent(expected: ReadyPromptEvidence | NativeApprovalRequest): void;
  submitPrompt(args: { expected: ReadyPromptEvidence; prompt: string; submissionId: string;
    writeFence: NativeWriteFence; signal: AbortSignal }): Promise<DispatchResult>;
  respondApproval(args: { expected: NativeApprovalRequest; optionId: string;
    writeFence: NativeWriteFence; signal: AbortSignal }): Promise<DispatchResult>;
}
export const automationWaitReasonSchema = z.enum(['worker-running', 'runtime-starting', 'runtime-unavailable', 'runtime-unverified',
  'human-draft', 'child-work', 'supervisor-checking', 'supervisor-unavailable', 'approval-review',
  'approval-needs-user', 'interaction-unsupported', 'delivery-unresolved', 'context-unavailable']);
export type AutomationWaitReason = z.infer<typeof automationWaitReasonSchema>;
export const automationApprovalSummarySchema = z.object({ requestId: id,
  kind: z.enum(['command', 'file-change', 'permission', 'plan']), summary: z.string(),
  status: z.enum(['reviewing', 'approved-once', 'denied', 'needs-user']), explanation: z.string().nullable() }).strict();
export type AutomationApprovalSummary = z.infer<typeof automationApprovalSummarySchema>;
export const automationActivationSchema = z.object({ activationId: id.nullable(),
  phase: z.enum(['waiting', 'starting', 'analysing', 'dispatching', 'needs-user', 'complete']),
  reason: automationWaitReasonSchema.nullable(), approval: automationApprovalSummarySchema.nullable() }).strict();
export type AutomationActivation = z.infer<typeof automationActivationSchema>;
export const automationDraftVetoSchema = z.object({ surfaceId: id, revision: count, hasDraft: z.boolean() }).strict();
export type AutomationDraftVeto = z.infer<typeof automationDraftVetoSchema>;
export const supervisorApprovalDecisionSchema = z.object({
  kind: z.literal('approval'), requestId: id, requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['approve-once', 'deny', 'ask-user']), optionId: id.nullable(),
  explanation: z.string().min(1).max(2048), scopeReferences: z.array(id).min(1).max(100),
}).strict();
export type SupervisorApprovalDecision = z.infer<typeof supervisorApprovalDecisionSchema>;
export type SupervisorApprovalPacket = { version: 1; kind: 'approval'; objective: AutorunObjective;
  constraints: string[]; criteria: { id: string; text: string }[]; request: NativeApprovalRequest };
export const SUPERVISOR_APPROVAL_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'requestId', 'requestHash', 'outcome', 'optionId', 'explanation', 'scopeReferences'],
  properties: { kind: { type: 'string', const: 'approval' }, requestId: { type: 'string' }, requestHash: { type: 'string' },
    outcome: { type: 'string', enum: ['approve-once', 'deny', 'ask-user'] }, optionId: { type: ['string', 'null'] },
    explanation: { type: 'string', minLength: 1, maxLength: 2048 },
    scopeReferences: { type: 'array', minItems: 1, items: { type: 'string' } } },
} as const;
export type SupervisorApprovalRequest = InteractionScope & { selection: SupervisorSelection; capability: SupervisorCapability;
  invocationId: string; trustedInstructions: string; packet: SupervisorApprovalPacket;
  outputSchema: typeof SUPERVISOR_APPROVAL_JSON_SCHEMA; deadlineAt: number; signal: AbortSignal };
export type SupervisorApprovalResult =
  | { kind: 'ok'; decision: SupervisorApprovalDecision; selection: SupervisorSelection; capability: SupervisorCapability;
      cliVersion: string; invocationId: string; settlement: { exitCode: number | null; quiescent: boolean } }
  | { kind: 'unavailable'; reason: string; invocationId: string; settlement: { exitCode: number | null; quiescent: boolean } };
