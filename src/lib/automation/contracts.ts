import { z } from 'zod';
import { normalizeSemanticPrompt } from '../terminal/session-control-input';

export type Provider = 'claude-code' | 'codex';
export type Trigger =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; anchorAt: number; everyMs: number }
  | { kind: 'turn-complete'; delayMs: number };

export type Selection = {
  provider: Provider;
  model: string;                    // explicit resolved model, no implicit default
  reasoningEffort: string;          // explicit supported value, not "auto"
  serviceTier: 'default' | 'fast' | null; // Codex requires value; Claude requires null
  settings: { permissionPolicy: 'inherit-cli'; allowPreparationFailure: false };
};
export type Target =
  | { kind: 'create-session'; worktreeId: string; title: string; selection: Selection }
  | { kind: 'wake-session'; sessionId: string };
export type AutomationInput = {
  name: string;
  enabled: boolean;
  target: Target;
  trigger: Trigger;
  prompt: string;
  limits: { maxDispatches: number; expiresAt: number };
};
export type AutomationState = 'enabled' | 'disabled' | 'paused' | 'exhausted' | 'expired' | 'deleted';
export type Automation = Omit<AutomationInput, 'enabled'> & {
  id: string; revision: number; state: AutomationState;
  pauseReason: string | null;
  ownerUserId: string; agentEnvironment: 'native' | 'wsl';
  savedSelection: SessionSelectionSnapshot;         // target selection or inspected Session selection
  nextDueAt: number | null;
  dispatchCount: number;             // includes unknown attempts; never reset on edit
  createdAt: number; updatedAt: number; deletedAt: number | null;
};
export type RunState = 'pending' | 'deferred' | 'dispatching' | 'delivered'
  | 'skipped' | 'failed' | 'unknown' | 'cancelled';
export type AutomationRun = {
  id: string; automationId: string; automationRevision: number;
  occurrenceKey: string; dueAt: number; deadlineAt: number;
  coalescedCount: number;            // omitted older due slots, zero for wake/once
  state: RunState; reason: string | null;
  sessionId: string | null; terminalId: string | null;
  boundaryId: string | null;
  attemptStartedAt: number | null; deliveredAt: number | null; finishedAt: number | null;
  effectiveSelection: SessionSelectionSnapshot;
  agentEnvironment: 'native' | 'wsl';
  observedRuntime: 'unobserved' | 'starting' | 'running' | 'input-required'
    | 'turn-complete' | 'exited' | 'unknown';
};

export type InputOwnership = {
  sessionId: string; terminalId: string | null;
  epoch: string; // opaque token, rotates on every ownership transition/runtime replacement
  mode: 'human' | 'armed' | 'draining' | 'recovery-required' | 'unavailable';
  automationId: string | null; runId: string | null; reason: string | null;
};
export type ControlResult = {
  automation: Automation;
  inputOwnership: InputOwnership | null; // null for create-session rule
  inFlightRunId: string | null;          // own dispatch, not the provider's whole turn
};

/** Exact persisted launch choices. Null means inherited, not a resolved live value. */
export type SessionSelectionSnapshot = {
  provider: Provider;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: 'default' | 'fast' | null;
  settings: Selection['settings'];
};


export function getAutomationDefaults(kind: Trigger['kind'], now: number) {
  return {
    ...(kind === 'turn-complete' ? { delayMs: 120_000 } : {}),
    limits: {
      maxDispatches: kind === 'once' ? 1 : kind === 'interval' ? 100 : 10,
      expiresAt: now + (kind === 'turn-complete' ? 28_800_000 : 2_592_000_000),
    },
  };
}

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z.string().trim().min(1).max(120);
const settingsSchema = z.object({
  permissionPolicy: z.literal('inherit-cli'), allowPreparationFailure: z.literal(false),
}).strict();
export const selectionSchema = z.object({
  provider: z.enum(['claude-code', 'codex']),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).refine(value => value !== 'auto'),
  serviceTier: z.enum(['default', 'fast']).nullable(),
  settings: settingsSchema,
}).strict().refine(value => value.provider === 'codex' ? value.serviceTier !== null : value.serviceTier === null);

export const automationInputSchema = z.object({
  name: label,
  enabled: z.boolean(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('wake-session'), sessionId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('create-session'), worktreeId: z.string().min(1), title: label, selection: selectionSchema }).strict(),
  ]),
  trigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('once'), at: timestamp }).strict(),
    z.object({ kind: z.literal('interval'), anchorAt: timestamp, everyMs: z.number().int().min(60_000).max(2_592_000_000) }).strict(),
    z.object({ kind: z.literal('turn-complete'), delayMs: z.number().int().min(30_000).max(86_400_000) }).strict(),
  ]),
  prompt: z.string().transform(normalizeSemanticPrompt).refine(value => value.trim().length > 0 && new TextEncoder().encode(value).length <= 32_768),
  limits: z.object({ maxDispatches: z.number().int().min(1).max(100), expiresAt: timestamp }).strict(),
}).strict();

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: 'INVALID_AUTOMATION' | 'UNSUPPORTED_SELECTION'; message: string }; issues: { path: string; message: string }[] };

