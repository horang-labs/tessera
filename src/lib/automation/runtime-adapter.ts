import { getNativeAutomationInteraction } from './native-interaction';
import { nativeInteractionSchema } from './activation-contracts';
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
  now?: () => number;
  autorunProvider?: (provider: string) => AutorunProviderPort | null;
  authority?: () => AutomationAuthority | null;
  createSession?: (sessionId: string, target: Extract<Target, { kind: 'create-session' }>) => void;
  publishCreated?: (userId: string, sessionId: string) => void;
  launch?: (request: ProviderLaunchRequest) => Promise<ProviderLaunchResult>;
  startupCanResume?: (sessionId: string) => Promise<boolean>;
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
  const nativeControllers = new Map<string, Set<AbortController>>();
  function assertStartup(expected: import('./activation-state').StartupEvidence) {
    const state = manager.automation.readNativeState(expected.userId, expected.sessionId);
    const ownership = manager.automation.ownership(expected.userId, expected.sessionId);
    if (manager.automation.serverInstanceId !== expected.serverInstanceId || state?.live || state?.writer ||
      (state?.identity.generation ?? null) !== expected.generation || ownership.epoch !== expected.ownershipEpoch ||
      !['human', 'unavailable'].includes(ownership.mode) || manager.automation.hasDraft(expected.userId, expected.sessionId))
      throw new AutomationInputError('INPUT_BOUNDARY_UNPROVEN', 'Startup identity or draft changed.');
  }
  return {
    activation: {
      deferApproval(args) { getNativeAutomationInteraction(manager)?.deferApproval?.(args); },
      async prepareStartup(scope) {
        if (!options.launch) return null;
        const state = manager.automation.readNativeState(scope.userId, scope.sessionId);
        const expected = { ...scope, serverInstanceId: manager.automation.serverInstanceId,
          ownershipEpoch: manager.automation.ownership(scope.userId, scope.sessionId).epoch, generation: state?.identity.generation ?? null,
          mode: 'fresh' as 'fresh'|'resume' };
        try { assertStartup(expected); } catch { return null; }
        const resume = options.startupCanResume ? await options.startupCanResume(scope.sessionId)
          : await (await import('../terminal/shared-provider-launch-module')).providerLaunchModule.canResumeSession(scope.sessionId);
        expected.mode = resume ? 'resume' : 'fresh'; assertStartup(expected); return expected;
      },
      assertStartup,
      async observe(scope) {
        const port = getNativeAutomationInteraction(manager);
        if (!port) return { kind: 'unavailable', reason: 'native-interaction-adapter-missing' };
        if (manager.automation.hasDraft(scope.userId, scope.sessionId)) return { kind: 'unknown', reason: 'human-draft' };
        const parsed = nativeInteractionSchema.safeParse(await port.observe(scope));
        if (!parsed.success) return { kind: 'unknown', reason: 'native-interaction-invalid' };
        const observation = parsed.data;
        const identity = observation.kind === 'approval' ? observation.request.identity : 'identity' in observation ? observation.identity : null;
        if (identity) {
          try { manager.automation.assertNativeIdentity(identity); }
          catch { return { kind: 'unknown', reason: 'native-identity-changed' }; }
        }
        return observation;
      },
      assertCurrent(expected) {
        const port = getNativeAutomationInteraction(manager);
        if (!port) throw new AutomationInputError('RUNTIME_ADAPTER_UNAVAILABLE', 'Native interaction adapter is unavailable.');
        manager.automation.assertNativeIdentity(expected.identity);
        port.assertCurrent(expected);
      },
      setDraftVeto(scope, veto) { manager.automation.setDraftVeto(scope.userId, scope.sessionId, veto); },
    },
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
    drain: (args) => {
      for (const controller of nativeControllers.get(args.automationId) ?? []) controller.abort();
      const state = manager.automation.readNativeState(args.userId,args.sessionId);
      if (state) getNativeAutomationInteraction(manager)?.deferApproval?.({scope:{userId:args.userId,sessionId:args.sessionId,agentEnvironment:state.identity.agentEnvironment}});
      return manager.automation.drain(args.userId, args.sessionId, args.automationId);
    },
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
        if (spec.action?.kind === 'startup') {
          const expected = spec.action.expected, sessionId = spec.target.sessionId;
          let possibleSpawn = false;
          let origin: Awaited<ReturnType<typeof prepareAutomationOrigin>> | undefined;
          let result: DispatchResult;
          try {
            if (!options.launch) throw Error('Startup unavailable');
            assertStartup(expected);
            const saved = await options.readSelection(spec.ownerUserId, sessionId);
            if (!sameSessionSelection(saved, spec.run.effectiveSelection)) throw Error('Selection changed');
            if (expected.mode === 'fresh') origin = await prepareAutomationOrigin({ userId: spec.ownerUserId, sessionId,
              agentEnvironment: spec.run.agentEnvironment, runId: spec.run.id, fresh: true });
            assertStartup(expected);
            const permit = port.beginAttempt(args.runId, args.leaseEpoch, args.expectedRevision);
            const launched = await options.launch({ mode: 'detached', sessionId, userId: spec.ownerUserId,
              ...(expected.mode === 'fresh' ? {initialPrompt:spec.prompt} : {}), allowPreparationFailure: false,
              expectedAgentEnvironment: spec.run.agentEnvironment, expectedSelection: spec.run.effectiveSelection,
              spawnFence: spawn => {
                assertStartup(expected); options.verifySelection?.(spec.ownerUserId, sessionId, saved);
                port.withWriteFence(permit, 'begin', () => {
                  assertStartup(expected);
                  if (expected.mode === 'fresh') manager.automation.claimStartup(spec.ownerUserId,sessionId,spec.run.automationId,spec.run.id);
                  possibleSpawn = true; spawn(); origin?.submitted();
                });
              },
            });
            if (origin) await origin.flush();
            if (!possibleSpawn || launched.attachedToExistingRuntime) throw Error('Startup did not own a new worker');
            result = {kind:'delivered',sessionId,terminalId:launched.terminalId,at:(options.now ?? Date.now)()};
          } catch {
            if (origin && !possibleSpawn) await origin.cancelled().catch(() => {});
            result = possibleSpawn ? {kind:'unknown',reason:'STARTUP_UNKNOWN',sessionId} : {kind:'cancelled',reason:'STARTUP_REJECTED'};
          }
          try { port.recordOutcome(spec.run.id, result); }
          catch { result = {kind:'unknown',reason:'OUTCOME_UNRECORDED',sessionId}; }
          manager.automation.cancelStartup(spec.ownerUserId,sessionId,spec.run.id);
          if (result.kind === 'unknown') manager.automation.recover(spec.ownerUserId,sessionId,spec.run.automationId,spec.run.id);
          else if (possibleSpawn && expected.mode === 'fresh') manager.automation.finish(spec.ownerUserId,sessionId,false);
          return result;
        }
        if (spec.action) {
          const action = spec.action, expected = action.expected, identity = expected.identity, sessionId = spec.target.sessionId;
          const native = getNativeAutomationInteraction(manager);
          if (!native) return { kind: 'deferred', reason: 'NATIVE_INTERACTION_UNAVAILABLE', retryAt: Date.now() + 30_000 };
          const saved = await options.readSelection(spec.ownerUserId, spec.target.sessionId);
          if (!sameSessionSelection(saved, spec.run.effectiveSelection)) return { kind: 'failed', reason: 'UNSUPPORTED_SELECTION' };
          const controller = new AbortController();
          const controllers = nativeControllers.get(spec.run.automationId) ?? new Set<AbortController>();
          controllers.add(controller); nativeControllers.set(spec.run.automationId, controllers);
          const timer = setTimeout(() => controller.abort(), Math.max(1, spec.run.deadlineAt - (options.now ?? Date.now)())); timer.unref();
          let origin: Awaited<ReturnType<typeof prepareAutomationOrigin>> | undefined;
          let claimed = false, possibleWrite = false;
          let result: DispatchResult;
          try {
            native.assertCurrent(expected); manager.automation.assertNativeIdentity(identity);
            if (manager.automation.ownership(spec.ownerUserId,sessionId).epoch !== action.inputEpoch) throw Error('Draft epoch changed');
            if (action.kind === 'bootstrap') origin = await prepareAutomationOrigin({ userId: spec.ownerUserId,
              sessionId: spec.target.sessionId, agentEnvironment: spec.run.agentEnvironment, runId: spec.run.id,
              runtime: identity, fresh: identity.providerConversationId === null });
            native.assertCurrent(expected); manager.automation.assertNativeIdentity(identity);
            if (manager.automation.ownership(spec.ownerUserId,sessionId).epoch !== action.inputEpoch) throw Error('Draft epoch changed');
            manager.automation.claimNativeAction(identity, spec.run.automationId, spec.run.id); claimed = true;
            const permit = port.beginAttempt(args.runId, args.leaseEpoch, args.expectedRevision);
            const writeFence: import('./activation-contracts').NativeWriteFence = (phase, write) => {
              if (controller.signal.aborted) throw Error('Native action cancelled');
              native.assertCurrent(expected);
              manager.automation.verifyNativeAction(identity, spec.run.automationId, spec.run.id);
              options.verifySelection?.(spec.ownerUserId, sessionId, saved);
              possibleWrite = true;
              port.withWriteFence(permit, phase, () => {
                native.assertCurrent(expected);
                manager.automation.verifyNativeAction(identity, spec.run.automationId, spec.run.id);
                write(); if (phase === 'complete') origin?.submitted();
              });
            };
            const delivery = action.kind === 'bootstrap'
              ? native.submitPrompt({ expected: action.expected, prompt: spec.prompt, submissionId: spec.run.id, writeFence, signal: controller.signal })
              : native.respondApproval({ expected: action.expected, optionId: action.optionId, writeFence, signal: controller.signal });
            result = await Promise.race([delivery, new Promise<never>((_, reject) => {
              if (controller.signal.aborted) reject(Error('Native action cancelled'));
              else controller.signal.addEventListener('abort', () => reject(Error('Native acknowledgement cancelled')), { once: true });
            })]);
            if (origin) await origin.flush();
          } catch {
            result = possibleWrite ? { kind: 'unknown', reason: 'NATIVE_ACTION_UNKNOWN', sessionId: spec.target.sessionId }
              : { kind: 'cancelled', reason: 'NATIVE_ACTION_STALE' };
            if (origin && !possibleWrite) await origin.cancelled().catch(() => {});
          }
          try { port.recordOutcome(spec.run.id, result); }
          catch { result = { kind: 'unknown', reason: 'OUTCOME_UNRECORDED', sessionId }; }
          finally {
            clearTimeout(timer); controllers.delete(controller);
            if (!controllers.size) nativeControllers.delete(spec.run.automationId);
            if (claimed) manager.automation.finish(spec.ownerUserId, sessionId, result.kind === 'unknown');
          }
          return result;
        }
        const { sessionId } = spec.target;
        const { ownerUserId } = spec;
        const inputEpoch = spec.inputEpoch ?? manager.automation.ownership(ownerUserId,sessionId).epoch;
        manager.automation.verifyEnvironment(ownerUserId, sessionId, spec.run.agentEnvironment);
        const saved = await options.readSelection(ownerUserId, sessionId);
        if (!sameSessionSelection(saved, spec.run.effectiveSelection)) {
          port.pauseWake(ownerUserId, sessionId, 'UNSUPPORTED_SELECTION');
          return { kind: 'failed', reason: 'UNSUPPORTED_SELECTION' };
        }
        try {
          if (manager.automation.ownership(ownerUserId,sessionId).epoch !== inputEpoch) throw Error('Draft epoch changed');
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
