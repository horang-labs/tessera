import { automationNow, wakeInput } from './automation';

export function autorunInput() {
  const { prompt: _prompt, ...base } = wakeInput();
  void _prompt;
  return {
    ...base, version: 2 as const, mode: 'autorun' as const,
    target: { kind: 'wake-session' as const, sessionId: 'session-1' },
    trigger: { kind: 'turn-complete' as const, delayMs: 120_000 },
    autorun: {
      objective: { kind: 'explicit' as const, text: 'Fix login and verify the regression.' },
      constraints: ['Preserve the public API.'], criteria: [{ id: 'goal', text: 'Regression passes.' }],
      supervisor: { provider: 'codex' as const, model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' as const },
      maxAnalyses: 20, analysisTimeoutMs: 120_000,
    },
  };
}
export const autorunNow = automationNow;

export const boundary = {
  id: 'boundary-2', serverInstanceId: 'server-1', terminalId: 'terminal-1', generation: 1,
  sessionId: 'session-1', userId: 'owner-1', turnSequence: 2, inputRevision: 3,
  completedAt: automationNow, source: 'confirmed-lead-turn' as const,
};
export function contextSnapshot() {
  return {
    version: 1 as const, provider: 'codex' as const, cliVersion: '0.159.2', providerConversationId: 'conversation-1',
    userId: 'owner-1', agentEnvironment: 'wsl' as const, boundary, inputEpoch: 'epoch-1',
    workerSelection: { provider: 'codex' as const, model: null, reasoningEffort: null, serviceTier: null,
      settings: { permissionPolicy: 'inherit-cli' as const, allowPreparationFailure: false as const } },
    source: { identityHash: 'a'.repeat(64), fileGeneration: 'file-1', startByte: 0, endByte: 500, latestTurnStartByte: 0,
      scannedRanges: [{ startByte: 0, endByte: 500 }], bytesScanned: 500, maxRecordBytes: 500 },
    cutoff: { provider: 'codex' as const, turnId: 'turn-2', taskStartedRecordId: 'started-2',
      turnContextRecordId: 'context-2', terminalRecordId: 'complete-2', endByte: 500 },
    correlation: { provider: 'codex' as const, providerConversationId: 'conversation-1', nativeTurnId: 'turn-2',
      observerSubmissionId: 'submit-2', serverInstanceId: 'server-1', terminalGeneration: 1,
      sourceIdentityHash: 'a'.repeat(64), fileGeneration: 'file-1', startByte: 0,
      completionHookId: 'stop-2', dedupKey: 'stop-2' },
    coverage: { kind: 'full' as const, latestTurnComplete: true as const, omittedRanges: [],
      omittedBytes: 0, toolTruncation: false, compactionRecordIds: [] },
    items: [{ id: 'record-1', role: 'user' as const, origin: 'tessera-human-correlated' as const, text: 'Fix login.',
      startByte: 0, endByte: 100, omission: 'none' as const },
    { id: 'record-2', role: 'assistant' as const, origin: 'provider' as const, text: 'Regression passes.',
      startByte: 100, endByte: 400, omission: 'none' as const }],
    parserVersion: 'codex-0.159.2-v1', contentHash: 'b'.repeat(64), capturedAt: automationNow,
  };
}

export function autorunPreviewFixture() {
  return { version: 1, previewId: 'preview-1', sessionId: 'session-1', goalRevision: 1,
    objective: { kind: 'explicit', text: 'Fix login.', revision: 1 }, newHumanInstructions: [],
    criteria: [{ id: 'goal', text: 'Test passes.' }], criterionOrigin: 'system-objective', constraints: [],
    workerSelection: contextSnapshot().workerSelection,
    supervisorOptions: [{ version: 1, selection: autorunInput().autorun.supervisor, cliVersion: '0.159.2',
      proofId: 'codex-0.159.2-packet-catalog-v1', isolationPolicyVersion: 'autorun-530-v1', available: true, checkedAt: boundary.completedAt }],
    recommendedSupervisor: autorunInput().autorun.supervisor,
    defaults: { delayMs: 120000, maxDispatches: 10, maxAnalyses: 20, analysisTimeoutMs: 120000, expiresAt: boundary.completedAt + 28800000 },
    remaining: { dispatches: 10, analyses: 20 },
    readiness: { kind: 'completed', boundary, fresh: true, context: { contentHash: 'b'.repeat(64), coverage: contextSnapshot().coverage } },
  };
}

export function supervisorFinalFixture() {
  return {
    kind: 'ok', selection: autorunInput().autorun.supervisor, cliVersion: '0.159.2',
    effectiveSelection: { kind: 'requested-only' }, invocationId: 'invocation-1',
    settlement: { exitCode: 0, quiescent: true },
    finality: { provider: 'codex', event: 'turn.completed', structuredDecisionCount: 1, executableReceipts: 0 },
    decision: { outcome: 'complete', proposedPrompt: null, explanation: 'Test passes.', progress: 'Fix verified.',
      evidenceIds: ['record-2'], criterionResults: [{ criterionId: 'goal', status: 'met', evidenceIds: ['record-2'] }], madeProgress: true, blocker: null },
  };
}

export function hookSubmissionFixture() {
  const { completionHookId: _hook, ...evidence } = contextSnapshot().correlation;
  void _hook;
  return { kind: 'submission' as const, userId: 'owner-1', agentEnvironment: 'wsl' as const,
    sessionId: 'session-1', terminalId: 'terminal-1', observedAt: autorunNow, evidence };
}
export function firstRunningEvidenceFixture() {
  const acceptedTurn = { serverInstanceId: boundary.serverInstanceId, terminalId: boundary.terminalId,
    generation: boundary.generation, sessionId: boundary.sessionId, userId: boundary.userId,
    turnSequence: boundary.turnSequence, inputRevision: boundary.inputRevision };
  return { kind: 'ok' as const, goal: { kind: 'verified' as const,
    objective: { kind: 'verified-human' as const, text: 'Fix login.', revision: 1,
      sources: [{ messageId: 'message-1', recordId: 'record-1', textHash: 'd'.repeat(64), excerpt: 'Fix login.', origin: 'tessera-human-correlated' as const }] } },
    newHumanInstructions: [], turnEvidence: { kind: 'running' as const, acceptedTurn, submission: hookSubmissionFixture().evidence } };
}
