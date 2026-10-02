import { SettingsManager } from '@/lib/settings/manager';
import { resolveAgentHomeFilesystemPath, formatPathForAgentDisplay, resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import { createHash } from 'node:crypto';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import { execCli, isRunningInWsl } from '../cli-exec';
import { supervisorSettlementObservationSchema, type SupervisorSettlementObservation } from '@/lib/automation/autorun-contracts';
import type { SupervisorSettlementObservationRequest } from './session-types';
import { RECOVERY_LEDGER_SCRIPT, SupervisorProcessUncertain } from './autorun-recovery-ledger';

type RecoveryIdentity = SupervisorSettlementObservationRequest & { provider: 'codex' | 'claude-code'; deadlineAt: number };
export type SupervisorRecovery = { root: string; guestRoot: string; launchId: string; identity: RecoveryIdentity; deps: SettlementDependencies };
export type SupervisorAttempt = { root: string; guestRoot: string; launchId: string; attemptId: string };
function ledgerRoot(home: string, request: SupervisorSettlementObservationRequest) {
  const key = createHash('sha256').update(JSON.stringify([request.userId, request.agentEnvironment, request.invocationId])).digest('hex');
  return home + '/.tessera-supervisor-invocations/' + key;
}
async function ledgerOperation(operation: string, request: SupervisorSettlementObservationRequest & { provider: string; launchId?: string }, root: string, deps: SettlementDependencies) {
  const args = ['-e', RECOVERY_LEDGER_SCRIPT, operation, JSON.stringify(request), root];
  return operation === 'reserve' ? deps.execute(request, 'node', args) : deps.execute(request, 'flock', ['--no-fork', '-n', root + '/lock', 'node', ...args]);
}
export async function registerSupervisorInvocation(request: RecoveryIdentity, guestHome: string, deps = defaultSettlementDependencies): Promise<SupervisorRecovery> {
  const guestRoot = ledgerRoot(guestHome, request);
  const result = await ledgerOperation('reserve', request, guestRoot, deps);
  if (!result.ok) throw new SupervisorProcessUncertain();
  const manifest = JSON.parse(result.stdout);
  if (!manifest.launchId || manifest.invocationId !== request.invocationId) throw new Error('invalid reservation');
  return { root: await resolveAgentReportedPath(guestRoot, request.agentEnvironment), guestRoot, launchId: manifest.launchId, identity: request, deps };
}
export async function closeSupervisorInvocation(recovery: SupervisorRecovery): Promise<SupervisorSettlementObservation> {
  try {
    const result = await ledgerOperation('close', { ...recovery.identity, launchId: recovery.launchId }, recovery.guestRoot, recovery.deps);
    if (!result.ok) return unknownSettlement(recovery.identity, 'active');
    const parsed = supervisorSettlementObservationSchema.safeParse(JSON.parse(result.stdout));
    return parsed.success ? parsed.data : unknownSettlement(recovery.identity, 'incomplete');
  } catch { return unknownSettlement(recovery.identity, 'incomplete'); }
}
export async function createSupervisorAttempt(recovery: SupervisorRecovery): Promise<SupervisorAttempt> {
  const result = await ledgerOperation('attempt', { ...recovery.identity, launchId: recovery.launchId }, recovery.guestRoot, recovery.deps);
  if (!result.ok) throw new Error('owned launch admission unavailable');
  const state = JSON.parse(result.stdout);
  if (state.phase !== 'prelaunch' || state.launchId !== recovery.launchId || !/^[a-f0-9-]{36}$/.test(state.attemptId)) throw new Error('invalid attempt');
  return { root: recovery.root + '/attempts/' + state.attemptId, guestRoot: recovery.guestRoot + '/attempts/' + state.attemptId,
    launchId: state.launchId, attemptId: state.attemptId };
}

export type SettlementDependencies = {
  resolveGuestHome(request: SupervisorSettlementObservationRequest): Promise<string>;
  execute(request: SupervisorSettlementObservationRequest, command: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
};
export const defaultSettlementDependencies: SettlementDependencies = {
  async resolveGuestHome(request) {
    const settings = await SettingsManager.load(request.userId, { silent: true });
    if (!request.userId || settings.agentEnvironment !== request.agentEnvironment ||
        (request.agentEnvironment === 'native' && (getRuntimePlatform() !== 'linux' || isRunningInWsl()))) throw new Error('unsupported owner environment');
    const home = formatPathForAgentDisplay(await resolveAgentHomeFilesystemPath(request.agentEnvironment), request.agentEnvironment);
    const result = await execCli('node', ['-e', "process.stdout.write(require('fs').realpathSync(process.argv[1]))", home], request.agentEnvironment, 5000);
    if (!result.ok || !result.stdout.startsWith('/')) throw new Error('CLI home unavailable');
    return result.stdout.trim();
  },
  execute: (request, command, args) => execCli(command, args, request.agentEnvironment, 5000),
};
export function unknownSettlement(request: SupervisorSettlementObservationRequest, reason: Extract<SupervisorSettlementObservation, { kind: 'unknown' }>['reason']): SupervisorSettlementObservation {
  return { version: 1, userId: request.userId, agentEnvironment: request.agentEnvironment, invocationId: request.invocationId,
    observedAt: Date.now(), kind: 'unknown', code: 'SUPERVISOR_PROCESS_UNCERTAIN', reason };
}
export async function observeSupervisorSettlement(request: SupervisorSettlementObservationRequest, provider: 'codex' | 'claude-code',
  deps = defaultSettlementDependencies): Promise<SupervisorSettlementObservation> {
  try {
    const root = ledgerRoot(await deps.resolveGuestHome(request), request);
    // Missing ownership is unknown. flock must not create a missing invocation directory.
    const result = await ledgerOperation('observe', { ...request, provider }, root, deps);
    if (!result.ok) return unknownSettlement(request, result.stderr.includes('No such file') ? 'missing' : 'active');
    const parsed = supervisorSettlementObservationSchema.safeParse(JSON.parse(result.stdout));
    return parsed.success ? parsed.data : unknownSettlement(request, 'incomplete');
  } catch { return unknownSettlement(request, 'unsupported'); }
}
