import { prepareAutomationOrigin } from './autorun-origin';
import { createAutorunRuntime } from './autorun-runtime';
import { automationServiceTier } from './service-tier';
import type { AutorunProviderPort } from '../cli/providers/session-types';
import { getSession, extractSessionKind } from '@/lib/db/sessions';
import type { ProviderLaunchRequest, ProviderLaunchResult } from '@/lib/terminal/provider-launch-module';
import { AutomationInputError } from './input-error';
import { sameSessionSelection, type Target, type SessionSelectionSnapshot } from './contracts';
import { getAutomationAuthority } from './runtime-bridge';
import type { AutomationAuthority, AutomationRuntime, DispatchResult } from './runtime-port';
import type { TerminalManager } from '@/lib/terminal/terminal-manager';

function selectionForTarget(target: Target, saved: SessionSelectionSnapshot): SessionSelectionSnapshot {
  // Wake snapshots preserve inherited null choices; only Schedule requires explicit Default.
  return target.kind === 'create-session' && saved.provider === 'codex' && saved.serviceTier === null
    ? { ...saved, serviceTier: 'default' } : saved;
}

export function createAutomationRuntime(options: {
  manager: TerminalManager;
  autorunProvider?: (provider: string) => AutorunProviderPort | null;
  authority?: () => AutomationAuthority | null;
  createSession?: (sessionId: string, target: Extract<Target, { kind: 'create-session' }>) => void;
  publishCreated?: (userId: string, sessionId: string) => void;
  launch?: (request: ProviderLaunchRequest) => Promise<ProviderLaunchResult>;
  canResume?: (sessionId: string) => Promise<boolean>;
  verifySelection?: (userId: string, sessionId: string, selection: SessionSelectionSnapshot) => void;
  readSelection: (userId: string, sessionId: string) => Promise<SessionSelectionSnapshot>;
}): AutomationRuntime {
  const { manager } = options;
  const authority = options.authority ?? getAutomationAuthority;
  manager.automation.authority = authority;
  const resumedRuns = new Set<string>();
  const recoveries = new Map<string, Promise<import('./runtime-port').RecoveryResult>>();
  const attempts = new Map<string, Promise<DispatchResult>>();
  return {
    autorun: createAutorunRuntime({ ...options, provider: options.autorunProvider }),
    ownership: (userId, sessionId) => manager.automation.ownership(userId, sessionId),
    async arm(args, commit) {
      if (!authority()) throw new AutomationInputError('RUNTIME_ADAPTER_UNAVAILABLE', 'Automation authority is unavailable.');
      const selection = await options.readSelection(args.userId, args.sessionId);
      if (!sameSessionSelection(args.selection, selection)) throw new AutomationInputError('UNSUPPORTED_SELECTION', 'Saved launch selection changed.');
      manager.assertAutomationArmable(args.userId, args.sessionId);
      options.verifySelection?.(args.userId, args.sessionId, selection);
      return manager.automation.arm(args.userId, args.sessionId, args.automationId, selection.provider, commit);
    },
    drain: (args) => manager.automation.drain(args.userId, args.sessionId, args.automationId),
    releaseRecovery: (args, commit) => manager.automation.release(args.userId, args.sessionId, args.runId, commit),
    dispatch(args) {
      const prior = attempts.get(args.runId);
      if (prior) return prior;
      const pending = (async (): Promise<DispatchResult> => {
        const port = authority();
        if (!port) return { kind: 'failed', reason: 'RUNTIME_ADAPTER_UNAVAILABLE' };
        const spec = port.loadRun(args.runId);
        if (spec.target.kind === 'create-session') {
          if (!options.createSession || !options.launch) return { kind: 'failed', reason: 'RUNTIME_ADAPTER_UNAVAILABLE' };
          let started = false;
          let fenceRequested = false;
          let sessionId: string | null = null;
          let result: DispatchResult;
          let origin: Awaited<ReturnType<typeof prepareAutomationOrigin>> | undefined;
          try {
            const target = spec.target;
            sessionId = port.reserveSession(args.runId, id => options.createSession!(id, target));
            options.publishCreated?.(spec.ownerUserId, sessionId);
            const selection = selectionForTarget(spec.target, await options.readSelection(spec.ownerUserId, sessionId));
            if (!sameSessionSelection(selection, spec.run.effectiveSelection)) throw new Error('Selection changed.');
            const permit = port.beginAttempt(args.runId, args.leaseEpoch, args.expectedRevision);
            origin = await prepareAutomationOrigin({ userId: spec.ownerUserId, sessionId, agentEnvironment: spec.run.agentEnvironment, runId: args.runId, fresh: true });
            const launched = await options.launch({ mode: 'detached', sessionId, userId: spec.ownerUserId,
              initialPrompt: spec.prompt, allowPreparationFailure: false,
              expectedAgentEnvironment: spec.run.agentEnvironment, expectedSelection: spec.run.effectiveSelection,
              spawnFence: spawn => { fenceRequested = true; port.withWriteFence(permit, 'begin', () => { started = true; spawn(); origin!.submitted(); }); void origin!.flush().catch(() => {}); },
            });
            await origin.flush();
            if (!started || launched.attachedToExistingRuntime) throw new Error('Launch did not own a new process.');
            result = { kind: 'delivered', sessionId, terminalId: launched.terminalId, at: Date.now() };
          } catch {
            if (origin && !started) { try { await origin.cancelled(); } catch { /* Uncertain provenance is retained. */ } }
            result = started || fenceRequested ? { kind: 'unknown', reason: 'LAUNCH_UNKNOWN', sessionId }
              : { kind: 'failed', reason: 'LAUNCH_REJECTED' };
          }
          try { port.recordOutcome(args.runId, result); }
          catch { result = { kind: 'unknown', reason: 'OUTCOME_UNRECORDED', sessionId }; }
          if (result.kind === 'unknown' && sessionId) manager.automation.recover(spec.ownerUserId, sessionId, spec.run.automationId, args.runId);
          return result;
        }
        const { sessionId } = spec.target;
        const { ownerUserId } = spec;
        manager.automation.verifyEnvironment(ownerUserId, sessionId, spec.run.agentEnvironment);
        const saved = await options.readSelection(ownerUserId, sessionId);
        if (!sameSessionSelection(saved, spec.run.effectiveSelection)) {
          port.pauseWake(ownerUserId, sessionId, 'UNSUPPORTED_SELECTION');
          return { kind: 'failed', reason: 'UNSUPPORTED_SELECTION' };
        }
        try {
          if (manager.isAutomationInputBusy(ownerUserId, sessionId)) {
            return { kind: 'deferred', reason: 'RUNTIME_BUSY', retryAt: Date.now() + 30_000 };
          }
          manager.assertAutomationArmable(ownerUserId, sessionId);
          manager.automation.begin(ownerUserId, sessionId, spec.run.automationId, args.runId, args.expectedBoundary);
        } catch {
          return { kind: 'cancelled', reason: 'INPUT_BOUNDARY_UNPROVEN' };
        }
        let result: DispatchResult;
        try {
          const permit = port.beginAttempt(args.runId, args.leaseEpoch, args.expectedRevision);
          result = await manager.submitAutomationPrompt({ sessionId, userId: ownerUserId, prompt: spec.prompt,
            boundary: args.expectedBoundary!, authority: port, permit, agentEnvironment: spec.run.agentEnvironment,
            verifySelection: () => options.verifySelection?.(ownerUserId, sessionId, spec.run.effectiveSelection) });
        } catch { result = { kind: 'cancelled', reason: 'ATTEMPT_REJECTED' }; }
        try { port.recordOutcome(args.runId, result); }
        catch { result = { kind: 'unknown', reason: 'OUTCOME_UNRECORDED', sessionId }; }
        manager.automation.finish(ownerUserId, sessionId, result.kind === 'unknown');
        return result;
      })();
      attempts.set(args.runId, pending);
      void pending.then(result => {
        if (result.kind === 'deferred' && attempts.get(args.runId) === pending) attempts.delete(args.runId);
      }).catch(() => {});
      return pending;
    },
    reconcileRun(args) {
      const previous = recoveries.get(args.runId);
      if (previous) return previous;
      const pending = (async (): Promise<import('./runtime-port').RecoveryResult> => {
        const port = authority();
        if (!port) throw new AutomationInputError('RUNTIME_ADAPTER_UNAVAILABLE', 'Automation authority is unavailable.');
        const spec = port.loadRun(args.runId);
        const sessionId = spec.run.sessionId;
        if (!sessionId) return { kind: 'unavailable', reason: 'NO_RESERVED_SESSION', inputOwnership: manager.automation.ownership(spec.ownerUserId, '') };
        const { ownerUserId } = spec;
        const uncertain = spec.run.state === 'unknown' || spec.run.state === 'dispatching';
        if (uncertain) manager.automation.recover(ownerUserId, sessionId, spec.run.automationId, args.runId);
        manager.automation.verifyEnvironment(ownerUserId, sessionId, spec.run.agentEnvironment);
        const saved = selectionForTarget(spec.target, await options.readSelection(ownerUserId, sessionId));
        if (!sameSessionSelection(saved, spec.run.effectiveSelection)) return { kind: 'unknown', reason: 'UNSUPPORTED_SELECTION', inputOwnership: manager.automation.ownership(ownerUserId, sessionId) };
        const observation = manager.automation.observe(ownerUserId, sessionId);
        if (observation) return { kind: 'observed', observation, inputOwnership: manager.automation.ownership(ownerUserId, sessionId) };
        const unavailable = (reason: string) => ({ kind: 'unavailable' as const, reason, inputOwnership: manager.automation.ownership(ownerUserId, sessionId) });
        if (spec.target.kind === 'wake-session') return unavailable('WAKE_RUNTIME_UNAVAILABLE');
        // The provider-specific resume identity AND persisted ordinary recovery intent are required.
        if (resumedRuns.has(args.runId)) return { kind: 'unknown', reason: 'RECOVERY_UNCERTAIN', inputOwnership: manager.automation.ownership(ownerUserId, sessionId) };
        if (!options.launch || !options.canResume || !await options.canResume(sessionId)) return unavailable('RESUME_IDENTITY_UNAVAILABLE');
        let possibleSpawn = false;
        try {
          await options.launch({ mode: 'detached', sessionId, userId: ownerUserId,
            expectedAgentEnvironment: spec.run.agentEnvironment, expectedSelection: spec.run.effectiveSelection, allowPreparationFailure: false,
            spawnFence: spawn => port.withRecoveryFence({ ...args, sessionId },
              () => manager.getLaunchRuntimeState(`session-${sessionId}`, ownerUserId, sessionId) === 'opening',
              () => { resumedRuns.add(args.runId); possibleSpawn = true; spawn(); }),
          });
          const resumed = manager.automation.observe(ownerUserId, sessionId);
          if (resumed && possibleSpawn) return { kind: 'resumed', observation: resumed, inputOwnership: manager.automation.ownership(ownerUserId, sessionId) };
        } catch { /* No repeated resume: a possible process remains held for inspection. */ }
        return { kind: 'unknown', reason: 'RECOVERY_UNCERTAIN', inputOwnership: manager.automation.ownership(ownerUserId, sessionId) };
      })();
      recoveries.set(args.runId, pending);
      void pending.finally(() => { recoveries.delete(args.runId); }).catch(() => {});
      return pending;
    },
  };
}

/** Lazy dependencies keep importing the shared manager free of database reads. */
export async function readAutomationSessionSelection(_userId: string, sessionId: string): Promise<SessionSelectionSnapshot> {
  return readSavedSessionSelection(sessionId);
}

export function readSavedSessionSelection(sessionId: string): SessionSelectionSnapshot {
  const session = getSession(sessionId);
  if (!session || session.deleted || session.archived || extractSessionKind(session.provider_state) !== 'terminal'
    || (session.provider !== 'codex' && session.provider !== 'claude-code')) {
    throw new AutomationInputError('UNSUPPORTED_SELECTION', 'The Session is unavailable for automation.');
  }
  const serviceTier = automationServiceTier(session.provider, session.service_tier);
  if (serviceTier === undefined) {
    throw new AutomationInputError('UNSUPPORTED_SELECTION', 'Saved launch selection is unsupported.');
  }
  return { provider: session.provider, model: session.model, reasoningEffort: session.reasoning_effort,
    serviceTier,
    settings: { permissionPolicy: 'inherit-cli', allowPreparationFailure: false } };
}
