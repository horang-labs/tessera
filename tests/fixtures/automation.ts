import type { Automation, AutomationInput, AutomationRun, InputOwnership, Selection, SessionSelectionSnapshot } from '../../src/lib/automation/contracts';
import type { AutomationAuthority, AutomationRuntime } from '../../src/lib/automation/runtime-port';

export const automationNow = 1_800_000_000_000;
export const explicitSelection: Selection = {
  provider: 'codex', model: 'test-model', reasoningEffort: 'high', serviceTier: 'default',
  settings: { permissionPolicy: 'inherit-cli', allowPreparationFailure: false },
};
export const inheritedSelection: SessionSelectionSnapshot = {
  ...explicitSelection, model: null, reasoningEffort: null, serviceTier: null,
};
export function wakeInput(): AutomationInput {
  return {
    name: 'Continue', enabled: false,
    target: { kind: 'wake-session', sessionId: 'session-1' },
    trigger: { kind: 'turn-complete', delayMs: 120_000 },
    prompt: 'Continue the task.\r\n',
    limits: { maxDispatches: 10, expiresAt: automationNow + 28_800_000 },
  };
}
export function onceInput(): AutomationInput {
  return {
    ...wakeInput(), target: { kind: 'create-session', worktreeId: 'wt-1', title: 'Scheduled', selection: explicitSelection },
    trigger: { kind: 'once', at: automationNow + 60_000 },
    limits: { maxDispatches: 1, expiresAt: automationNow + 2_592_000_000 },
  };
}
export function automationFixture(): Automation {
  const input = wakeInput();
  return {
    name: input.name, target: input.target, trigger: input.trigger, prompt: input.prompt, limits: input.limits,
    id: 'rule-1', revision: 1, state: 'disabled', pauseReason: null,
    ownerUserId: 'owner-1', agentEnvironment: 'wsl', savedSelection: inheritedSelection,
    nextDueAt: null, dispatchCount: 0, createdAt: automationNow, updatedAt: automationNow, deletedAt: null,
  };
}
export function runFixture(): AutomationRun {
  return {
    id: 'run-1', automationId: 'rule-1', automationRevision: 1,
    occurrenceKey: 'turn:server-1:1:1', dueAt: automationNow + 120_000, deadlineAt: automationNow + 28_800_000,
    coalescedCount: 0, state: 'pending', reason: null, sessionId: 'session-1', terminalId: 'terminal-1',
    boundaryId: 'boundary-1', attemptStartedAt: null, deliveredAt: null, finishedAt: null,
    effectiveSelection: inheritedSelection, agentEnvironment: 'wsl', observedRuntime: 'turn-complete',
  };
}
export function ownershipFixture(): InputOwnership {
  return { sessionId: 'session-1', terminalId: 'terminal-1', epoch: 'epoch-1', mode: 'armed', automationId: 'rule-1', runId: null, reason: null };
}

function unavailable(): never { throw new Error('Fixture port unavailable; supply the behavior under test.'); }
/** Full typed ports; an unconfigured fixture never pretends to deliver or grant input. */
export function runtimeFixture(overrides: Partial<AutomationRuntime> = {}): AutomationRuntime {
  return { reconcileRun: unavailable, ownership: unavailable, arm: unavailable, drain: unavailable, releaseRecovery: unavailable, dispatch: unavailable, ...overrides };
}
export function authorityFixture(overrides: Partial<AutomationAuthority> = {}): AutomationAuthority {
  return {
    loadRun: unavailable, reserveSession: unavailable, beginAttempt: unavailable,
    withWriteFence: unavailable, withRecoveryFence: unavailable, recordBoundary: unavailable,
    recordRuntimeObservation: unavailable, recordOutcome: unavailable, recordInputOwnership: unavailable,
    pauseWake: unavailable, ...overrides,
  };
}
