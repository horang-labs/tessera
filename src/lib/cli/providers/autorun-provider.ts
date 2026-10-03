import { AUTORUN_SOURCE_IDENTITY } from '@/lib/terminal/autorun-observer';
import fs from 'node:fs/promises';
import { SettingsManager } from '@/lib/settings/manager';
import { getSession } from '@/lib/db/sessions';
import { getTerminalProviderSessionForTesseraSession } from '@/lib/db/terminal-provider-sessions';
import { readPersistedTerminalProviderSessionId } from '@/lib/terminal/provider-session-identity';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';
import { sameSessionSelection } from '@/lib/automation/contracts';
import { readAnalysisContext, readAutorunEvidence, type NativeContextSource } from '@/lib/automation/autorun-context';
import { readHumanSubmissions } from '@/lib/automation/autorun-human-evidence';
import { formatPathForAgentDisplay, resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import { execCli } from '../cli-exec';
import { resolveProviderCliCommand } from '../provider-command';
import { resolveClaudeTranscriptPath } from './claude-code/transcript-path';
import { resolveCodexTranscriptPath } from './codex/transcript-path';
import { checkSupervisorCapability, generateSupervisorDecision, generateSupervisorApprovalDecision, discoverSupervisorCandidates } from './autorun-supervisor';
import { observeSupervisorSettlement, type SettlementDependencies } from './autorun-settlement';
import type { AnalysisSnapshotRequest, AutorunEvidenceRequest, AutorunProviderPort } from './session-types';

type ReadRequest = AnalysisSnapshotRequest | AutorunEvidenceRequest;
async function verifyBinding(request: ReadRequest): Promise<boolean> {
  const settings = await SettingsManager.load(request.userId, { silent: true });
  const session = getSession(request.sessionId);
  const binding = getTerminalProviderSessionForTesseraSession(request.sessionId);
  const native = binding?.provider_session_id ?? (session && readPersistedTerminalProviderSessionId(session));
  if (!session || settings.agentEnvironment !== request.agentEnvironment || native !== request.providerConversationId || session.provider !== request.workerSelection.provider) return false;
  const selection = { provider: session.provider, model: session.model ?? null, reasoningEffort: session.reasoning_effort ?? null,
    serviceTier: session.service_tier ?? null, settings: request.workerSelection.settings };
  if (!sameSessionSelection(selection as typeof request.workerSelection, request.workerSelection)) return false;
  const ownership = terminalManager.automation.ownership(request.userId, request.sessionId);
  const observation = terminalManager.automation.observe(request.userId, request.sessionId);
  if (!observation || ownership.epoch !== request.inputEpoch) return false;
  const identity = 'expectedBoundary' in request ? request.expectedBoundary : request.turnEvidence.kind === 'running' ? request.turnEvidence.acceptedTurn
    : request.turnEvidence.kind === 'completed' ? request.turnEvidence.boundary : null;
  return Boolean(identity && identity.userId === request.userId && identity.sessionId === request.sessionId && identity.serverInstanceId === observation.serverInstanceId &&
    identity.generation === observation.generation && identity.terminalId === observation.terminalId);
}
async function resolveSource(request: ReadRequest): Promise<NativeContextSource | null> {
  const provider = request.workerSelection.provider;
  const binding = getTerminalProviderSessionForTesseraSession(request.sessionId);
  const resolver = provider === 'codex' ? resolveCodexTranscriptPath : resolveClaudeTranscriptPath;
  const resolved = await resolver({ providerSessionId: request.providerConversationId, transcriptPath: binding?.transcript_path, environment: request.agentEnvironment });
  if (!resolved) return null;
  // realpath/stat on the CLI side precede translation: UNC realpath cannot canonicalize Linux overlay symlinks.
  const script = AUTORUN_SOURCE_IDENTITY + "process.stdout.write(JSON.stringify(autorunSource(process.argv[1],false)))";
  const result = await execCli('node', ['-e', script, formatPathForAgentDisplay(resolved, request.agentEnvironment)], request.agentEnvironment, 5000);
  if (!result.ok) return null;
  const source = JSON.parse(result.stdout) as Omit<NativeContextSource, 'path' | 'cliVersion'>;
  const serverPath = await resolveAgentReportedPath(source.canonicalPath, request.agentEnvironment);
  const readable = await fs.open(serverPath, 'r'); await readable.close();
  const command = await resolveProviderCliCommand(provider, provider === 'codex' ? 'codex' : 'claude', request.agentEnvironment, request.userId);
  const version = await execCli(command, ['--version'], request.agentEnvironment, 5000);
  if (!version.ok) return null;
  return { ...source, path: serverPath, cliVersion: version.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown' };
}
/** Additive only: title, translation, worker spawn and transcript viewing keep their existing behavior. */
export function createAutorunProviderPort(provider: 'claude-code' | 'codex', settlementDeps?: SettlementDependencies): AutorunProviderPort {
  return { version: 1,
    discoverSupervisors: request => discoverSupervisorCandidates({...request,provider}),
    observeSupervisorSettlement: request => observeSupervisorSettlement(request, provider, settlementDeps),
    readAnalysisContext: request => request.workerSelection.provider === provider ? readAnalysisContext(request, { resolveSource, verifyBinding })
      : Promise.resolve({ kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'binding-mismatch' }),
    readAutorunEvidence: request => request.workerSelection.provider === provider ? readAutorunEvidence(request, { resolveSource, verifyBinding, readHumanSubmissions })
      : Promise.resolve({ kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'binding-mismatch' }),
    checkSupervisorCapability: request => request.selection.provider === provider ? checkSupervisorCapability(request)
      : Promise.resolve({ kind: 'unavailable', code: 'SUPERVISOR_UNSUPPORTED', reason: 'selection' }),
    generateSupervisorApprovalDecision: request => request.selection.provider === provider ? generateSupervisorApprovalDecision(request)
      : Promise.resolve({ kind: 'unavailable', reason: 'selection', invocationId: request.invocationId, settlement: { exitCode: null, quiescent: true } }),
    generateSupervisorDecision: request => request.selection.provider === provider ? generateSupervisorDecision(request)
      : Promise.resolve({ kind: 'unsupported', code: 'SUPERVISOR_UNSUPPORTED', invocationId: request.invocationId, settlement: { exitCode: null, quiescent: true } }),
  };
}