/** The caller supplies current provider capability evidence; absence fails closed for new launches. */
export type AutomationValidationContext = {
  now: number;
  isSelectionSupported?: (selection: Selection) => boolean;
  /** Trusted persisted input, never supplied by the HTTP request. */
  previousInput?: AutomationInput;
};

export function validateAutomationInput(value: unknown, context: AutomationValidationContext): ValidationResult<AutomationInput> {
  const result = automationInputSchema.safeParse(value);
  if (!result.success) return {
    success: false, error: { code: 'INVALID_AUTOMATION', message: 'Invalid automation configuration.' },
    issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: 'Invalid value.' })),
  };
  const input = result.data;
  if ((input.target.kind === 'wake-session') !== (input.trigger.kind === 'turn-complete') ||
      input.limits.expiresAt <= context.now || input.limits.expiresAt > context.now + 7_776_000_000) {
    return { success: false, error: { code: 'INVALID_AUTOMATION', message: 'Invalid target, trigger or expiry.' }, issues: [] };
  }
  if (input.trigger.kind === 'once' &&
      (input.limits.maxDispatches !== 1 || input.trigger.at <= context.now || input.trigger.at >= input.limits.expiresAt)) {
    return { success: false, error: { code: 'INVALID_AUTOMATION', message: 'A one-time run requires one future occurrence before expiry.' }, issues: [] };
  }
  if (input.trigger.kind === 'interval') {
    const previous = context.previousInput?.trigger;
    const retainedAnchor = previous?.kind === 'interval' && previous.anchorAt === input.trigger.anchorAt;
    if ((!retainedAnchor && input.trigger.anchorAt <= context.now) || input.trigger.anchorAt >= input.limits.expiresAt) {
      return { success: false, error: { code: 'INVALID_AUTOMATION', message: 'A new interval anchor must be future and before expiry.' }, issues: [] };
    }
  }
  if (input.target.kind === 'create-session' && !context.isSelectionSupported?.(input.target.selection)) {
    return { success: false, error: { code: 'UNSUPPORTED_SELECTION', message: 'The saved launch selection is not supported.' }, issues: [] };
  }
  return { success: true, data: input };
}

/** Does not resolve inherited choices or claim knowledge of native TUI changes. */
export const sessionSelectionSnapshotSchema = z.object({
  provider: z.enum(['claude-code', 'codex']),
  model: z.string().min(1).nullable(),
  reasoningEffort: z.string().min(1).nullable(),
  serviceTier: z.enum(['default', 'fast']).nullable(),
  settings: settingsSchema,
}).strict().refine(value => value.provider !== 'claude-code' || value.serviceTier === null);

export function sameSessionSelection(a: SessionSelectionSnapshot, b: SessionSelectionSnapshot): boolean {
  return a.provider === b.provider && a.model === b.model &&
    a.reasoningEffort === b.reasoningEffort && a.serviceTier === b.serviceTier &&
    a.settings.permissionPolicy === b.settings.permissionPolicy &&
    a.settings.allowPreparationFailure === b.settings.allowPreparationFailure;
}

/** HTTP status is separate from the body; neither 200 nor 202 alone grants human input. */
export type ControlResponse = { status: 200 | 202; body: ControlResult };

export const AUTOMATION_ERROR_STATUS = {
  INVALID_AUTOMATION: 400,
  UNAUTHENTICATED: 401,
  OWNER_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ACTIVE_WAKE_EXISTS: 409,
  UNRESOLVED_RUN: 409,
  PAUSE_REQUIRED: 409,
  INPUT_BOUNDARY_UNPROVEN: 409,
  INPUT_OWNED_BY_AUTOMATION: 409,
  INPUT_OWNERSHIP_STALE: 409,
  UNSUPPORTED_SELECTION: 422,
  OWNER_UNAVAILABLE: 503,
  RUNTIME_ADAPTER_UNAVAILABLE: 503,
} as const;
export type AutomationErrorCode = keyof typeof AUTOMATION_ERROR_STATUS;
export type AutomationError = { error: { code: AutomationErrorCode; message: string } };
export type TerminalInputResult = {
  requestId: string; terminalId: string; surfaceId: string;
  outcome: 'accepted' | 'rejected' | 'unknown';
  code?: string;
  inputOwnership: InputOwnership;
};
